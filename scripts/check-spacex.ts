// SpaceX listed on Nasdaq as SPCX. Compare the PreStocks SPACEX mark and token price with the listed stock,
// to decide which reference Tandem should use (D5). Saves the output to docs/checks/spacex-YYYYMMDD.txt.
// npx tsx scripts/check-spacex.ts
import fs from "node:fs";
import path from "node:path";
import { getAsset } from "../shared/assets";
import { config } from "../server/config";
import { conn } from "../server/solana";
import { TokenState } from "../server/tokenState";

const SPCX_FEED = "8a593d6edde7a3095213c88116d8840d01e93c2ddeb800bc891772eb8b93bb94"; // Equity.US.SPCX/USD
const out: string[] = [];
const say = (s: string) => {
  console.log(s);
  out.push(s);
};

async function pyth(): Promise<{ price: number; publishTime: number; via: string } | null> {
  const tries: [string, Record<string, string>][] = [
    [config.pythHermesUrl, config.pythApiKey ? { authorization: `Bearer ${config.pythApiKey}` } : {}],
    ["https://hermes.pyth.network", {}],
  ];
  for (const [base, headers] of tries) {
    try {
      const res = await fetch(`${base}/v2/updates/price/latest?ids[]=${SPCX_FEED}&parsed=true`, { headers, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        say(`  Pyth via ${base}: HTTP ${res.status}`);
        continue;
      }
      const p = (await res.json()).parsed?.[0]?.price;
      if (p) return { price: Number(p.price) * 10 ** p.expo, publishTime: p.publish_time, via: base };
    } catch (e) {
      say(`  Pyth via ${base}: ${(e as Error).message}`);
    }
  }
  return null;
}

(async () => {
  const a = getAsset("SPACEX");
  const now = Math.floor(Date.now() / 1000);
  const age = (t: number) => `${((now - t) / 3600).toFixed(1)}h old`;
  say(`SpaceX reference check, ${new Date().toISOString()}`);
  say(`Mint ${a.mint}`);

  const list = (await (await fetch("https://prestocks.com/api/prestocks")).json()) as Record<string, unknown>[];
  const row = list.find((r) => r.contract_address === a.mint) as { markPrice?: number; tokenPrice?: number; updatedAt?: string } | undefined;
  if (row) say(`PreStocks mark ${row.markPrice}, token price ${row.tokenPrice}`);
  else say(`SPACEX is no longer in the PreStocks API. It lists: ${list.map((r) => r.symbol).join(", ")}`);

  const tokens = new TokenState(conn);
  tokens.start();
  for (let i = 0; i < 40 && !tokens.get("SPACEX"); i++) await new Promise((r) => setTimeout(r, 500));
  const mult = tokens.multiplier("SPACEX");
  say(`Scaled UI multiplier ${mult}`);

  const spcx = await pyth();
  if (!spcx) say("Pyth SPCX: not readable with this key or the public endpoint");
  else {
    say(`Pyth SPCX ${spcx.price.toFixed(4)} (${age(spcx.publishTime)}, via ${spcx.via})`);
    if (row?.markPrice) say(`mark / SPCX  = ${(row.markPrice / spcx.price).toFixed(4)}`);
    if (row?.tokenPrice) say(`token / SPCX = ${(row.tokenPrice / spcx.price).toFixed(4)}`);
    say("D5 rule: keep the PreStocks mark only if mark / SPCX is within 1% of the conversion ratio (1.0 if one token converts to one share).");
  }

  const dir = path.join("docs", "checks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `spacex-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.txt`);
  fs.writeFileSync(file, out.join("\n") + "\n");
  console.log(`\nSaved ${file}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
