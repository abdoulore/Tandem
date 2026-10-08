import fs from "node:fs";
import path from "node:path";
import type { Session } from "../shared/fair";
import { DRIFT_DIR, type DriftProbe, type DriftSample } from "./drift";

// Summary statistics over the drift log, shared by `npm run drift:report` and GET /api/drift/summary.

export interface DriftRow {
  ticker: string;
  session: Session;
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
  const groups = new Map<string, { ticker: string; session: Session; peg: number[]; eff: number[]; n: number }>();
  const group = (ticker: string, session: Session) => {
    const k = `${ticker}|${session}`;
    if (!groups.has(k)) groups.set(k, { ticker, session, peg: [], eff: [], n: 0 });
    return groups.get(k)!;
  };
  for (const s of samples) {
    if (s.t > to) continue;
    const g = group(s.ticker, s.session);
    g.n++;
    if (typeof s.pegBps === "number") g.peg.push(s.pegBps);
  }
  for (const p of probes) if (p.t <= to && Number.isFinite(p.effBpsVsRef)) group(p.ticker, p.session).eff.push(p.effBpsVsRef);
  const rows: DriftRow[] = [...groups.values()].map((g) => {
    const peg = [...g.peg].sort((a, b) => a - b);
    const eff = [...g.eff].sort((a, b) => a - b);
    return {
      ticker: g.ticker,
      session: g.session,
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
