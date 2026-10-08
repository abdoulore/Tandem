import fs from "node:fs";
import path from "node:path";
import type { Session } from "../shared/fair";
import { DRIFT_DIR, type DriftProbe, type DriftSample } from "./drift";

// Summary statistics over the drift log, shared by `npm run drift:report` and GET /api/drift/summary.

export interface DriftRow {
  ticker: string;
  session: Session;
  /** Most common reference source in the window: "pyth", "jupiter" (Backed, minutes old) or "prestocks". */
  refSrc?: string;
  /** Median age of the reference, seconds. */
  refAgeMedian?: number;
  samples: number;
  pegMedian?: number;
  pegP90?: number;
  maxPremium?: number;
  maxDiscount?: number;
  /** Share of samples with |pegBps| above 50, 100 and 200 bps. */
  over50: number;
  over100: number;
  over200: number;
  probes: number;
  effMedian?: number;
  effP90?: number;
}

export interface DriftSummary {
  from: number;
  to: number;
  rows: DriftRow[];
}

function quantile(sorted: number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const r2 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);
const share = (xs: number[], limit: number) => (xs.length ? r2(xs.filter((x) => Math.abs(x) > limit).length / xs.length)! : 0);

/** Reads every log line with t >= from (unix seconds). Bad lines are skipped. */
export function readDrift(from: number): { samples: DriftSample[]; probes: DriftProbe[] } {
  const samples: DriftSample[] = [];
  const probes: DriftProbe[] = [];
  if (!fs.existsSync(DRIFT_DIR)) return { samples, probes };
  const firstDay = new Date(from * 1000).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(DRIFT_DIR).filter((f) => f.endsWith(".jsonl") && f.slice(0, 10) >= firstDay).sort()) {
    for (const line of fs.readFileSync(path.join(DRIFT_DIR, f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.t < from) continue;
        if (o.probe) probes.push(o);
        else samples.push(o);
      } catch {
        /* a half-written line from a crash */
      }
    }
  }
  return { samples, probes };
}

export function summarize(from: number, to = Math.floor(Date.now() / 1000)): DriftSummary {
  const { samples, probes } = readDrift(from);
  const groups = new Map<string, { ticker: string; session: Session; peg: number[]; eff: number[]; ages: number[]; srcs: Map<string, number>; n: number }>();
  const group = (ticker: string, session: Session) => {
    const k = `${ticker}|${session}`;
    if (!groups.has(k)) groups.set(k, { ticker, session, peg: [], eff: [], ages: [], srcs: new Map(), n: 0 });
    return groups.get(k)!;
  };
  for (const s of samples) {
    if (s.t > to) continue;
    const g = group(s.ticker, s.session);
    g.n++;
    if (typeof s.pegBps === "number") g.peg.push(s.pegBps);
    g.ages.push(s.refAgeSec);
    if (s.refSrc) g.srcs.set(s.refSrc, (g.srcs.get(s.refSrc) ?? 0) + 1);
  }
  for (const p of probes) if (p.t <= to && Number.isFinite(p.effBpsVsRef)) group(p.ticker, p.session).eff.push(p.effBpsVsRef);
  const rows: DriftRow[] = [...groups.values()].map((g) => {
    const peg = [...g.peg].sort((a, b) => a - b);
    const eff = [...g.eff].sort((a, b) => a - b);
    const ages = [...g.ages].sort((a, b) => a - b);
    return {
      ticker: g.ticker,
      session: g.session,
      refSrc: [...g.srcs].sort((a, b) => b[1] - a[1])[0]?.[0],
      refAgeMedian: quantile(ages, 0.5),
      samples: g.n,
      pegMedian: r2(quantile(peg, 0.5)),
      pegP90: r2(quantile(peg, 0.9)),
      maxPremium: r2(peg.length ? Math.max(...peg) : undefined),
      maxDiscount: r2(peg.length ? Math.min(...peg) : undefined),
      over50: share(peg, 50),
      over100: share(peg, 100),
      over200: share(peg, 200),
      probes: eff.length,
      effMedian: r2(quantile(eff, 0.5)),
      effP90: r2(quantile(eff, 0.9)),
    };
  });
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.session.localeCompare(b.session));
  return { from, to, rows };
}

export interface SeriesPoint {
  /** Bucket start, unix seconds. */
  t: number;
  session: Session;
  /** Median premium of the token vs its reference in the bucket, bps. */
  peg?: number;
  /** Median premium a $100 buy actually paid in the bucket, bps. */
  eff?: number;
}

/** Bucketed premium history per ticker (all tickers when none is given), for charts and sparklines. */
export function series(from: number, bucketSec: number, ticker?: string): Record<string, SeriesPoint[]> {
  const { samples, probes } = readDrift(from);
  const buckets = new Map<string, { t: number; ticker: string; session: Session; peg: number[]; eff: number[] }>();
  const at = (tk: string, t: number, session: Session) => {
    const b = Math.floor(t / bucketSec) * bucketSec;
    const k = `${tk}|${b}`;
    if (!buckets.has(k)) buckets.set(k, { t: b, ticker: tk, session, peg: [], eff: [] });
    return buckets.get(k)!;
  };
  for (const s of samples) if ((!ticker || s.ticker === ticker) && typeof s.pegBps === "number") at(s.ticker, s.t, s.session).peg.push(s.pegBps);
  for (const p of probes) if ((!ticker || p.ticker === ticker) && Number.isFinite(p.effBpsVsRef)) at(p.ticker, p.t, p.session).eff.push(p.effBpsVsRef);
  const out: Record<string, SeriesPoint[]> = {};
  for (const b of [...buckets.values()].sort((x, y) => x.t - y.t)) {
    const med = (xs: number[]) => r2(quantile([...xs].sort((a, c) => a - c), 0.5));
    (out[b.ticker] ??= []).push({ t: b.t, session: b.session, peg: med(b.peg), eff: med(b.eff) });
  }
  return out;
}
