// "cheaper": the target gets cheaper relative to the source (to/from ratio falls).
// "richer":  the target outperforms the source (to/from ratio rises).
export type Direction = "cheaper" | "richer";

export type Sizing = { kind: "usd"; usd: number } | { kind: "shares"; shares: number };

export type Mode = "paper" | "live";

// "auto":    the keeper switches for you (source token has no transfer fee, e.g. xStocks).
// "confirm": when the trigger fires you confirm in one tap and the swap runs from your own wallet,
//            so fee-charging tokens (PreStocks, 1% per transfer) aren't moved an extra time.
export type ExecStyle = "auto" | "confirm";

export interface Limits {
  /** Max age of each Pyth reference price, seconds. */
  maxStalenessSec: number;
  /** xStocks: never sell below / buy above the Pyth equity price by more than this, basis points. */
  maxPegDeviationBps: number;
  /** Pre-IPO: never buy above / sell below the PreStocks mark by more than this, basis points. */
  maxPrivatePremiumBps: number;
  /** Max execution shortfall vs. token market prices, after known transfer fees, basis points. */
  maxSlippageBps: number;
  /** Max Pyth confidence interval / price for either reference, basis points. */
  maxConfBps: number;
  /** Consecutive evaluations the condition must hold before switching. */
  confirmations: number;
  /** Block switches this many hours around an xStock multiplier change (dividends, splits). */
  corporateActionWindowHours: number;
}

/** Pre-IPO pools are thinner (about 1-2% spread), so switches touching one default to a wider limit. */
export const PRE_IPO_SLIPPAGE_BPS = 250;

export const DEFAULT_LIMITS: Limits = {
  maxStalenessSec: 60,
  maxPegDeviationBps: 150,
  maxPrivatePremiumBps: 1000,
  maxSlippageBps: 100,
  maxConfBps: 50,
  confirmations: 3,
  corporateActionWindowHours: 12,
};

export interface IntentDraft {
  from: string;
  to: string;
  sizing: Sizing;
  direction: Direction;
  thresholdPct: number;
  mode: Mode;
  limits: Limits;
  expiresInDays: number;
  text?: string;
}

// ---- fair-price orders ---------------------------------------------------------
// A buy or sell priced against the real stock: fill only while the effective price stays within
// limitBps of the reference. Switches are the other order kind.

export type OrderKind = "switch" | "fair";
export type Side = "buy" | "sell";

export interface FairDraft {
  kind: "fair";
  side: Side;
  /** Ticker in ASSETS. */
  asset: string;
  sizing: Sizing;
  /** Buy: max premium over the reference (negative = require a discount). Sell: max discount under it. Basis points. */
  limitBps: number;
  /** Fills while the US market is closed, priced against the last regular-session reference. Off unless the user opts in. */
  offHours: { allowed: boolean; limitBps: number };
  mode: Mode;
  limits: Limits;
  expiresInDays: number;
  text?: string;
}

/** What an intent of kind "fair" stores on top of the shared intent fields. */
export interface FairSpec {
  side: Side;
  asset: string;
  limitBps: number;
  offHours: { allowed: boolean; limitBps: number };
}

export const DEFAULT_FAIR: Pick<FairDraft, "limitBps" | "offHours"> = { limitBps: 50, offHours: { allowed: false, limitBps: 100 } };

export interface ParseResult {
  draft: Partial<IntentDraft>;
  missing: string[];
  notes: string[];
}

export type CheckId =
  | "source"
  | "fresh"
  | "market"
  | "confidence"
  | "peg"
  | "private"
  | "corporate"
  | "paused"
  | "balance"
  | "delegation"
  | "quote"
  | "price"
  | "cap"
  | "agree";

export interface Check {
  id: CheckId;
  label: string;
  ok: boolean;
  detail: string;
  /** Checks that only matter at execution time are skipped (ok=true, pending) until then. */
  pending?: boolean;
}

export type IntentStatus =
  | "awaiting_approval"
  | "armed"
  | "ready"
  | "executing"
  | "executed"
  | "failed"
  | "cancelled"
  | "expired";

export interface Evaluation {
  at: number;
  ratio: number;
  changePct: number;
  /** 0..1 progress toward the trigger. */
  progress: number;
  conditionMet: boolean;
  /** Confirmations: fresh reference updates on the slower leg while the condition held. */
  streak: number;
  /** Per-leg count of distinct reference updates seen while the condition held. */
  legStreaks?: [number, number];
  /** Reference publish times at this evaluation (from, to). */
  refTimes?: [number, number];
  checks: Check[];
  blockedBy?: string;
  quote?: QuoteSummary;
  /** Fair-price orders: the price picture behind this evaluation. */
  fair?: FairPicture;
}

/** What a fair-price order would pay (or get) right now against the real stock. */
export interface FairPicture {
  session: "regular" | "extended" | "weekend" | "24/7";
  ref: RefSnapshot;
  /** USDC per share for this order size, after fees. */
  effPrice: number;
  /** Signed, vs the reference (+ = above the real price), basis points. */
  premiumBps: number;
  /** Limit in force now; null when this session is not allowed. */
  limitBps: number | null;
}

export interface QuoteSummary {
  at: number;
  inUi: number;
  outUi: number;
  fairOutUi: number;
  shortfallBps: number;
  /** Known token transfer fees on this route (PreStocks charge 1% per transfer), basis points. */
  feeBps: number;
  /** Tandem's platform fee on this order, basis points (fair orders only; 0 when off). Already in outUi. */
  platformFeeBps?: number;
  priceImpactPct: number;
  route: string;
}

export interface Execution {
  /** Fair-price orders: session, reference and price actually paid or received. */
  fair?: FairFill;
  /** Tandem's platform fee on this fill, basis points (sells only, when on). */
  platformFeeBps?: number;
  at: number;
  paper: boolean;
  signature?: string;
  inUi: number;
  outUi: number;
  fairOutUi: number;
  shortfallBps: number;
  ratio: number;
  route: string;
  error?: string;
  /** Known token transfer fees on the route, basis points. */
  feeBps?: number;
  /** Output the final quote expected, before the transaction landed. */
  expectedOutUi?: number;
  /** Reference prices behind the decision, per leg. */
  refs?: { from: RefSnapshot; to: RefSnapshot };
}

export interface FairFill extends FairPicture {
  side: Side;
  asset: string;
}

export interface RefSnapshot {
  source?: PriceSource;
  price: number;
  ageSec: number;
}

export interface IntentEvent {
  at: number;
  kind: "info" | "warn" | "success" | "error";
  message: string;
  /** Refusals: the price picture at the moment the order was refused. */
  snapshot?: { price: number; source?: PriceSource; ageSec: number; premiumBps?: number; session?: string };
}

export interface Intent {
  id: string;
  /** Records saved before fair orders existed have no kind; the store loads them as "switch". */
  kind: OrderKind;
  /** Set when kind is "fair". For fair orders, from/to are the legs (USDC and the stock), and the
   *  switch-only fields (direction, thresholdPct, baseline, triggerRatio) hold neutral values that
   *  nothing reads: the engine routes on kind first. */
  fair?: FairSpec;
  owner: string;
  createdAt: number;
  expiresAt: number;
  text?: string;
  from: string;
  to: string;
  sizing: Sizing;
  amountRaw: string;
  amountUi: number;
  direction: Direction;
  thresholdPct: number;
  mode: Mode;
  style: ExecStyle;
  limits: Limits;
  baseline: { ratio: number; fromRef: number; toRef: number; at: number };
  triggerRatio: number;
  status: IntentStatus;
  approvalSignature?: string;
  readyAt?: number;
  lastEval?: Evaluation;
  execution?: Execution;
  events: IntentEvent[];
}

/** Where a price comes from: Pyth, PreStocks, or Jupiter (xStock market price plus Backed's stock price). */
export type PriceSource = "pyth" | "prestocks" | "finnhub" | "jupiter";

/** Tickers grouped by the source of their reference price. */
export type Coverage = Partial<Record<PriceSource, string[]>>;

export interface AssetQuote {
  ticker: string;
  kind: "xstock" | "prestock";
  ref?: { price: number; conf: number; publishTime: number };
  token?: { price: number; conf: number; publishTime: number };
  /** Where the token trades on Solana right now (Jupiter), USD per token, when fresh. */
  dex?: number;
  rate?: number;
  multiplier?: number;
  pendingMultiplier?: { value: number; effectiveAt: number };
  paused?: boolean;
  marketOpen?: boolean;
  nextOpen?: number | null;
  nextClose?: number | null;
  pegBps?: number;
  sources?: { ref?: PriceSource; token?: PriceSource; rate?: PriceSource };
  transferFeeBps?: number;
  /** Pre-IPO only: company valuation at the PreStocks mark and implied by the token price, USD. */
  valuation?: { mark: number; implied: number };
}

export interface MarketSnapshot {
  /** "pyth" when every xStock reference comes from Pyth, otherwise "mixed". */
  source: "pyth" | "mixed";
  coverage: Coverage;
  sourceNote: string;
  updatedAt: number;
  assets: AssetQuote[];
}

export interface Status {
  source: "pyth" | "mixed";
  coverage: Coverage;
  sourceNote: string;
  /** Live switching allowed at all (one-tap confirm switches need only a wallet). */
  liveEnabled: boolean;
  /** Keeper ready for fully automatic switches. */
  autoEnabled: boolean;
  /** Why automatic switching is unavailable, if it is. */
  liveBlockers: string[];
  keeper?: { pubkey: string; sol: number };
  rpc: string;
}

/** Exact object a wallet signs to authorize a live intent (fixed key order). */
/** Exact object a wallet signs to authorize a fair-price order (fixed key order). */
export function canonicalFairDraft(d: FairDraft) {
  return {
    kind: "fair" as const,
    side: d.side,
    asset: d.asset,
    sizing: d.sizing.kind === "usd" ? { kind: "usd", usd: d.sizing.usd } : { kind: "shares", shares: d.sizing.shares },
    limitBps: d.limitBps,
    offHours: { allowed: d.offHours.allowed, limitBps: d.offHours.limitBps },
    mode: d.mode,
    limits: {
      maxStalenessSec: d.limits.maxStalenessSec,
      maxPegDeviationBps: d.limits.maxPegDeviationBps,
      maxPrivatePremiumBps: d.limits.maxPrivatePremiumBps,
      maxSlippageBps: d.limits.maxSlippageBps,
      maxConfBps: d.limits.maxConfBps,
      confirmations: d.limits.confirmations,
      corporateActionWindowHours: d.limits.corporateActionWindowHours,
    },
    expiresInDays: d.expiresInDays,
  };
}

export function canonicalDraft(d: IntentDraft) {
  return {
    from: d.from,
    to: d.to,
    sizing: d.sizing.kind === "usd" ? { kind: "usd", usd: d.sizing.usd } : { kind: "shares", shares: d.sizing.shares },
    direction: d.direction,
    thresholdPct: d.thresholdPct,
    mode: d.mode,
    limits: {
      maxStalenessSec: d.limits.maxStalenessSec,
      maxPegDeviationBps: d.limits.maxPegDeviationBps,
      maxPrivatePremiumBps: d.limits.maxPrivatePremiumBps,
      maxSlippageBps: d.limits.maxSlippageBps,
      maxConfBps: d.limits.maxConfBps,
      confirmations: d.limits.confirmations,
      corporateActionWindowHours: d.limits.corporateActionWindowHours,
    },
    expiresInDays: d.expiresInDays,
  };
}
