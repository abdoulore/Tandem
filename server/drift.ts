import fs from "node:fs";
import path from "node:path";
import { ASSETS, USDC, type AssetKind } from "../shared/assets";
import { uiFromRaw } from "../shared/math";
import { config } from "./config";
import { getQuote, routeLabel } from "./jupiter";
import type { PriceService } from "./prices";
import type { TokenState } from "./tokenState";

// Drift logger: how far each token trades from its real-world reference, by US session.
// One JSON line per asset per minute, plus a 100 USDC buy quote per asset every 5 minutes,
// appended to DATA_DIR/drift/YYYY-MM-DD.jsonl (UTC date). Never throws.

const SAMPLE_MS = 60_000;
const PROBE_MS = 5 * 60_000;
const PROBE_GAP_MS = 3_000;
const PROBE_USD = 100;
const WARN_EVERY_MS = 3_600_000;
const STALE_MARK_SEC = 3_600;

export const DRIFT_DIR = path.join(config.dataDir, "drift");
export type Session = "regular" | "extended" | "weekend" | "24/7";

export interface DriftSample {
  t: number;
  ticker: string;
  kind: AssetKind;
  session: Session;
  ref: number;
  refAgeSec: number;
  refSrc?: string;
  token?: number;
  tokenSrc?: string;
  dex?: number;
  pegBps?: number;
  dexPegBps?: number;
  open: boolean;
  mult: number;
  paused: boolean;
}

export interface DriftProbe {
  t: number;
  ticker: string;
  probe: "buy100";
  session: Session;
  eff: number;
  effBpsVsRef: number;
  route: string;
}

const bps = (a: number, b: number) => (a / b - 1) * 10_000;
const round = (n: number | undefined, d = 2) => (n === undefined ? undefined : Math.round(n * 10 ** d) / 10 ** d);

/** US equities: regular when the market is open, weekend on New York Saturday or Sunday, otherwise extended (holidays included). */
export function sessionOf(kind: AssetKind, open: boolean, t: number): Session {
  if (kind === "prestock") return "24/7";
  if (open) return "regular";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(t * 1000));
  return day === "Sat" || day === "Sun" ? "weekend" : "extended";
}

const lastWarn = new Map<string, number>();
function warnOnce(kind: string, msg: string) {
  const now = Date.now();
  if (now - (lastWarn.get(kind) ?? 0) < WARN_EVERY_MS) return;
  lastWarn.set(kind, now);
  console.warn(`drift: ${msg}`);
}

export let driftLastWriteAt = 0;

function append(line: object) {
  try {
    fs.mkdirSync(DRIFT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(DRIFT_DIR, `${day}.jsonl`), JSON.stringify(line) + "\n");
    driftLastWriteAt = Date.now();
  } catch (e) {
    warnOnce("write", `could not write: ${(e as Error).message}`);
  }
}

function sample(prices: PriceService) {
  const t = Math.floor(Date.now() / 1000);
  for (const a of ASSETS) {
    try {
      const q = prices.quote(a.ticker);
      if (!q.ref) continue; // no reference, nothing to measure against
      // A pre-IPO mark that stopped updating (e.g. SpaceX after it listed) is not a reference any more.
      if (a.kind === "prestock" && t - q.ref.publishTime > STALE_MARK_SEC) {
        warnOnce(`stale:${a.ticker}`, `${a.ticker} mark is ${Math.round((t - q.ref.publishTime) / 3600)}h old, not logging it`);
        continue;
      }
      if (a.kind === "xstock" && q.marketOpen === undefined) {
        warnOnce("hours", "market hours not known yet, skipping xStocks this round");
        continue;
      }
      const s: DriftSample = {
        t,
        ticker: a.ticker,
        kind: a.kind,
        session: sessionOf(a.kind, !!q.marketOpen, t),
        ref: q.ref.price,
        refAgeSec: Math.max(0, t - q.ref.publishTime),
        refSrc: q.sources?.ref,
        token: q.token?.price,
        tokenSrc: q.sources?.token,
        dex: q.dex,
        pegBps: round(q.pegBps),
        dexPegBps: q.dex ? round(bps(q.dex, q.ref.price)) : undefined,
        open: !!q.marketOpen,
        mult: q.multiplier ?? 1,
        paused: !!q.paused,
      };
      append(s);
    } catch (e) {
      warnOnce("sample", `sample failed for ${a.ticker}: ${(e as Error).message}`);
    }
  }
}

/** What a buyer actually pays: a 100 USDC ExactIn quote per asset, as USD per share (UI units). */
async function probe(prices: PriceService, tokens: TokenState) {
  for (const a of ASSETS) {
    const t = Math.floor(Date.now() / 1000);
    const q = prices.quote(a.ticker);
    if (!q.ref || (a.kind === "prestock" && t - q.ref.publishTime > STALE_MARK_SEC)) continue;
    try {
      const raw = await getQuote(USDC.mint, a.mint, BigInt(PROBE_USD * 10 ** USDC.decimals), 50, true);
      const outUi = uiFromRaw(raw.outAmount, a.decimals, tokens.multiplier(a.ticker));
      if (!(outUi > 0)) continue;
      const eff = PROBE_USD / outUi;
      const p: DriftProbe = {
        t,
        ticker: a.ticker,
        probe: "buy100",
        session: sessionOf(a.kind, !!q.marketOpen, t),
        eff: round(eff, 6)!,
        effBpsVsRef: round(bps(eff, q.ref.price))!,
        route: routeLabel(raw),
      };
      append(p);
    } catch (e) {
      const msg = (e as Error).message;
      if (/rate-limited|429/.test(msg)) {
        warnOnce("probe429", "Jupiter rate limit hit, skipping the rest of this probe round");
        return;
      }
      warnOnce(`probe:${a.ticker}`, `probe failed for ${a.ticker}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
  }
}

export function startDriftLogger(prices: PriceService, tokens: TokenState) {
  // Give prices, token state and market hours a moment to load before the first sample.
  setTimeout(() => {
    sample(prices);
    setInterval(() => sample(prices), SAMPLE_MS);
  }, 20_000);
  let probing = false;
  const runProbe = () => {
    if (probing) return;
    probing = true;
    probe(prices, tokens).finally(() => (probing = false));
  };
  setTimeout(() => {
    runProbe();
    setInterval(runProbe, PROBE_MS);
  }, 45_000);
}
