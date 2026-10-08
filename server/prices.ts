import fs from "node:fs";
import path from "node:path";
import { ASSETS, PYTH_FEED_IDS } from "../shared/assets";
import type { AssetQuote, Coverage, MarketSnapshot, PriceSource } from "../shared/types";
import { config } from "./config";
import type { TokenState } from "./tokenState";

export interface FeedPrice {
  price: number;
  conf: number;
  publishTime: number;
}

interface MarketHours {
  isOpen: boolean;
  nextOpen: number | null;
  nextClose: number | null;
}

/** [unix seconds, ref price, token price] sampled every HISTORY_STEP_S. */
type Sample = [number, number, number];

const HISTORY_STEP_S = 30;
const JUPITER_PRICE_EVERY_MS = 10_000;
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const HISTORY_KEEP_S = 3 * 86_400;
const PUBLIC_HERMES = "https://hermes.pyth.network";

const ALL_FEED_IDS = PYTH_FEED_IDS;
const XSTOCKS = ASSETS.filter((a) => a.kind === "xstock");
const PRESTOCKS = ASSETS.filter((a) => a.kind === "prestock");
const PRESTOCKS_API = "https://prestocks.com/api/prestocks";
type PreStocksRow = { contract_address: string; markPrice: number; tokenPrice: number; markValuation?: number; impliedValuation?: number };
const ALWAYS_OPEN = { isOpen: true, nextOpen: null, nextClose: null };

export class PriceService {
  source: "pyth" | "mixed" = "mixed";
  sourceNote = config.pythApiKey ? "Connecting to Pyth" : "No PYTH_API_KEY - xStocks priced by Backed via Jupiter (paper only)";
  updatedAt = 0;
  private feeds = new Map<string, FeedPrice>();
  private feedSource = new Map<string, PriceSource>();
  private entitled = new Set<string>();
  private denied = 0;
  private pythError?: string;
  private lastJupiterPoll = 0;
  private valuations = new Map<string, { mark: number; implied: number }>();
  private dex = new Map<string, FeedPrice>();
  private hours = new Map<string, MarketHours>();
  private history = new Map<string, Sample[]>();
  private historyFile = path.join(config.dataDir, "history.json");

  private preStocksFile = path.join(config.dataDir, "prestocks.json");

  constructor(private tokens: TokenState) {
    this.loadHistory();
    this.loadPreStocks();
  }

  start() {
    const tick = () => this.poll().finally(() => setTimeout(tick, config.pollMs));
    tick();
    // PreStocks rate-limits aggressive polling; back off 15s, 30s, then 60s after failures.
    let failures = 0;
    const pre = () =>
      this.pollPreStocks()
        .then(() => {
          failures = 0;
          setTimeout(pre, 20_000);
        })
        .catch((e) => {
          if (!String(e.message).includes("429")) console.warn("PreStocks poll failed:", e.message);
          setTimeout(pre, [15_000, 30_000, 60_000][Math.min(failures++, 2)]);
        });
    pre();
    this.pollMarketHours();
    setInterval(() => this.pollMarketHours(), 5 * 60_000);
    setInterval(() => this.sample(), HISTORY_STEP_S * 1000);
    setInterval(() => this.saveHistory(), 60_000);
    if (config.pythApiKey) {
      this.probeEntitlements().then(() => this.backfill().catch((e) => console.warn("backfill failed:", e.message)));
      setInterval(() => this.probeEntitlements(), 10 * 60_000);
    }
  }

  private pythHeaders(): Record<string, string> {
    return config.pythApiKey ? { Authorization: `Bearer ${config.pythApiKey}` } : {};
  }

  // Pyth API keys are scoped by feed grants (a key can read crypto but not US equities, say).
  // Probe each feed so we use Pyth wherever the key allows it.
  private async probeEntitlements() {
    const ok = new Set<string>();
    let denied = 0;
    for (const id of ALL_FEED_IDS) {
      try {
        const res = await fetch(`${config.pythHermesUrl}/v2/updates/price/latest?ids[]=${id}`, { headers: this.pythHeaders(), signal: AbortSignal.timeout(5_000) });
        if (res.ok) ok.add(id);
        else if (res.status === 403) denied++;
        else if (res.status === 401) {
          this.pythError = "Pyth rejected the API key (401)";
          break;
        }
      } catch {
        /* network blip: retried on the next probe */
      }
    }
    this.entitled = ok;
    this.denied = denied;
    console.log(`Pyth entitlements: ${ok.size}/${ALL_FEED_IDS.length} feeds readable${denied ? `, ${denied} not entitled (accept the feed grants in Pyth Terminal)` : ""}`);
  }

  private async poll() {
    let pythOk = false;
    if (this.entitled.size) {
      try {
        await this.pollPyth([...this.entitled]);
        this.pythError = undefined;
        pythOk = true;
      } catch (e) {
        this.pythError = (e as Error).message;
      }
    }
    const skip = pythOk ? this.entitled : new Set<string>();
    // Jupiter shares one rate limit with quotes: poll every 10s. It supplies DEX prices for every token
    // (execution quality is judged against them) and fills xStock feeds that Pyth doesn't cover.
    if (Date.now() - this.lastJupiterPoll >= JUPITER_PRICE_EVERY_MS) {
      this.lastJupiterPoll = Date.now();
      try {
        await this.pollJupiter(skip);
      } catch (e) {
        if (!pythOk) this.sourceNote = `All price sources failing: ${(e as Error).message}`;
      }
    }
    this.describeSource();
  }

  private describeSource() {
    const refsOnPyth = XSTOCKS.filter((a) => this.feedSource.get(a.feeds.ref) === "pyth").length;
    if (!config.pythApiKey) {
      this.source = "mixed";
      this.sourceNote = "No PYTH_API_KEY - xStocks priced by Backed via Jupiter (paper only)";
    } else if (this.pythError) {
      this.source = "mixed";
      this.sourceNote = `Pyth unavailable (${this.pythError}) - xStocks priced by Backed via Jupiter (paper only)`;
    } else if (refsOnPyth === XSTOCKS.length) {
      this.source = "pyth";
      this.sourceNote = "Pyth Hermes";
    } else {
      this.source = "mixed";
      this.sourceNote = this.denied > 0 ? "Live switches run on Pyth references; other xStocks run in paper mode." : "Connecting to Pyth";
    }
  }

  private async pollPyth(ids: string[]) {
    const qs = ids.map((id) => `ids[]=${id}`).join("&");
    const res = await fetch(`${config.pythHermesUrl}/v2/updates/price/latest?parsed=true&ignore_invalid_price_ids=true&${qs}`, {
      headers: this.pythHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
    const body = (await res.json()) as { parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
    for (const p of body.parsed) {
      const id = p.id.replace(/^0x/, "");
      const scale = 10 ** p.price.expo;
      this.feeds.set(id, { price: Number(p.price.price) * scale, conf: Number(p.price.conf) * scale, publishTime: p.price.publish_time });
      this.feedSource.set(id, "pyth");
    }
    this.updatedAt = Date.now();
  }

  // For feeds Pyth can't serve with this key: Jupiter's price API reports the xStock's market price
  // and the underlying share price published by Backed (the issuer). It lags by minutes, so it is
  // labeled as its own source and live execution refuses to run on it.
  private async pollJupiter(skip: Set<string>) {
    // Same host as the swap API: api.jup.ag with JUPITER_API_KEY, or the keyless lite-api.
    const res = await fetch(`${new URL(config.jupiterUrl).origin}/price/v3?ids=${ASSETS.map((a) => a.mint).join(",")}`, {
      headers: config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Jupiter price HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice: number; stockData?: { price: number; updatedAt: string } }>;
    const now = Math.floor(Date.now() / 1000);
    const put = (id: string, v: FeedPrice) => {
      if (skip.has(id)) return;
      this.feeds.set(id, v);
      this.feedSource.set(id, "jupiter");
    };
    for (const a of ASSETS) {
      const p = body[a.mint];
      if (p && valid(p.usdPrice)) this.dex.set(a.ticker, { price: p.usdPrice, conf: 0, publishTime: now });
    }
    for (const a of XSTOCKS) {
      const p = body[a.mint];
      if (!p) continue;
      put(a.feeds.token, { price: p.usdPrice, conf: 0, publishTime: now });
      if (p.stockData) put(a.feeds.ref, { price: p.stockData.price, conf: 0, publishTime: Math.floor(new Date(p.stockData.updatedAt).getTime() / 1000) });
      put(a.feeds.rate, { price: this.tokens.multiplier(a.ticker), conf: 0, publishTime: now });
    }
    this.updatedAt = Date.now();
  }

  // Pre-IPO references come from PreStocks: markPrice (private-market reference) and tokenPrice.
  private async pollPreStocks() {
    const res = await fetch(PRESTOCKS_API, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as PreStocksRow[];
    const now = Math.floor(Date.now() / 1000);
    this.applyPreStocks(list, now);
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.preStocksFile, JSON.stringify({ fetchedAt: now, list }));
    } catch {
      /* the snapshot only speeds up restarts */
    }
  }

  // Restore the last PreStocks prices at startup with their original timestamp, so the UI has data
  // immediately while the freshness check still refuses to trade on anything old.
  private loadPreStocks() {
    try {
      const snap = JSON.parse(fs.readFileSync(this.preStocksFile, "utf8")) as { fetchedAt: number; list: PreStocksRow[] };
      this.applyPreStocks(snap.list, snap.fetchedAt);
    } catch {
      /* no snapshot yet */
    }
  }

  private applyPreStocks(list: PreStocksRow[], now: number) {
    for (const a of PRESTOCKS) {
      const p = list.find((x) => x.contract_address === a.mint);
      if (p && valid(p.markValuation) && valid(p.impliedValuation)) this.valuations.set(a.ticker, { mark: p.markValuation, implied: p.impliedValuation });
      if (!p) continue;
      for (const [id, price] of [[a.feeds.ref, p.markPrice], [a.feeds.token, p.tokenPrice], [a.feeds.rate, this.tokens.multiplier(a.ticker)]] as const) {
        if (!valid(price)) continue; // the API occasionally omits a price
        this.feeds.set(id, { price, conf: 0, publishTime: now });
        this.feedSource.set(id, "prestocks");
      }
    }
  }

  /** Pyth feeds this key can read, out of all the feeds Tandem asks for. */
  pythEntitlement() {
    return { readable: this.entitled.size, total: ALL_FEED_IDS.length };
  }

  /** Where the token actually trades on Solana right now (Jupiter), if fresh. */
  dexPrice(ticker: string): number | undefined {
    const d = this.dex.get(ticker);
    return d && Date.now() / 1000 - d.publishTime < 120 ? d.price : undefined;
  }

  /** What one token costs to buy or sell right now: the DEX price, else the token feed, else the reference. */
  marketPrice(ticker: string): number | undefined {
    return this.dexPrice(ticker) ?? this.token(ticker)?.price ?? this.ref(ticker)?.price;
  }

  /** Where an asset's real-world reference price is coming from right now. */
  refSource(ticker: string): PriceSource | undefined {
    return this.feedSource.get(ASSETS.find((a) => a.ticker === ticker)!.feeds.ref);
  }

  /** Tickers grouped by the source of their reference price. */
  coverage(): Coverage {
    const out: Coverage = {};
    for (const a of ASSETS) {
      const src = this.feedSource.get(a.feeds.ref);
      if (src) (out[src] ??= []).push(a.ticker);
    }
    return out;
  }

  private async pollMarketHours() {
    for (const a of XSTOCKS) {
      try {
        const res = await fetch(`${PUBLIC_HERMES}/v2/price_feeds?query=${a.ticker}&asset_type=equity`, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) continue;
        const list = (await res.json()) as { id: string; market_hours?: { is_open: boolean; next_open: number | null; next_close: number | null } }[];
        const f = list.find((x) => x.id === a.feeds.ref);
        if (f?.market_hours) this.hours.set(a.ticker, { isOpen: f.market_hours.is_open, nextOpen: f.market_hours.next_open, nextClose: f.market_hours.next_close });
      } catch {
        /* keep the last known hours */
      }
    }
  }

  feed(id: string): FeedPrice | undefined {
    return this.feeds.get(id);
  }

  ref(ticker: string) {
    return this.feeds.get(ASSETS.find((a) => a.ticker === ticker)!.feeds.ref);
  }

  token(ticker: string) {
    return this.feeds.get(ASSETS.find((a) => a.ticker === ticker)!.feeds.token);
  }

  marketOpen(ticker: string): MarketHours | undefined {
    // Pre-IPO marks have no session; US equities share one schedule, so borrow any known entry.
    if (ASSETS.find((a) => a.ticker === ticker)?.kind === "prestock") return ALWAYS_OPEN;
    const h = this.hours.get(ticker) ?? this.hours.values().next().value;
    if (!h) return undefined;
    // Roll the cached schedule forward between refreshes.
    const now = Date.now() / 1000;
    if (h.isOpen && h.nextClose && now >= h.nextClose) return { ...h, isOpen: false };
    if (!h.isOpen && h.nextOpen && now >= h.nextOpen) return { ...h, isOpen: true };
    return h;
  }

  quote(ticker: string): AssetQuote {
    const a = ASSETS.find((x) => x.ticker === ticker)!;
    const ref = this.feeds.get(a.feeds.ref);
    const token = this.feeds.get(a.feeds.token);
    const rate = this.feeds.get(a.feeds.rate)?.price;
    const mint = this.tokens.get(ticker);
    const hours = this.marketOpen(ticker);
    const now = Date.now() / 1000;
    return {
      ticker,
      kind: a.kind,
      transferFeeBps: this.tokens.feeBps(ticker),
      valuation: this.valuations.get(ticker),
      dex: this.dexPrice(ticker),
      ref,
      token,
      rate,
      multiplier: this.tokens.multiplier(ticker),
      pendingMultiplier: mint && mint.effectiveAt > now ? { value: mint.newMultiplier, effectiveAt: mint.effectiveAt } : undefined,
      paused: mint?.paused,
      marketOpen: hours?.isOpen,
      nextOpen: hours?.nextOpen,
      nextClose: hours?.nextClose,
      pegBps: ref && token ? (token.price / ref.price - 1) * 10_000 : undefined,
      sources: {
        ref: this.feedSource.get(a.feeds.ref),
        token: this.feedSource.get(a.feeds.token),
        rate: this.feedSource.get(a.feeds.rate),
      },
    };
  }

  snapshot(): MarketSnapshot {
    return {
      source: this.source,
      sourceNote: this.sourceNote,
      coverage: this.coverage(),
      updatedAt: this.updatedAt,
      assets: ASSETS.map((a) => this.quote(a.ticker)),
    };
  }

  // ---- history -------------------------------------------------------------

  private sample() {
    const t = Math.floor(Date.now() / 1000);
    for (const a of ASSETS) {
      const ref = this.feeds.get(a.feeds.ref);
      const token = this.feeds.get(a.feeds.token);
      if (!ref || !token || !valid(ref.price) || !valid(token.price)) continue;
      const arr = this.history.get(a.ticker) ?? [];
      arr.push([t, ref.price, token.price]);
      while (arr.length && arr[0][0] < t - HISTORY_KEEP_S) arr.shift();
      this.history.set(a.ticker, arr);
    }
  }

  /** Pair ratio series (target price in source shares) from reference prices. */
  ratioSeries(from: string, to: string, sinceSec = 0): { t: number; r: number; rt: number }[] {
    const f = this.history.get(from) ?? [];
    const g = new Map((this.history.get(to) ?? []).map((s) => [s[0], s]));
    const out: { t: number; r: number; rt: number }[] = [];
    for (const s of f) {
      if (s[0] < sinceSec) continue;
      const o = g.get(s[0]);
      if (o) out.push({ t: s[0], r: o[1] / s[1], rt: o[2] / s[2] });
    }
    return out;
  }

  private loadHistory() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile, "utf8")) as Record<string, Sample[]>;
      for (const [k, v] of Object.entries(raw)) this.history.set(k, v.filter((x) => valid(x[1]) && valid(x[2])));
    } catch {
      /* no history yet */
    }
  }

  private saveHistory() {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.historyFile, JSON.stringify(Object.fromEntries(this.history)));
    } catch (e) {
      console.warn("history save failed:", (e as Error).message);
    }
  }

  // Seed the chart with Pyth prices from recent US sessions (every 30 min, 13:30-20:00 UTC).
  private async backfill() {
    const have = this.history.get("SPY")?.length ?? 0;
    if (have > 200) return;
    const now = Math.floor(Date.now() / 1000);
    const times: number[] = [];
    for (let t = now - HISTORY_KEEP_S; t < now - 600; t += 1800) {
      const d = new Date(t * 1000);
      const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && mins >= 13 * 60 + 30 && mins <= 20 * 60) times.push(t - (t % 1800));
    }
    if (!XSTOCKS.some((a) => this.entitled.has(a.feeds.ref))) return;
    const ids = XSTOCKS.flatMap((a) => [a.feeds.ref, a.feeds.token]).filter((id) => this.entitled.has(id));
    const qs = ids.map((id) => `ids[]=${id}`).join("&");
    let added = 0;
    for (const t of times) {
      try {
        const res = await fetch(`${config.pythHermesUrl}/v2/updates/price/${t}?parsed=true&ignore_invalid_price_ids=true&${qs}`, {
          headers: this.pythHeaders(),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { parsed: { id: string; price: { price: string; expo: number } }[] };
        const px = new Map(body.parsed.map((p) => [p.id.replace(/^0x/, ""), Number(p.price.price) * 10 ** p.price.expo]));
        for (const a of XSTOCKS) {
          const r = px.get(a.feeds.ref);
          const k = px.get(a.feeds.token);
          if (!r) continue;
          const arr = this.history.get(a.ticker) ?? [];
          arr.push([t, r, k ?? r]);
          this.history.set(a.ticker, arr);
        }
        added++;
      } catch {
        /* skip this point */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const arr of this.history.values()) arr.sort((x, y) => x[0] - y[0]);
    console.log(`backfilled ${added}/${times.length} Pyth history points`);
  }
}
