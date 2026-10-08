import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ASSETS, ASSET_BY_TICKER, USDC, getAsset, isConverting, legAsset, tokenSymbol } from "../shared/assets";
import { pairRatio, rawFromUi, sharesForSizing, triggerRatio, uiFromRaw } from "../shared/math";
import { parseIntent } from "../shared/parser";
import {
  DEFAULT_FAIR,
  DEFAULT_LIMITS,
  PRE_IPO_SLIPPAGE_BPS,
  canonicalDraft,
  canonicalFairDraft,
  type Check,
  type ExecStyle,
  type FairDraft,
  type FairSpec,
  type Intent,
  type IntentDraft,
  type Status,
} from "../shared/types";
import { cancelMessage, fairMessage, intentMessage, telegramMessage, verify } from "./auth";
import { config } from "./config";
import { driftLastWriteAt, startDriftLogger } from "./drift";
import { summarize, type DriftSummary } from "./driftStats";
import { Engine } from "./engine";
import { PriceService } from "./prices";
import { ata, buildApprovalTx, buildRevokeTx, conn, programId, submitSigned, tokenAccountState } from "./solana";
import { store } from "./store";
import { telegram } from "./telegram";
import { TokenState } from "./tokenState";

const tokens = new TokenState(conn);
const prices = new PriceService(tokens);
const engine = new Engine(prices, tokens);

const app = express();
app.use(express.json({ limit: "100kb" }));

// Per-IP limits protect the upstream quotas (Jupiter, RPC, PreStocks) behind a public URL.
// Behind a reverse proxy on the same host, trust it for the client IP.
app.set("trust proxy", "loopback");
const limit = (perMinute: number) =>
  rateLimit({ windowMs: 60_000, limit: perMinute, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests, slow down a little" } });
app.use("/api", limit(600));
app.use("/api/preview", limit(60));
app.use("/api/fair", limit(60));
app.use("/api/parse", limit(60));
app.use("/api/pair", limit(60));
app.post("/api/intents", limit(10));
app.use("/api/intents/:id", limit(20));
app.use("/api/telegram", limit(20));
app.use("/api/drift", limit(60));

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const route = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
};

// ---- helpers -----------------------------------------------------------------

function normalizeDraft(d: Partial<IntentDraft>): IntentDraft {
  if (!d.from || !ASSET_BY_TICKER[d.from]) throw new Error("Pick a stock to move out of");
  if (!d.to || !ASSET_BY_TICKER[d.to]) throw new Error("Pick a stock to move into");
  if (d.from === d.to) throw new Error("Source and target must differ");
  // A company that listed has no live reference until its token-to-share price is verified; paper still runs.
  for (const t of [d.from, d.to])
    if (d.mode === "live" && isConverting(t)) throw new Error(`${ASSET_BY_TICKER[t].name} is converting to its listed stock. Live orders resume once the reference is verified.`);
  if (!d.sizing) throw new Error("Enter an amount");
  const amount = d.sizing.kind === "usd" ? d.sizing.usd : d.sizing.shares;
  if (!(amount > 0)) throw new Error("Amount must be positive");
  if (!(Number(d.thresholdPct) >= 0) || Number(d.thresholdPct) > 50) throw new Error("Threshold must be between 0% and 50%");
  const preIpo = ASSET_BY_TICKER[d.from].kind === "prestock" || ASSET_BY_TICKER[d.to].kind === "prestock";
  const limits = { ...DEFAULT_LIMITS, ...(preIpo ? { maxSlippageBps: PRE_IPO_SLIPPAGE_BPS } : {}), ...(d.limits ?? {}) };
  return {
    from: d.from,
    to: d.to,
    sizing: d.sizing,
    direction: d.direction === "richer" ? "richer" : "cheaper",
    thresholdPct: Number(d.thresholdPct),
    mode: d.mode === "live" ? "live" : "paper",
    limits,
    expiresInDays: Math.min(90, Math.max(1, Number(d.expiresInDays ?? 7))),
    text: d.text,
  };
}

function priceContext(d: IntentDraft) {
  const fromRef = prices.ref(d.from)?.price;
  const toRef = prices.ref(d.to)?.price;
  for (const t of [d.from, d.to])
    if (isConverting(t) && !prices.ref(t)) throw new Error(`${ASSET_BY_TICKER[t].name} has no reference price since it listed, so switches with it are paused.`);
  if (!fromRef || !toRef) throw new Error("Prices are still loading - try again in a moment");
  const src = getAsset(d.from);
  // USD amounts buy tokens at the market price, not the reference mark.
  const fromPx = prices.marketPrice(d.from) ?? fromRef;
  const shares = sharesForSizing(d.sizing, fromPx);
  const amountRaw = rawFromUi(shares, src.decimals, tokens.multiplier(d.from));
  const amountUi = uiFromRaw(amountRaw, src.decimals, tokens.multiplier(d.from));
  const ratio = pairRatio(fromRef, toRef);
  const trigger = triggerRatio(ratio, d.direction, d.thresholdPct);
  return { fromRef, toRef, ratio, trigger, amountRaw, amountUi, usdValue: amountUi * fromPx };
}

/** Tokens with a transfer fee (PreStocks) switch by one-tap confirm so they aren't moved an extra time. */
const styleFor = (from: string): ExecStyle => (tokens.feeBps(from) > 0 ? "confirm" : "auto");

// ---- fair-price orders ---------------------------------------------------------------

/** PreStocks charge 1% per transfer, so their orders are always one-tap; xStocks run through the keeper. */
const fairStyle = (asset: string): ExecStyle => (getAsset(asset).kind === "prestock" ? "confirm" : "auto");

function normalizeFair(d: Partial<FairDraft>): FairDraft {
  const a = d.asset ? ASSET_BY_TICKER[d.asset] : undefined;
  if (!a) throw new Error("Pick a stock");
  if (d.side !== "buy" && d.side !== "sell") throw new Error("Choose buy or sell");
  if (!d.sizing) throw new Error("Enter an amount");
  const amount = d.sizing.kind === "usd" ? d.sizing.usd : d.sizing.shares;
  if (!(amount > 0)) throw new Error("Amount must be positive");
  const limitBps = Number(d.limitBps ?? DEFAULT_FAIR.limitBps);
  if (!Number.isFinite(limitBps) || limitBps < -1000 || limitBps > 1000) throw new Error("Limit must be between -10% and +10% of the real price");
  const off = d.offHours ?? DEFAULT_FAIR.offHours;
  const offLimit = Number(off.limitBps ?? DEFAULT_FAIR.offHours.limitBps);
  if (!Number.isFinite(offLimit) || offLimit < 0 || offLimit > 1000) throw new Error("Off-hours limit must be between 0% and 10%");
  if (d.mode === "live" && isConverting(a.ticker)) throw new Error(`${a.name} is converting to its listed stock. Live orders resume once the reference is verified.`);
  const limits = { ...DEFAULT_LIMITS, ...(a.kind === "prestock" ? { maxSlippageBps: PRE_IPO_SLIPPAGE_BPS } : {}), ...(d.limits ?? {}) };
  return {
    kind: "fair",
    side: d.side,
    asset: a.ticker,
    sizing: d.sizing,
    limitBps,
    offHours: { allowed: !!off.allowed, limitBps: offLimit },
    mode: d.mode === "live" ? "live" : "paper",
    limits,
    expiresInDays: Math.min(90, Math.max(1, Number(d.expiresInDays ?? 7))),
    text: d.text,
  };
}

/** Order size in the source token (USDC for a buy, the stock for a sell), sized at the market price. */
function fairContext(d: FairDraft) {
  const a = getAsset(d.asset);
  if (isConverting(a.ticker) && !prices.ref(a.ticker)) throw new Error(`${a.name} has no reference price since it listed, so orders are paused.`);
  const px = prices.marketPrice(a.ticker);
  if (!px) throw new Error("Prices are still loading - try again in a moment");
  const mult = tokens.multiplier(a.ticker);
  const from = d.side === "buy" ? USDC.ticker : a.ticker;
  const to = d.side === "buy" ? a.ticker : USDC.ticker;
  if (d.side === "buy") {
    const usd = d.sizing.kind === "usd" ? d.sizing.usd : d.sizing.shares * px;
    const amountRaw = BigInt(Math.round(usd * 10 ** USDC.decimals));
    return { from, to, amountRaw, amountUi: Number(amountRaw) / 10 ** USDC.decimals, usdValue: usd, marketPrice: px };
  }
  const shares = d.sizing.kind === "shares" ? d.sizing.shares : d.sizing.usd / px;
  const amountRaw = rawFromUi(shares, a.decimals, mult);
  const amountUi = uiFromRaw(amountRaw, a.decimals, mult);
  return { from, to, amountRaw, amountUi, usdValue: amountUi * px, marketPrice: px };
}

const fairSpec = (d: FairDraft): FairSpec => ({ side: d.side, asset: d.asset, limitBps: d.limitBps, offHours: d.offHours });

function capCheck(usdValue: number): Check {
  return {
    id: "cap",
    label: "Within the live order cap",
    ok: usdValue <= config.maxLiveUsd,
    detail: `$${usdValue.toFixed(2)} of a $${config.maxLiveUsd} cap per live order`,
  };
}

/** Live switching needs authoritative references: Pyth for xStocks, PreStocks marks for pre-IPO. */
const authoritative = (t: string) => prices.refSource(t) === "pyth" || prices.refSource(t) === "prestocks";

/** Sum of what the keeper must be allowed to pull from this owner's source account. */
function committedRaw(owner: string, from: string, excludeId?: string): bigint {
  return store
    .byOwner(owner)
    .filter((i) => i.mode === "live" && i.style === "auto" && i.from === from && i.id !== excludeId && (i.status === "armed" || i.status === "executing"))
    .reduce((s, i) => s + BigInt(i.amountRaw), 0n);
}

// ---- routes ------------------------------------------------------------------

app.get(
  "/api/status",
  route(async (): Promise<Status> => {
    const blockers: string[] = [];
    if (!config.keeper) blockers.push("Keeper wallet not configured");
    if (!config.liveExecution) blockers.push("LIVE_EXECUTION=false");
    let keeper: Status["keeper"];
    if (config.keeper) {
      const lamports = await conn.getBalance(config.keeper.publicKey).catch(() => 0);
      keeper = { pubkey: config.keeper.publicKey.toBase58(), sol: lamports / LAMPORTS_PER_SOL };
      if (lamports < 0.005 * LAMPORTS_PER_SOL) blockers.push("Keeper needs ~0.02 SOL for fees");
    }
    return {
      source: prices.source,
      sourceNote: prices.sourceNote,
      coverage: prices.coverage(),
      liveEnabled: config.liveExecution,
      autoEnabled: blockers.length === 0,
      liveBlockers: blockers,
      keeper,
      rpc: new URL(config.rpcUrl).host,
    };
  }),
);

// Cheap liveness for monitors: no RPC call per request (the keeper balance is cached for a minute).
const startedAt = Date.now();
let keeperSol = { at: 0, sol: 0 };
app.get(
  "/api/health",
  route(async () => {
    if (config.keeper && Date.now() - keeperSol.at > 60_000) {
      const lamports = await conn.getBalance(config.keeper.publicKey).catch(() => 0);
      keeperSol = { at: Date.now(), sol: lamports / LAMPORTS_PER_SOL };
    }
    const pyth = prices.pythEntitlement();
    return {
      ok: prices.updatedAt > 0 && Date.now() - prices.updatedAt < 120_000,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      pricesUpdatedAt: prices.updatedAt || null,
      priceSource: prices.source,
      pythFeeds: `${pyth.readable}/${pyth.total}`,
      driftLastWriteAt: driftLastWriteAt || null,
      liveEnabled: config.liveExecution,
      autoEnabled: config.liveExecution && !!config.keeper && keeperSol.sol >= 0.005,
    };
  }),
);

app.get(
  "/api/assets",
  route(() => ASSETS.map(({ ticker, name, mint, decimals }) => ({ ticker, name, mint, decimals }))),
);

app.get(
  "/api/market",
  route(() => prices.snapshot()),
);

app.get(
  "/api/pair",
  route((req) => {
    const from = String(req.query.from ?? "").toUpperCase();
    const to = String(req.query.to ?? "").toUpperCase();
    getAsset(from);
    getAsset(to);
    const since = Number(req.query.since ?? 0);
    return { from, to, series: prices.ratioSeries(from, to, since) };
  }),
);

app.post(
  "/api/parse",
  route((req) => parseIntent(String(req.body?.text ?? "").slice(0, 500))),
);

app.post(
  "/api/preview",
  route(async (req) => {
    const d = normalizeDraft(req.body?.draft ?? {});
    const ctx = priceContext(d);
    const style = styleFor(d.from);
    const checks = engine.marketChecks(d.from, d.to, d.limits, d.mode);
    let quote;
    try {
      quote = (await engine.quoteSwitch(d.from, d.to, ctx.amountRaw, style)).summary;
      checks.push(engine.quoteCheck(quote, d.limits));
    } catch (e) {
      checks.push(engine.quoteCheck(undefined, d.limits, (e as Error).message));
    }
    let balanceUi: number | undefined;
    const owner = req.body?.owner as string | undefined;
    if (owner && !owner.startsWith("guest:")) {
      try {
        const st = await tokenAccountState(new PublicKey(owner), d.from);
        balanceUi = uiFromRaw(st.amount, getAsset(d.from).decimals, tokens.multiplier(d.from));
        if (d.mode === "live")
          checks.push({
            id: "balance",
            label: `Wallet holds ${tokenSymbol(d.from)}`,
            ok: st.amount >= ctx.amountRaw + committedRaw(owner, d.from),
            detail: `${balanceUi.toFixed(4)} ${tokenSymbol(d.from)} in wallet, needs ${ctx.amountUi.toFixed(4)}`,
          });
      } catch {
        /* balance is informational in preview */
      }
    }
    return {
      draft: d,
      ...ctx,
      amountRaw: ctx.amountRaw.toString(),
      outNow: ctx.amountUi / ctx.ratio,
      outAtTrigger: ctx.amountUi / ctx.trigger,
      checks,
      quote,
      balanceUi,
      style,
      // Warn when fees and spread would eat most (over half) of the move the user is waiting for.
      thinTrigger:
        quote && quote.feeBps > 0 && d.thresholdPct < (2 * (quote.feeBps + Math.max(0, quote.shortfallBps))) / 100
          ? (quote.feeBps + Math.max(0, quote.shortfallBps)) / 100
          : undefined,
    };
  }),
);

app.post(
  "/api/fair/preview",
  route(async (req) => {
    const d = normalizeFair(req.body?.draft ?? {});
    const ctx = fairContext(d);
    const style = fairStyle(d.asset);
    const spec = fairSpec(d);
    let quote;
    let picture;
    let quoteErr: string | undefined;
    try {
      const r = await engine.quoteFair(d.side, d.asset, ctx.amountRaw, style);
      quote = r.summary;
      picture = engine.fairPicture(spec, r.eff);
    } catch (e) {
      quoteErr = (e as Error).message;
    }
    const checks = engine.fairChecks(spec, picture, d.limits, d.mode);
    checks.push(engine.quoteCheck(quote, d.limits, quoteErr));
    if (d.mode === "live") checks.push(capCheck(ctx.usdValue));
    let balanceUi: number | undefined;
    const owner = req.body?.owner as string | undefined;
    if (owner && !owner.startsWith("guest:")) {
      try {
        const st = await tokenAccountState(new PublicKey(owner), ctx.from);
        const src = legAsset(ctx.from);
        balanceUi = uiFromRaw(st.amount, src.decimals, tokens.multiplier(ctx.from));
        if (d.mode === "live")
          checks.push({
            id: "balance",
            label: `Wallet holds ${tokenSymbol(ctx.from)}`,
            ok: st.amount >= ctx.amountRaw + committedRaw(owner, ctx.from),
            detail: `${balanceUi.toFixed(4)} ${tokenSymbol(ctx.from)} in wallet, needs ${ctx.amountUi.toFixed(4)}`,
          });
      } catch {
        /* balance is informational in preview */
      }
    }
    return { draft: d, ...ctx, amountRaw: ctx.amountRaw.toString(), style, checks, quote, picture, balanceUi };
  }),
);

app.get(
  "/api/intents",
  route((req) => {
    const owner = String(req.query.owner ?? "");
    return owner ? store.byOwner(owner) : [];
  }),
);

app.post(
  "/api/intents",
  route(async (req) => {
    if (req.body?.draft?.kind === "fair") return createFair(req);
    const d = normalizeDraft(req.body?.draft ?? {});
    const owner = String(req.body?.owner ?? "");
    if (!owner) throw new Error("Missing owner");
    if (d.mode === "live") {
      if (owner.startsWith("guest:")) throw new Error("Connect a wallet for live switching");
      const ts = Number(req.body?.ts);
      const err = verify(owner, intentMessage(owner, canonicalDraft(d), ts), String(req.body?.signature ?? ""), ts);
      if (err) throw new Error(err);
      if (!config.liveExecution) throw new Error("Live switching is disabled on this server");
      if (!authoritative(d.from) || !authoritative(d.to)) throw new Error("Live switching needs Pyth or PreStocks reference prices for both stocks");
      if (styleFor(d.from) === "auto" && !config.keeper) throw new Error("Automatic switching is not available on this server right now");
    }
    const style = styleFor(d.from);
    const ctx = priceContext(d);
    if (d.mode === "live" && ctx.usdValue > config.maxLiveUsd) throw new Error(`Live switches are capped at $${config.maxLiveUsd} on this server`);
    const now = Date.now();
    const intent: Intent = {
      id: crypto.randomUUID().slice(0, 8),
      kind: "switch",
      owner,
      createdAt: now,
      expiresAt: now + d.expiresInDays * 86_400_000,
      text: d.text,
      from: d.from,
      to: d.to,
      sizing: d.sizing,
      amountRaw: ctx.amountRaw.toString(),
      amountUi: ctx.amountUi,
      direction: d.direction,
      thresholdPct: d.thresholdPct,
      mode: d.mode,
      style,
      limits: d.limits,
      baseline: { ratio: ctx.ratio, fromRef: ctx.fromRef, toRef: ctx.toRef, at: now },
      triggerRatio: ctx.trigger,
      status: d.mode === "live" && style === "auto" ? "awaiting_approval" : "armed",
      events: [],
    };
    store.event(intent, "info", `Created. Baseline 1 ${d.to} = ${ctx.ratio.toFixed(5)} ${d.from}; trigger at ${ctx.trigger.toFixed(5)}`);
    store.put(intent);

    if (d.mode === "paper" || style === "confirm") return { intent };
    const total = committedRaw(owner, d.from) + ctx.amountRaw;
    const { tx } = await buildApprovalTx(new PublicKey(owner), config.keeper!.publicKey, d.from, d.to, total);
    return { intent, approvalTx: tx };
  }),
);

async function createFair(req: Request) {
  const d = normalizeFair(req.body?.draft ?? {});
  const owner = String(req.body?.owner ?? "");
  if (!owner) throw new Error("Missing owner");
  const style = fairStyle(d.asset);
  const ctx = fairContext(d);
  if (d.mode === "live") {
    if (owner.startsWith("guest:")) throw new Error("Connect a wallet for live orders");
    const ts = Number(req.body?.ts);
    const err = verify(owner, fairMessage(owner, canonicalFairDraft(d), ts), String(req.body?.signature ?? ""), ts);
    if (err) throw new Error(err);
    if (!config.liveExecution) throw new Error("Live orders are disabled on this server");
    if (!authoritative(d.asset)) throw new Error("Live orders need a Pyth or PreStocks reference price for this stock");
    if (style === "auto" && !config.keeper) throw new Error("Automatic orders are not available on this server right now");
    if (ctx.usdValue > config.maxLiveUsd) throw new Error(`Live orders are capped at $${config.maxLiveUsd} on this server`);
  }
  const ref = prices.ref(d.asset)?.price ?? 0;
  const now = Date.now();
  const intent: Intent = {
    id: crypto.randomUUID().slice(0, 8),
    kind: "fair",
    fair: fairSpec(d),
    owner,
    createdAt: now,
    expiresAt: now + d.expiresInDays * 86_400_000,
    text: d.text,
    from: ctx.from,
    to: ctx.to,
    sizing: d.sizing,
    amountRaw: ctx.amountRaw.toString(),
    amountUi: ctx.amountUi,
    // Switch-only fields: neutral values, never read for fair orders.
    direction: "cheaper",
    thresholdPct: 0,
    baseline: { ratio: 1, fromRef: ref, toRef: ref, at: now },
    triggerRatio: 1,
    mode: d.mode,
    style,
    limits: d.limits,
    status: d.mode === "live" && style === "auto" ? "awaiting_approval" : "armed",
    events: [],
  };
  const limitText = d.side === "buy" ? `at most ${d.limitBps / 100}% over` : `at most ${d.limitBps / 100}% under`;
  store.event(intent, "info", `Created. ${d.side === "buy" ? "Buy" : "Sell"} ${d.asset} ${limitText} the real price (now $${ref.toFixed(2)})`);
  store.put(intent);
  if (d.mode === "paper" || style === "confirm") return { intent };
  const total = committedRaw(owner, ctx.from) + ctx.amountRaw;
  const { tx } = await buildApprovalTx(new PublicKey(owner), config.keeper!.publicKey, ctx.from, ctx.to, total);
  return { intent, approvalTx: tx };
}

app.post(
  "/api/intents/:id/confirm",
  route(async (req) => {
    const intent = store.get(String(req.params.id));
    if (!intent) throw new Error("Unknown intent");
    if (intent.status !== "awaiting_approval") return { intent };
    if (req.body?.signedTx) intent.approvalSignature = await submitSigned(String(req.body.signedTx));
    const st = await tokenAccountState(new PublicKey(intent.owner), intent.from);
    if (st.delegate !== config.keeper?.publicKey.toBase58() || st.delegatedAmount < BigInt(intent.amountRaw))
      throw new Error("Approval not found on-chain yet - wait a few seconds and retry");
    intent.status = "armed";
    store.event(intent, "success", "Approval confirmed on-chain. Monitoring with Pyth.");
    store.touch();
    return { intent };
  }),
);

app.post(
  "/api/intents/:id/cancel",
  route(async (req) => {
    const intent = store.get(String(req.params.id));
    if (!intent) throw new Error("Unknown intent");
    const owner = String(req.body?.owner ?? "");
    if (owner !== intent.owner) throw new Error("Not your intent");
    if (intent.mode === "live") {
      const ts = Number(req.body?.ts);
      const err = verify(owner, cancelMessage(owner, intent.id, ts), String(req.body?.signature ?? ""), ts);
      if (err) throw new Error(err);
    }
    if (!["armed", "ready", "awaiting_approval"].includes(intent.status)) throw new Error(`Cannot cancel a ${intent.status} intent`);
    intent.status = "cancelled";
    store.event(intent, "info", "Cancelled by owner");
    store.touch();
    let revokeTx: string | undefined;
    if (intent.mode === "live" && intent.style === "auto" && config.keeper) {
      revokeTx = await buildRevokeTx(new PublicKey(owner), intent.from, config.keeper.publicKey, committedRaw(owner, intent.from, intent.id));
    }
    return { intent, revokeTx };
  }),
);

// One-tap confirm: rebuild and re-check the swap right now, for the owner to sign.
app.post(
  "/api/intents/:id/swap-tx",
  route(async (req) => {
    const intent = store.get(String(req.params.id));
    if (!intent) throw new Error("Unknown intent");
    if (String(req.body?.owner ?? "") !== intent.owner) throw new Error("Not your intent");
    return engine.buildConfirmTx(intent);
  }),
);

app.post(
  "/api/intents/:id/executed",
  route(async (req) => {
    const intent = store.get(String(req.params.id));
    if (!intent) throw new Error("Unknown intent");
    if (intent.status !== "ready") throw new Error("This switch is not ready");
    const signature = await submitSigned(String(req.body?.signedTx ?? ""));
    await engine.recordConfirmed(intent, signature);
    return { intent };
  }),
);

// Submits only the owner-signed transaction that shrinks the keeper's approval after a cancel.
app.post(
  "/api/intents/:id/revoke",
  route(async (req) => {
    const intent = store.get(String(req.params.id));
    if (!intent) throw new Error("Unknown intent");
    if (intent.mode !== "live" || intent.style !== "auto" || intent.status !== "cancelled") throw new Error("Nothing to revoke for this switch");
    const tx = VersionedTransaction.deserialize(Buffer.from(String(req.body?.signedTx ?? ""), "base64"));
    const keys = tx.message.staticAccountKeys;
    if (!keys[0]?.equals(new PublicKey(intent.owner))) throw new Error("Revoke must be paid and signed by the owner");
    // The source may be a stock token (Token-2022) or USDC (classic SPL Token).
    const sourceMint = legAsset(intent.from).mint;
    const source = ata(new PublicKey(intent.owner), sourceMint);
    const touchesApproval = tx.message.compiledInstructions.some(
      (ix) => keys[ix.programIdIndex]?.equals(programId(sourceMint)) && ix.accountKeyIndexes.some((k) => keys[k]?.equals(source)),
    );
    if (!touchesApproval) throw new Error("Not a revoke for this switch");
    return { signature: await submitSigned(String(req.body.signedTx)) };
  }),
);

// ---- drift ---------------------------------------------------------------------

// How far tokens trade from their reference, per ticker and session, over the last N hours (max 14 days).
const driftCache = new Map<number, { at: number; body: DriftSummary }>();
app.get(
  "/api/drift/summary",
  route((req) => {
    const hours = Math.min(336, Math.max(1, Math.round(Number(req.query.hours) || 72)));
    const hit = driftCache.get(hours);
    if (hit && Date.now() - hit.at < 60_000) return hit.body;
    const body = summarize(Math.floor(Date.now() / 1000) - hours * 3600);
    driftCache.set(hours, { at: Date.now(), body });
    return body;
  }),
);

// ---- Telegram alerts -------------------------------------------------------------

const isGuest = (o: unknown): o is string => typeof o === "string" && /^guest:[\w-]{4,64}$/.test(o);

app.get(
  "/api/telegram",
  route((req) => ({ enabled: telegram.enabled, bot: telegram.bot, linked: telegram.linked(String(req.query.owner ?? "")) })),
);

// Wallets prove ownership by signing; paper users link by their browser id.
app.post(
  "/api/telegram/link",
  route((req) => {
    const owner = req.body?.owner;
    if (isGuest(owner)) return { url: telegram.linkUrl([owner]) };
    if (typeof owner !== "string") throw new Error("Missing owner");
    const ts = Number(req.body?.ts);
    const err = verify(owner, telegramMessage(owner, ts), String(req.body?.signature ?? ""), ts);
    if (err) throw new Error(err);
    const guest = req.body?.guest;
    return { url: telegram.linkUrl(isGuest(guest) ? [owner, guest] : [owner]) };
  }),
);

// ---- static frontend (production) ----------------------------------------------

const dist = path.resolve("dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// Only the process that holds the port runs the engine, so two servers can never act on the same switches.
app.listen(config.port, (err?: Error) => {
  if (err) {
    console.error(`Port ${config.port} is unavailable (${err.message}). Is Tandem already running? Exiting.`);
    process.exit(1);
  }
  tokens.start();
  prices.start();
  startDriftLogger(prices, tokens);
  engine.start();
  telegram.start().catch((e) => console.error("Telegram alerts failed to start:", (e as Error).message));
  console.log(`Tandem API on http://localhost:${config.port}`);
  console.log(`  prices: ${prices.sourceNote}`);
  console.log(`  keeper: ${config.keeper?.publicKey.toBase58() ?? "not configured (paper mode only)"}`);
});
