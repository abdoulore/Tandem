// Fair-price order tests: npx tsx scripts/test-fair.ts [--unit]
// 1. Unit: condition math, session and off-hours branches, minimum-out and slippage math.
// 2. Paper, on live prices (skipped with --unit): a TSLA buy with a wide limit fills, and one that
//    demands a 5% discount never does. Runs in a scratch DATA_DIR so real intents are untouched.
import os from "node:os";
import path from "node:path";
import { activeLimit, effectivePrice, fairConditionMet, limitBreach, limitMinOutUi, premiumBps, sessionOf, slippageForLimit } from "../shared/fair";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ---- unit --------------------------------------------------------------------------
check("buy: effective price is USDC in per share out", near(effectivePrice("buy", 100, 0.25), 400));
check("sell: effective price is USDC out per share in", near(effectivePrice("sell", 0.25, 99), 396));
check("premium is signed vs the reference", near(premiumBps(404, 400), 100) && near(premiumBps(396, 400), -100));

check("buy fills at or under the limit", fairConditionMet("buy", 50, 50) && fairConditionMet("buy", -20, 50) && !fairConditionMet("buy", 51, 50));
check("buy with a negative limit demands a discount", !fairConditionMet("buy", -10, -50) && fairConditionMet("buy", -60, -50));
check("sell fills at or above minus the limit", fairConditionMet("sell", -50, 50) && fairConditionMet("sell", 30, 50) && !fairConditionMet("sell", -51, 50));

const spec = { limitBps: 50, offHours: { allowed: false, limitBps: 100 } };
check("in session: the in-session limit applies", activeLimit(spec, false) === 50);
check("off-hours without opt-in: no fills", activeLimit(spec, true) === null);
check("off-hours with opt-in: the off-hours limit applies", activeLimit({ ...spec, offHours: { allowed: true, limitBps: 100 } }, true) === 100);

const sat = Date.parse("2026-10-10T16:00:00Z") / 1000; // Saturday in New York
const thu = Date.parse("2026-10-08T23:00:00Z") / 1000; // Thursday evening in New York
check("sessions: pre-IPO is 24/7", sessionOf("prestock", false, sat) === "24/7");
check("sessions: open market is regular", sessionOf("xstock", true, thu) === "regular");
check("sessions: closed weekday is extended", sessionOf("xstock", false, thu) === "extended");
check("sessions: closed Saturday is weekend", sessionOf("xstock", false, sat) === "weekend");

// Buy $100 at most 0.5% over $400: at least 100 / 402 shares. Sell 0.25 shares at most 0.5% under: at least $99.50.
check("buy min-out enforces the limit", near(limitMinOutUi("buy", 100, 400, 50), 100 / 402));
check("sell min-out enforces the limit", near(limitMinOutUi("sell", 0.25, 400, 50), 99.5));
check("slippage leaves exactly the room the limit allows", slippageForLimit(100, 99.5, 100) === 50);
check("slippage never exceeds the budget", slippageForLimit(100, 90, 30) === 30);
check("no room under the limit means zero slippage", slippageForLimit(100, 100.2, 100) === 0);

// The fresh quote before a fill: price inside the limit and an on-chain minimum no looser than the limit.
// Buy $100 at most 0.5% over $400 needs at least 100 / 402 shares on-chain.
const buyFloor = limitMinOutUi("buy", 100, 400, 50);
check("fresh buy inside the limit with a tight minimum fills", limitBreach("buy", 30, 50, buyFloor, buyFloor) === undefined);
check("fresh buy past the limit is refused", limitBreach("buy", 51, 50, buyFloor * 1.01, buyFloor) === "price");
check("fresh buy whose minimum sits under the limit is refused", limitBreach("buy", 30, 50, buyFloor * 0.999, buyFloor) === "minOut");
// The case the second quote exists for: the first quote left 50 bps of room, the fresh one came back 30 bps
// lower, so the same slippage puts the on-chain minimum about 30 bps under the limit.
const firstOut = buyFloor * 1.005, slip = slippageForLimit(firstOut, buyFloor, 100), freshOut = firstOut * 0.997;
check("a fresh quote that moved after the first is caught by its minimum", limitBreach("buy", 20, 50, freshOut * (1 - slip / 10_000), buyFloor) === "minOut");
const sellFloor = limitMinOutUi("sell", 0.25, 400, 50);
check("fresh sell at the limit's minimum fills", limitBreach("sell", -40, 50, sellFloor, sellFloor) === undefined);
check("fresh sell past the limit is refused", limitBreach("sell", -51, 50, sellFloor, sellFloor) === "price");
check("fresh sell whose minimum sits under the limit is refused", limitBreach("sell", -40, 50, sellFloor - 0.01, sellFloor) === "minOut");
// A pre-IPO sell: Jupiter applies slippage plus the 1% fee, so asking slip minus the fee's share keeps it at the limit.
const out = 100, fee = 100, room = slippageForLimit(out * (1 - fee / 10_000), 98.5, 100), ask = room - Math.ceil((room * fee) / 10_000);
check("pre-IPO sell: trimmed slippage keeps the on-chain minimum at the limit", out * (1 - (ask + fee) / 10_000) >= 98.5, `room ${room}, ask ${ask}`);

if (process.argv.includes("--unit")) {
  console.log(`\n${failed ? `${failed} FAILED` : "all unit checks pass"}`);
  process.exit(failed ? 1 : 0);
}

// ---- paper on live prices -----------------------------------------------------------
process.env.DATA_DIR = path.join(os.tmpdir(), `tandem-fair-${Date.now()}`);
process.env.LIVE_EXECUTION = "false";
const { DEFAULT_LIMITS } = await import("../shared/types");
const { USDC } = await import("../shared/assets");
const { PriceService } = await import("../server/prices");
const { TokenState } = await import("../server/tokenState");
const { Engine } = await import("../server/engine");
const { conn } = await import("../server/solana");
const { store } = await import("../server/store");
type Intent = import("../shared/types").Intent;

const tokens = new TokenState(conn);
const prices = new PriceService(tokens);
tokens.start();
prices.start();
const engine = new Engine(prices, tokens);
const evaluate = (i: Intent) => (engine as any).evaluateFair(i) as Promise<void>;

const order = (id: string, limitBps: number): Intent => ({
  id,
  kind: "fair",
  fair: { side: "buy", asset: "TSLA", limitBps, offHours: { allowed: false, limitBps: 100 } },
  owner: "guest:test-fair",
  createdAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  from: USDC.ticker,
  to: "TSLA",
  sizing: { kind: "usd", usd: 5 },
  amountRaw: String(5 * 10 ** USDC.decimals),
  amountUi: 5,
  direction: "cheaper",
  thresholdPct: 0,
  mode: "paper",
  style: "auto",
  limits: DEFAULT_LIMITS,
  baseline: { ratio: 1, fromRef: 0, toRef: 0, at: Date.now() },
  triggerRatio: 1,
  status: "armed",
  events: [],
});

// Wait for the Pyth reference and market hours: at startup only Jupiter prices have arrived.
for (let i = 0; i < 60 && (prices.refSource("TSLA") !== "pyth" || prices.quote("TSLA").marketOpen === undefined); i++) await new Promise((r) => setTimeout(r, 1000));
const open = !!prices.quote("TSLA").marketOpen;
console.log(`\nTSLA reference ${prices.ref("TSLA")?.price ?? "missing"} (${prices.refSource("TSLA")}), market ${open ? "open" : "closed"}`);
if (!open) console.log("Market closed: the wide-limit order needs the off-hours opt-in, so it is expected to wait.");

const wide = order("wide", 500);
const strict = order("strict", -500);
store.put(wide);
store.put(strict);
const t0 = Date.now();
while (Date.now() - t0 < 120_000 && wide.status !== "executed") {
  await evaluate(wide);
  await evaluate(strict);
  await new Promise((r) => setTimeout(r, 2_000));
}
const price = (i: Intent) => i.lastEval?.checks.find((c) => c.id === "price");
if (open) {
  check("paper buy with a 5% limit fills", wide.status === "executed", wide.execution?.fair ? `paid $${wide.execution.fair.effPrice.toFixed(2)}, ${wide.execution.fair.premiumBps.toFixed(1)} bps vs real` : wide.status);
  check("receipt records session, reference and premium", !!wide.execution?.fair && wide.execution.fair.session === "regular" && wide.execution.fair.ref.price > 0);
  check("it took 3 separate quotes to confirm", wide.events.some((e) => e.message.includes("(2/3 quotes)")));
}
check("paper buy demanding a 5% discount never fills", strict.status === "armed", price(strict)?.detail);
check("its price check shows the refusal reason", price(strict)?.ok === false && !!price(strict)?.detail.includes("limit -500 bps"));

console.log(`\n${failed ? `${failed} FAILED` : "all checks pass"}`);
process.exit(failed ? 1 : 0);
