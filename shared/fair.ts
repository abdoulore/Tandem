import type { AssetKind } from "./assets";
import type { FairSpec, Side } from "./types";

// Fair-price order math: what an order actually pays against the real stock, which limit applies in
// the current session, and the smallest output that still honours that limit. Pure, so the engine,
// the order form and the tests share it.

export type Session = "regular" | "extended" | "weekend" | "24/7";

/** US equities: regular when the market is open, weekend on New York Saturday or Sunday, otherwise extended (holidays included). */
export function sessionOf(kind: AssetKind, open: boolean, t: number): Session {
  if (kind === "prestock") return "24/7";
  if (open) return "regular";
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(t * 1000));
  return day === "Sat" || day === "Sun" ? "weekend" : "extended";
}

/** USDC per share actually paid (buy) or received (sell), in UI units. */
export function effectivePrice(side: Side, inUi: number, outUi: number): number {
  return side === "buy" ? inUi / outUi : outUi / inUi;
}

/** Signed distance of the effective price from the reference, basis points (+ = above the real price). */
export const premiumBps = (eff: number, ref: number) => (eff / ref - 1) * 10_000;

/** The limit that applies now, or null when the order may not fill in this session (off-hours without opt-in). */
export function activeLimit(spec: Pick<FairSpec, "limitBps" | "offHours">, offHours: boolean): number | null {
  if (!offHours) return spec.limitBps;
  return spec.offHours.allowed ? spec.offHours.limitBps : null;
}

/** Buy: pay at most limit over the reference. Sell: receive at least limit under it. */
export function fairConditionMet(side: Side, premium: number, limitBps: number): boolean {
  return side === "buy" ? premium <= limitBps : premium >= -limitBps;
}

/** Smallest output (UI units) that still respects the limit: shares for a buy, USDC for a sell. */
export function limitMinOutUi(side: Side, inUi: number, ref: number, limitBps: number): number {
  return side === "buy" ? inUi / (ref * (1 + limitBps / 10_000)) : inUi * ref * (1 - limitBps / 10_000);
}

/**
 * Why a fresh quote can no longer fill inside the limit, or undefined when it can. Both must hold: the quoted
 * price is inside the limit, and the swap's on-chain minimum (what the wallet is guaranteed to receive) is no
 * lower than the limit's minimum-out, so a price that moves after the check still cannot fill past the limit.
 */
export function limitBreach(side: Side, premium: number, limitBps: number, thresholdUi: number, minOutUi: number): "price" | "minOut" | undefined {
  if (!fairConditionMet(side, premium, limitBps)) return "price";
  if (thresholdUi < minOutUi) return "minOut";
  return undefined;
}

/**
 * Slippage to request so the swap's on-chain minimum-out (quoted * (1 - slippage)) is no looser than
 * the user's limit or the slippage budget. 0 means the quote has no room left under the limit.
 */
export function slippageForLimit(quotedOutUi: number, minOutUi: number, budgetBps: number): number {
  const room = Math.floor((1 - minOutUi / quotedOutUi) * 10_000);
  return Math.max(0, Math.min(budgetBps, room));
}
