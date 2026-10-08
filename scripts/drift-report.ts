// Drift report per ticker and session: npm run drift:report -- --since 2026-10-09 [--until 2026-10-12]
import fs from "node:fs";
import path from "node:path";
import { DRIFT_DIR } from "../server/drift";
import { summarize } from "../server/driftStats";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const since = arg("since");
const until = arg("until");
const from = since ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) : Math.floor(Date.now() / 1000) - 72 * 3600;
const to = until ? Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000) : Math.floor(Date.now() / 1000);
const report = summarize(from, to);

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const f = (n: number | undefined) => (n === undefined ? "" : n.toFixed(1));
const pct = (n: number) => `${Math.round(n * 100)}%`;
console.log(`Drift ${iso(from)} to ${iso(to)} UTC. Off-hours, the reference is the last regular-session print.\n`);
console.log(["ticker", "session", "n", "peg med", "peg p90", "max +", "max -", ">50", ">100", ">200", "probes", "eff med", "eff p90"].map((h, i) => h.padEnd(i === 0 ? 12 : i === 1 ? 10 : 9)).join(""));
for (const r of report.rows)
  console.log(
    [r.ticker, r.session, r.samples, f(r.pegMedian), f(r.pegP90), f(r.maxPremium), f(r.maxDiscount), pct(r.over50), pct(r.over100), pct(r.over200), r.probes, f(r.effMedian), f(r.effP90)]
      .map((c, i) => String(c).padEnd(i === 0 ? 12 : i === 1 ? 10 : 9))
      .join(""),
  );
fs.mkdirSync(DRIFT_DIR, { recursive: true });
fs.writeFileSync(path.join(DRIFT_DIR, "report.json"), JSON.stringify(report, null, 1));
console.log(`\nAll values in bps vs the reference. Written to ${path.join(DRIFT_DIR, "report.json")}`);
