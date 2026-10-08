import { PublicKey } from "@solana/web3.js";
import { USDC, getAsset, legAsset, tokenSymbol } from "../shared/assets";
import { activeLimit, effectivePrice, fairConditionMet, limitMinOutUi, premiumBps, sessionOf, slippageForLimit } from "../shared/fair";
import { changePct, conditionMet, fmtNum, progress, shortfallBps, uiFromRaw } from "../shared/math";
import type { Check, ExecStyle, Execution, FairFill, FairPicture, FairSpec, Intent, Limits, Mode, QuoteSummary, RefSnapshot, Side } from "../shared/types";
import { config } from "./config";
import { getQuote, getSwapTransaction, routeLabel, type JupQuote } from "./jupiter";
import type { PriceService } from "./prices";
import { ata, buildSwitchTx, receivedRaw, sendAndConfirm, tokenAccountState } from "./solana";
import { store } from "./store";
import type { TokenState } from "./tokenState";

const QUOTE_REFRESH_MS = 30_000;
const DELEGATION_REFRESH_MS = 30_000;
const MAX_LIVE_ATTEMPTS = 3;
/** Once Ready, the trigger condition gets this long to flicker while the user confirms. Safety checks get none. */
const READY_GRACE_MS = 120_000;
/** Fair orders re-quote their real size this often; each passing quote is one confirmation. */
const FAIR_QUOTE_MS = 20_000;
/** Off-hours, the reference is the last regular-session print: allow one that covers weekends and holidays. */
const OFF_HOURS_REF_MAX_SEC = 100 * 3600;
/** The same refusal on the same order is logged at most this often. */
const REFUSAL_EVERY_MS = 10 * 60_000;

/** A fill refused because the price moved past the user's limit. Not a failure: the order keeps watching. */
class Refusal extends Error {}

type FairQuote = { summary: QuoteSummary; raw: JupQuote; eff: number };

const age = (t: number) => Math.max(0, Math.round(Date.now() / 1000 - t));
const fmtAge = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
const fmtBps = (b: number) => `${b >= 0 ? "+" : ""}${b.toFixed(0)} bps`;
/** The premium a fair order accepts, signed against the reference: buys "+50 bps" (at most over), sells "-50 bps" (at most under). */
const fmtLimit = (side: Side, limitBps: number) => {
  const t = side === "buy" ? limitBps : -limitBps;
  return `${t >= 0 ? "+" : "-"}${Math.abs(t)} bps`;
};

export class Engine {
  private quotes = new Map<string, { summary: QuoteSummary; raw: JupQuote }>();
  private delegation = new Map<string, { at: number; check: Check }>();
  private attempts = new Map<string, number>();
  private fairQuotes = new Map<string, FairQuote>();
  private fairPics = new Map<string, FairPicture>();
  private lastRefusal = new Map<string, number>();
  private busy = false;

  constructor(
    private prices: PriceService,
    private tokens: TokenState,
  ) {}

  start() {
    const loop = () => this.tick().finally(() => setTimeout(loop, config.pollMs));
    loop();
  }

  // ---- safety checks --------------------------------------------------------

  /** Market-data checks shared by previews and live evaluation. */
  marketChecks(from: string, to: string, limits: Limits, mode: Mode): Check[] {
    const checks: Check[] = [];
    const legs = [
      { t: from, side: "sell" as const, kind: getAsset(from).kind, src: this.prices.refSource(from), ref: this.prices.ref(from), q: this.prices.quote(from) },
      { t: to, side: "buy" as const, kind: getAsset(to).kind, src: this.prices.refSource(to), ref: this.prices.ref(to), q: this.prices.quote(to) },
    ];
    const srcLabel = (l: (typeof legs)[number]) =>
      l.src === "pyth" ? "Pyth" : l.src === "prestocks" ? "PreStocks mark" : l.src === "jupiter" ? "Backed via Jupiter" : "loading";

    // Live switching only runs on authoritative references: Pyth for public equities, PreStocks marks for pre-IPO.
    const authoritative = legs.every((l) => l.src === "pyth" || l.src === "prestocks");
    checks.push({
      id: "source",
      label: "Trusted reference prices",
      ok: authoritative || mode === "paper",
      detail:
        legs.map((l) => `${l.t}: ${srcLabel(l)}`).join(" · ") +
        (authoritative ? "" : mode === "paper" ? " (paper only)" : " - live needs Pyth or PreStocks prices"),
    });

    const ages = legs.map((l) => (l.ref ? age(l.ref.publishTime) : Infinity));
    // Backed prices via Jupiter refresh every few minutes; tolerate that in paper mode only.
    // PreStocks marks move slowly and their API is polled every 20s, so allow up to 3 minutes.
    const maxAge = (l: (typeof legs)[number]) =>
      l.src === "jupiter" && mode === "paper"
        ? Math.max(limits.maxStalenessSec, 900)
        : l.src === "prestocks"
          ? Math.max(limits.maxStalenessSec, 180)
          : limits.maxStalenessSec;
    checks.push({
      id: "fresh",
      label: "Reference prices fresh",
      ok: legs.every((l, i) => ages[i] <= maxAge(l)),
      detail: legs.map((l, i) => `${l.t} ${Number.isFinite(ages[i]) ? fmtAge(ages[i]) : "n/a"}`).join(" · ") + ` (max ${fmtAge(Math.max(...legs.map(maxAge)))})`,
    });

    const equityLegs = legs.filter((l) => l.kind === "xstock");
    if (equityLegs.length) {
      const closed = equityLegs.filter((l) => l.q.marketOpen === false);
      const nextOpen = closed.map((l) => l.q.nextOpen).find((n) => n);
      checks.push({
        id: "market",
        label: "US market open",
        ok: closed.length === 0,
        detail: closed.length
          ? `Closed${nextOpen ? ` - reopens ${new Date(nextOpen * 1000).toUTCString().slice(0, 22)} UTC` : ""}`
          : "Real-world reference is trading",
      });
      const pythLegs = equityLegs.filter((l) => l.src === "pyth");
      const confs = pythLegs.map((l) => (l.ref && l.ref.price ? (l.ref.conf / l.ref.price) * 10_000 : Infinity));
      checks.push({
        id: "confidence",
        label: "Pyth confidence tight",
        ok: confs.every((c) => c <= limits.maxConfBps),
        detail: pythLegs.length ? pythLegs.map((l, i) => `${l.t} ±${Number.isFinite(confs[i]) ? confs[i].toFixed(1) : "?"} bps`).join(" · ") : "No Pyth-priced leg",
      });
    }

    // One-sided: never sell a token below its reference or buy one above it by more than the limit.
    const pegLine = (l: (typeof legs)[number], limit: number) => {
      const p = l.q.pegBps;
      if (p === undefined) return { ok: false, text: `${l.t} n/a` };
      const bad = l.side === "buy" ? p > limit : p < -limit;
      return { ok: !bad, text: `${l.side} ${l.t} at ${fmtBps(p)}` };
    };
    const pub = equityLegs.map((l) => pegLine(l, limits.maxPegDeviationBps));
    if (pub.length)
      checks.push({
        id: "peg",
        label: "xStocks track their stock",
        ok: pub.every((p) => p.ok),
        detail: pub.map((p) => p.text).join(" · ") + ` vs Pyth (limit ${limits.maxPegDeviationBps})`,
      });
    const priv = legs.filter((l) => l.kind === "prestock").map((l) => pegLine(l, limits.maxPrivatePremiumBps));
    if (priv.length)
      checks.push({
        id: "private",
        label: "Pre-IPO price vs PreStocks mark",
        ok: priv.every((p) => p.ok),
        detail: priv.map((p) => p.text).join(" · ") + ` (limit ${limits.maxPrivatePremiumBps})`,
      });

    const corp = legs.map((l) => ({ t: l.t, ...this.tokens.corporateActionNear(l.t, limits.corporateActionWindowHours) }));
    const rrMismatch = legs
      .filter((l) => l.kind === "xstock" && l.q.sources?.rate === "pyth" && l.q.rate && l.q.multiplier && Math.abs(l.q.rate / l.q.multiplier - 1) > 0.001)
      .map((l) => l.t);
    const nearCorp = corp.filter((c) => c.near);
    checks.push({
      id: "corporate",
      label: "No corporate action in flight",
      ok: nearCorp.length === 0 && rrMismatch.length === 0,
      detail: nearCorp.length
        ? `${nearCorp.map((c) => c.t).join(", ")} multiplier changes ${new Date(nearCorp[0].at! * 1000).toUTCString().slice(0, 22)}`
        : rrMismatch.length
          ? `Pyth redemption rate ≠ on-chain multiplier for ${rrMismatch.join(", ")}`
          : "Multipliers stable",
    });

    const paused = legs.filter((l) => l.q.paused).map((l) => l.t);
    checks.push({ id: "paused", label: "Tokens not paused", ok: paused.length === 0, detail: paused.length ? `${paused.join(", ")} paused by issuer` : "Transfers enabled" });
    return checks;
  }

  /**
   * Quote the switch and measure execution quality against token market prices, after the known
   * Token-2022 transfer fees (PreStocks: 1% per transfer). Valuation vs. the real-world reference is
   * handled separately by the peg / pre-IPO checks.
   */
  async quoteSwitch(from: string, to: string, amountRaw: bigint, style: ExecStyle, slippageBps = 50, fresh = false) {
    const src = getAsset(from);
    const dst = getAsset(to);
    const pull = style === "auto"; // auto switches: the keeper pulls from the owner first
    const pullFee = pull ? this.tokens.feeFor(from, amountRaw) : 0n;
    const netIn = amountRaw - pullFee;
    // Jupiter quotes include the target token's transfer fee but not the source token's fee on the
    // way into the pool (measured: exactly 1% short for PreStocks inputs). Account for it ourselves,
    // and widen the on-chain minimum-out by that known fee so only real slippage counts against it.
    const srcFeeBps = this.tokens.feeBps(from);
    const raw = await getQuote(src.mint, dst.mint, netIn, slippageBps + srcFeeBps, fresh);
    // Fair value from on-chain DEX prices when available, so a stale posted price can't read as slippage.
    const fromTok = this.prices.dexPrice(from) ?? this.prices.token(from)?.price;
    const toTok = this.prices.dexPrice(to) ?? this.prices.token(to)?.price;
    if (!fromTok || !toTok) throw new Error("Missing token prices");
    const inUi = uiFromRaw(amountRaw, src.decimals, this.tokens.multiplier(from));
    const outUi = uiFromRaw(raw.outAmount, dst.decimals, this.tokens.multiplier(to)) * (1 - srcFeeBps / 10_000);
    const fairOutUi = (inUi * fromTok) / toTok;
    // [keeper pull (source fee)] + into the pool (source fee) + out to the owner (target fee)
    const fs = this.tokens.feeBps(from) / 10_000;
    const ft = this.tokens.feeBps(to) / 10_000;
    const feeFactor = (pull ? 1 - fs : 1) * (1 - fs) * (1 - ft);
    const summary: QuoteSummary = {
      at: Date.now(),
      inUi,
      outUi,
      fairOutUi,
      shortfallBps: shortfallBps(outUi, fairOutUi * feeFactor),
      feeBps: (1 - feeFactor) * 10_000,
      priceImpactPct: Number(raw.priceImpactPct) * 100,
      route: routeLabel(raw),
    };
    return { summary, raw, netIn };
  }

  quoteCheck(q: QuoteSummary | undefined, limits: Limits, err?: string): Check {
    if (err) return { id: "quote", label: "Execution within slippage", ok: false, detail: err };
    if (!q) return { id: "quote", label: "Execution within slippage", ok: true, pending: true, detail: "Quoted when the trigger is near" };
    return {
      id: "quote",
      label: "Execution within slippage",
      ok: q.shortfallBps <= limits.maxSlippageBps,
      detail:
        `${fmtBps(-q.shortfallBps)} vs DEX price via ${q.route} (max -${limits.maxSlippageBps})` +
        (q.feeBps > 0 ? `, plus ${(q.feeBps / 100).toFixed(1)}% token transfer fees` : ""),
    };
  }

  async delegationCheck(intent: Intent, force = false): Promise<Check> {
    const cached = this.delegation.get(intent.id);
    if (cached && !force && Date.now() - cached.at < DELEGATION_REFRESH_MS) return cached.check;
    let check: Check;
    try {
      const st = await tokenAccountState(new PublicKey(intent.owner), intent.from);
      const keeper = config.keeper?.publicKey.toBase58();
      const need = BigInt(intent.amountRaw);
      if (st.amount < need) check = { id: "delegation", label: "Funds approved", ok: false, detail: `Wallet holds less ${tokenSymbol(intent.from)} than this switch needs` };
      else if (st.delegate !== keeper || st.delegatedAmount < need)
        check = { id: "delegation", label: "Funds approved", ok: false, detail: "Approval missing or revoked" };
      else check = { id: "delegation", label: "Funds approved", ok: true, detail: `${intent.amountUi.toFixed(4)} ${tokenSymbol(intent.from)} approved, still in your wallet` };
    } catch (e) {
      check = cached?.check ?? { id: "delegation", label: "Funds approved", ok: false, detail: `RPC error: ${(e as Error).message}` };
    }
    this.delegation.set(intent.id, { at: Date.now(), check });
    return check;
  }

  async balanceCheck(intent: Intent, force = false): Promise<Check> {
    const cached = this.delegation.get(intent.id);
    if (cached && !force && Date.now() - cached.at < DELEGATION_REFRESH_MS) return cached.check;
    let check: Check;
    try {
      const st = await tokenAccountState(new PublicKey(intent.owner), intent.from);
      check =
        st.amount >= BigInt(intent.amountRaw)
          ? { id: "balance", label: `Wallet holds ${intent.from}`, ok: true, detail: `${intent.amountUi.toFixed(4)} ${intent.from} ready; you confirm when it triggers` }
          : { id: "balance", label: `Wallet holds ${intent.from}`, ok: false, detail: `Wallet holds less ${intent.from} than this switch needs` };
    } catch (e) {
      check = cached?.check ?? { id: "balance", label: `Wallet holds ${intent.from}`, ok: false, detail: `RPC error: ${(e as Error).message}` };
    }
    this.delegation.set(intent.id, { at: Date.now(), check });
    return check;
  }

  // ---- evaluation loop -------------------------------------------------------

  private async tick() {
    const armed = store.all().filter((i) => i.status === "armed" || i.status === "ready");
    await Promise.all(
      armed.map((i) => (i.kind === "fair" ? this.evaluateFair(i) : this.evaluate(i)).catch((e) => store.event(i, "error", `Evaluation error: ${(e as Error).message}`))),
    );
  }

  private async evaluate(intent: Intent) {
    if (Date.now() > intent.expiresAt) {
      intent.status = "expired";
      store.event(intent, "warn", "Expired before the condition was met");
      store.touch();
      return;
    }
    const fromFeed = this.prices.ref(intent.from);
    const toFeed = this.prices.ref(intent.to);
    if (!fromFeed || !toFeed) return;
    const fromRef = fromFeed.price;
    const toRef = toFeed.price;

    const ratio = toRef / fromRef;
    const met = conditionMet(ratio, intent.triggerRatio, intent.direction);
    // A confirmation only counts when each leg has a new reference price. One stale or bad tick
    // (PreStocks marks update every ~20s; the engine runs every 2s) can't confirm itself.
    const refTimes: [number, number] = [fromFeed.publishTime, toFeed.publishTime];
    const prev = intent.lastEval;
    const legStreaks: [number, number] = met
      ? ([0, 1].map((i) =>
          !prev?.conditionMet || !prev.legStreaks || !prev.refTimes
            ? 1
            : prev.legStreaks[i] + (refTimes[i] !== prev.refTimes[i] ? 1 : 0),
        ) as [number, number])
      : [0, 0];
    const streak = Math.min(...legStreaks);
    const checks = this.marketChecks(intent.from, intent.to, intent.limits, intent.mode);

    // Quote only when it matters (condition met) or periodically for the dashboard.
    let q = this.quotes.get(intent.id);
    let quoteErr: string | undefined;
    if (met || !q || Date.now() - q.summary.at > QUOTE_REFRESH_MS) {
      try {
        q = await this.quoteSwitch(intent.from, intent.to, BigInt(intent.amountRaw), intent.style);
        this.quotes.set(intent.id, q);
      } catch (e) {
        quoteErr = (e as Error).message;
      }
    }
    checks.push(this.quoteCheck(q?.summary, intent.limits, quoteErr));
    if (intent.mode === "live") checks.push(intent.style === "auto" ? await this.delegationCheck(intent, met) : await this.balanceCheck(intent, met));

    const failing = checks.find((c) => !c.ok);
    intent.lastEval = {
      at: Date.now(),
      ratio,
      changePct: changePct(ratio, intent.baseline.ratio),
      progress: progress(ratio, intent.baseline.ratio, intent.direction, intent.thresholdPct),
      conditionMet: met,
      streak,
      legStreaks,
      refTimes,
      checks,
      blockedBy: met ? failing?.label : undefined,
      quote: q?.summary,
    };
    store.touch();

    if (intent.status === "ready") {
      const inGrace = Date.now() - (intent.readyAt ?? 0) < READY_GRACE_MS;
      if (failing || (!met && !inGrace)) {
        intent.status = "armed";
        store.event(intent, "warn", `No longer ready (${failing ? failing.label : "condition reversed"}); back to monitoring`);
      }
      return;
    }
    if (met && failing) store.event(intent, "warn", `Condition met, waiting on: ${failing.label}`);
    if (met && !failing && streak < intent.limits.confirmations)
      store.event(intent, "info", `Condition met (${streak}/${intent.limits.confirmations} fresh price updates)`);
    if (met && !failing && streak >= intent.limits.confirmations) await this.execute(intent, q!);
  }

  // ---- execution -------------------------------------------------------------

  private async execute(intent: Intent, q: { summary: QuoteSummary; raw: JupQuote }) {
    const ratio = intent.lastEval!.ratio;
    if (intent.mode === "paper") {
      intent.status = "executed";
      intent.execution = { at: Date.now(), paper: true, ratio, ...pick(q.summary), ...this.receiptExtras(intent, q.summary) };
      store.event(intent, "success", `Paper switch: ${fmtNum(q.summary.inUi)} ${intent.from} -> ${fmtNum(q.summary.outUi)} ${intent.to} at ratio ${ratio.toFixed(5)}`);
      store.touch();
      return;
    }

    if (intent.style === "confirm") {
      intent.status = "ready";
      intent.readyAt = Date.now();
      store.event(intent, "success", "Ready: all checks pass. Confirm in your wallet to switch.");
      store.touch();
      return;
    }

    if (!config.keeper || !config.liveExecution) {
      store.event(intent, "warn", "Live execution is disabled on this server");
      return;
    }
    if (this.busy) return; // one keeper transaction at a time
    this.busy = true;
    intent.status = "executing";
    store.event(intent, "info", "Trigger confirmed - executing atomic switch");
    store.touch();
    try {
      const delegation = await this.delegationCheck(intent, true);
      if (!delegation.ok) throw new Error(delegation.detail);
      // Leave only the slippage budget the fair-value limit still allows, so the on-chain
      // minimum-out enforces the user's limit even if the market moves mid-flight.
      const budget = Math.max(10, Math.min(100, Math.floor(intent.limits.maxSlippageBps - Math.max(0, q.summary.shortfallBps))));
      const fresh = await this.quoteSwitch(intent.from, intent.to, BigInt(intent.amountRaw), "auto", budget, true);
      if (fresh.summary.shortfallBps > intent.limits.maxSlippageBps) throw new Error(`Quote moved: ${fresh.summary.shortfallBps.toFixed(0)} bps below fair value`);

      const owner = new PublicKey(intent.owner);
      const { tx, blockhash, lastValidBlockHeight, ownerDst } = await buildSwitchTx(config.keeper, owner, intent.from, intent.to, BigInt(intent.amountRaw), fresh.raw);
      const sig = await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
      const got = await receivedRaw(sig, ownerDst);
      const outUi = got !== undefined ? uiFromRaw(got, getAsset(intent.to).decimals, this.tokens.multiplier(intent.to)) : fresh.summary.outUi;
      intent.status = "executed";
      intent.execution = {
        at: Date.now(),
        paper: false,
        signature: sig,
        ratio,
        ...pick(fresh.summary),
        outUi,
        shortfallBps: netShortfall(outUi, fresh.summary),
        ...this.receiptExtras(intent, fresh.summary),
      };
      store.event(intent, "success", `Switched ${fmtNum(fresh.summary.inUi)} ${tokenSymbol(intent.from)} -> ${fmtNum(outUi)} ${tokenSymbol(intent.to)}`);
    } catch (e) {
      const n = (this.attempts.get(intent.id) ?? 0) + 1;
      this.attempts.set(intent.id, n);
      const msg = (e as Error).message.slice(0, 300);
      if (n >= MAX_LIVE_ATTEMPTS) {
        intent.status = "failed";
        intent.execution = { at: Date.now(), paper: false, ratio, ...pick(q.summary), error: msg };
        store.event(intent, "error", `Switch failed after ${n} attempts: ${msg}`);
      } else {
        intent.status = "armed";
        intent.lastEval = { ...intent.lastEval!, streak: 0, legStreaks: [0, 0], conditionMet: false };
        store.event(intent, "warn", `Attempt ${n} failed, re-arming: ${msg}`);
      }
    } finally {
      this.busy = false;
      store.touch();
    }
  }

  /** What a receipt needs beyond the fill: fees, the quote's expected output, and the prices behind the decision. */
  private receiptExtras(intent: Intent, q: QuoteSummary): Pick<Execution, "feeBps" | "expectedOutUi" | "refs"> {
    const snap = (t: string): RefSnapshot => {
      const r = this.prices.ref(t);
      return { source: this.prices.refSource(t), price: r?.price ?? 0, ageSec: r ? age(r.publishTime) : 0 };
    };
    return { feeBps: q.feeBps, expectedOutUi: q.outUi, refs: { from: snap(intent.from), to: snap(intent.to) } };
  }

  /** One-tap confirm: re-run every check, then hand back a swap transaction for the owner to sign. */
  async buildConfirmTx(intent: Intent): Promise<{ tx: string; quote: QuoteSummary }> {
    if (intent.kind === "fair") return this.buildConfirmTxFair(intent);
    if (intent.status !== "ready") throw new Error("This switch is not ready");
    const fromRef = this.prices.ref(intent.from)?.price;
    const toRef = this.prices.ref(intent.to)?.price;
    const inGrace = Date.now() - (intent.readyAt ?? 0) < READY_GRACE_MS;
    if (!fromRef || !toRef || (!conditionMet(toRef / fromRef, intent.triggerRatio, intent.direction) && !inGrace))
      throw new Error("The trigger condition no longer holds");
    const checks = this.marketChecks(intent.from, intent.to, intent.limits, intent.mode);
    checks.push(await this.balanceCheck(intent, true));
    const first = await this.quoteSwitch(intent.from, intent.to, BigInt(intent.amountRaw), "confirm", 50, true);
    checks.push(this.quoteCheck(first.summary, intent.limits));
    const failing = checks.find((c) => !c.ok);
    if (failing) throw new Error(`${failing.label}: ${failing.detail}`);
    const budget = Math.max(10, Math.min(100, Math.floor(intent.limits.maxSlippageBps - Math.max(0, first.summary.shortfallBps))));
    const fresh = await this.quoteSwitch(intent.from, intent.to, BigInt(intent.amountRaw), "confirm", budget, true);
    const tx = await getSwapTransaction(fresh.raw, intent.owner);
    this.quotes.set(intent.id, fresh);
    return { tx, quote: fresh.summary };
  }

  async recordConfirmed(intent: Intent, signature: string) {
    const q = (intent.kind === "fair" ? this.fairQuotes.get(intent.id) : this.quotes.get(intent.id))?.summary;
    const dst = legAsset(intent.to);
    const got = await receivedRaw(signature, ata(new PublicKey(intent.owner), dst.mint));
    const outUi = got !== undefined ? uiFromRaw(got, dst.decimals, this.tokens.multiplier(intent.to)) : (q?.outUi ?? 0);
    intent.status = "executed";
    intent.execution = {
      at: Date.now(),
      paper: false,
      signature,
      ratio: intent.lastEval?.ratio ?? intent.triggerRatio,
      inUi: q?.inUi ?? intent.amountUi,
      outUi,
      fairOutUi: q?.fairOutUi ?? outUi,
      shortfallBps: q ? netShortfall(outUi, q) : 0,
      route: q?.route ?? "Jupiter",
      ...(q && intent.kind !== "fair" ? this.receiptExtras(intent, q) : {}),
    };
    const pic = this.fairPics.get(intent.id);
    if (intent.kind === "fair" && q && pic) intent.execution = { ...intent.execution, feeBps: q.feeBps, expectedOutUi: q.outUi, fair: this.fairFill(intent, pic, q.inUi, outUi) };
    store.event(intent, "success", `Confirmed: ${fmtNum(intent.execution.inUi)} ${intent.from} -> ${fmtNum(outUi)} ${intent.to}`);
    store.touch();
  }

  // ---- fair-price orders -------------------------------------------------------

  /** Quote a fair-price order at its real size: USDC to the stock (buy) or the stock to USDC (sell). */
  async quoteFair(side: Side, asset: string, amountRaw: bigint, style: ExecStyle, slippageBps = 50, fresh = false) {
    const stock = getAsset(asset);
    const from = side === "buy" ? USDC : stock;
    const to = side === "buy" ? stock : USDC;
    const mult = this.tokens.multiplier(asset);
    const fee = this.tokens.feeBps(asset) / 10_000; // PreStocks 1% per transfer, xStocks 0
    const pull = style === "auto";
    // A sell pays the stock's transfer fee on the way into the pool, which Jupiter's quote leaves out (see quoteSwitch).
    const srcFeeBps = side === "sell" ? this.tokens.feeBps(asset) : 0;
    const pullFee = pull && side === "sell" ? this.tokens.feeFor(asset, amountRaw) : 0n;
    const raw = await getQuote(from.mint, to.mint, amountRaw - pullFee, slippageBps + srcFeeBps, fresh);
    const inUi = uiFromRaw(amountRaw, from.decimals, side === "sell" ? mult : 1);
    const outUi = uiFromRaw(raw.outAmount, to.decimals, side === "buy" ? mult : 1) * (1 - srcFeeBps / 10_000);
    const dex = this.prices.dexPrice(asset) ?? this.prices.token(asset)?.price;
    if (!dex) throw new Error("Missing token price");
    const fairOutUi = side === "buy" ? inUi / dex : inUi * dex;
    const feeFactor = side === "buy" ? 1 - fee : (pull ? 1 - fee : 1) * (1 - fee);
    const summary: QuoteSummary = {
      at: Date.now(),
      inUi,
      outUi,
      fairOutUi,
      shortfallBps: shortfallBps(outUi, fairOutUi * feeFactor),
      feeBps: (1 - feeFactor) * 10_000,
      priceImpactPct: Number(raw.priceImpactPct) * 100,
      route: routeLabel(raw),
    };
    return { summary, raw, eff: effectivePrice(side, inUi, outUi) };
  }

  /** Session, reference, effective price and premium for a fair order right now. */
  fairPicture(spec: FairSpec, eff: number): FairPicture | undefined {
    const ref = this.prices.ref(spec.asset);
    if (!ref) return undefined;
    const kind = getAsset(spec.asset).kind;
    const open = !!this.prices.quote(spec.asset).marketOpen;
    // Unknown market hours count as closed, so they need the off-hours opt-in rather than slipping through.
    const offHours = kind === "xstock" && !open;
    return {
      session: sessionOf(kind, open, Date.now() / 1000),
      ref: { source: this.prices.refSource(spec.asset), price: ref.price, ageSec: age(ref.publishTime) },
      effPrice: eff,
      premiumBps: premiumBps(eff, ref.price),
      limitBps: activeLimit(spec, offHours),
    };
  }

  /** Checks for a fair order. "price" is the condition itself; every other check can refuse a fill. */
  fairChecks(spec: FairSpec, pic: FairPicture | undefined, limits: Limits, mode: Mode): Check[] {
    const kind = getAsset(spec.asset).kind;
    const src = this.prices.refSource(spec.asset);
    const ref = this.prices.ref(spec.asset);
    const q = this.prices.quote(spec.asset);
    const srcName = src === "pyth" ? "Pyth" : src === "prestocks" ? "PreStocks mark" : src === "jupiter" ? "Backed via Jupiter" : "loading";
    const trusted = src === "pyth" || src === "prestocks";
    const checks: Check[] = [
      {
        id: "source",
        label: "Trusted reference price",
        ok: trusted || mode === "paper",
        detail: `${spec.asset}: ${srcName}` + (trusted ? "" : mode === "paper" ? " (paper only)" : " - live needs Pyth or PreStocks prices"),
      },
    ];
    const ageSec = ref ? age(ref.publishTime) : Infinity;
    const ageText = Number.isFinite(ageSec) ? fmtAge(ageSec) : "n/a";
    if (kind === "xstock" && !q.marketOpen) {
      const reopens = q.nextOpen ? `, reopens ${new Date(q.nextOpen * 1000).toUTCString().slice(0, 22)} UTC` : "";
      checks.push({
        id: "market",
        label: "Off-hours fill allowed",
        ok: spec.offHours.allowed,
        detail: spec.offHours.allowed
          ? `Market closed${reopens}. Priced against the last real price, limit ${spec.offHours.limitBps} bps`
          : `Market closed${reopens}. This order fills in regular hours only`,
      });
      checks.push({ id: "fresh", label: "Last real price", ok: ageSec <= OFF_HOURS_REF_MAX_SEC, detail: `${ageText} old (max ${fmtAge(OFF_HOURS_REF_MAX_SEC)})` });
      if (src === "pyth") checks.push({ id: "confidence", label: "Pyth confidence tight", ok: true, detail: "Not used off-hours" });
    } else {
      const maxAge =
        src === "jupiter" && mode === "paper" ? Math.max(limits.maxStalenessSec, 900) : src === "prestocks" ? Math.max(limits.maxStalenessSec, 180) : limits.maxStalenessSec;
      checks.push({ id: "fresh", label: "Reference price fresh", ok: ageSec <= maxAge, detail: `${spec.asset} ${ageText} (max ${fmtAge(maxAge)})` });
      if (src === "pyth") {
        const conf = ref && ref.price ? (ref.conf / ref.price) * 10_000 : Infinity;
        checks.push({ id: "confidence", label: "Pyth confidence tight", ok: conf <= limits.maxConfBps, detail: `±${Number.isFinite(conf) ? conf.toFixed(1) : "?"} bps (max ${limits.maxConfBps})` });
      }
    }
    const corp = this.tokens.corporateActionNear(spec.asset, limits.corporateActionWindowHours);
    checks.push({
      id: "corporate",
      label: "No corporate action in flight",
      ok: !corp.near,
      detail: corp.near ? `Multiplier changes ${new Date(corp.at! * 1000).toUTCString().slice(0, 22)}` : "Multiplier stable",
    });
    checks.push({ id: "paused", label: "Token not paused", ok: !q.paused, detail: q.paused ? "Paused by issuer" : "Transfers enabled" });
    if (pic) {
      const verb = spec.side === "buy" ? "Pays" : "Gets";
      const limitText = pic.limitBps === null ? "no fills this session" : `limit ${fmtLimit(spec.side, pic.limitBps)}`;
      checks.push({
        id: "price",
        label: "Price vs real stock",
        ok: pic.limitBps !== null && fairConditionMet(spec.side, pic.premiumBps, pic.limitBps),
        detail: `${verb} $${pic.effPrice.toFixed(2)} vs $${pic.ref.price.toFixed(2)} real (${fmtBps(pic.premiumBps)}), ${limitText}, ${pic.session}`,
      });
    }
    return checks;
  }

  private async evaluateFair(intent: Intent) {
    const spec = intent.fair!;
    if (Date.now() > intent.expiresAt) {
      intent.status = "expired";
      store.event(intent, "warn", "Expired before the price came within the limit");
      store.touch();
      return;
    }
    // Re-quote the real order size at most every FAIR_QUOTE_MS. Each new passing quote is one confirmation:
    // references barely move off-hours, so counting reference ticks would never confirm.
    const prev = intent.lastEval;
    let q = this.fairQuotes.get(intent.id);
    let quoteErr: string | undefined;
    let freshQuote = false;
    if (!q || Date.now() - q.summary.at >= FAIR_QUOTE_MS) {
      try {
        q = await this.quoteFair(spec.side, spec.asset, BigInt(intent.amountRaw), intent.style);
        this.fairQuotes.set(intent.id, q);
        freshQuote = true;
      } catch (e) {
        quoteErr = (e as Error).message;
      }
    }
    const pic = q ? this.fairPicture(spec, q.eff) : undefined;
    const checks = this.fairChecks(spec, pic, intent.limits, intent.mode);
    checks.push(this.quoteCheck(q?.summary, intent.limits, quoteErr));
    const met = checks.find((c) => c.id === "price")?.ok ?? false;
    if (intent.mode === "live") checks.push(intent.style === "auto" ? await this.delegationCheck(intent, met) : await this.balanceCheck(intent, met));
    const failing = checks.find((c) => c.id !== "price" && !c.ok);
    const streak = !met ? 0 : freshQuote ? (prev?.conditionMet ? prev.streak + 1 : 1) : (prev?.streak ?? 0);
    intent.lastEval = {
      at: Date.now(),
      ratio: q?.eff ?? 0,
      changePct: (pic?.premiumBps ?? 0) / 100,
      progress: met ? 1 : 0,
      conditionMet: met,
      streak,
      checks,
      blockedBy: met ? failing?.label : undefined,
      quote: q?.summary,
      fair: pic,
    };
    store.touch();

    if (intent.status === "ready") {
      // The limit is a hard line, so a one-tap fair order gets no grace: it goes back to watching.
      if (failing || !met) {
        intent.status = "armed";
        store.event(intent, "warn", `No longer ready (${failing ? failing.label : "price moved past your limit"}); back to watching`);
      }
      return;
    }
    if (met && failing) this.refuse(intent, failing.id, `${failing.label}: ${failing.detail}`, pic);
    if (met && !failing && streak < intent.limits.confirmations)
      store.event(intent, "info", `Price within your limit (${streak}/${intent.limits.confirmations} quotes)`);
    if (met && !failing && streak >= intent.limits.confirmations && q && pic) await this.executeFair(intent, q, pic);
  }

  /**
   * A fresh quote whose on-chain minimum-out enforces the user's limit, never looser than the slippage
   * budget. Throws a Refusal when the price has moved past the limit since the last check.
   */
  private async limitQuote(intent: Intent) {
    const spec = intent.fair!;
    const first = await this.quoteFair(spec.side, spec.asset, BigInt(intent.amountRaw), intent.style, 50, true);
    const pic = this.fairPicture(spec, first.eff);
    if (!pic) throw new Refusal("Reference price: missing");
    if (pic.limitBps === null) throw new Refusal("Off-hours fill allowed: market closed and this order fills in regular hours only");
    if (!fairConditionMet(spec.side, pic.premiumBps, pic.limitBps))
      throw new Refusal(`Price vs real stock: moved to ${fmtBps(pic.premiumBps)}, limit ${fmtLimit(spec.side, pic.limitBps)}`);
    const minOut = limitMinOutUi(spec.side, first.summary.inUi, pic.ref.price, pic.limitBps);
    const budget = Math.max(10, Math.min(100, Math.floor(intent.limits.maxSlippageBps - Math.max(0, first.summary.shortfallBps))));
    const slip = slippageForLimit(first.summary.outUi, minOut, budget);
    if (slip < 1) throw new Refusal("Price vs real stock: no room left under your limit");
    const fresh = await this.quoteFair(spec.side, spec.asset, BigInt(intent.amountRaw), intent.style, slip, true);
    return { fresh, pic: this.fairPicture(spec, fresh.eff) ?? pic, slip };
  }

  /**
   * Log a refusal with the price picture behind it (these feed /proof). Detail text changes every tick,
   * so the same check on the same order is logged at most every REFUSAL_EVERY_MS.
   */
  private refuse(intent: Intent, key: string, message: string, pic?: FairPicture, always = false) {
    const k = `${intent.id}|${key}`;
    if (!always && Date.now() - (this.lastRefusal.get(k) ?? 0) < REFUSAL_EVERY_MS) return;
    this.lastRefusal.set(k, Date.now());
    const snapshot = pic ? { price: pic.ref.price, source: pic.ref.source, ageSec: pic.ref.ageSec, premiumBps: Math.round(pic.premiumBps * 10) / 10, session: pic.session } : undefined;
    store.event(intent, "warn", `Refused: ${message}`, snapshot);
  }

  private fairFill(intent: Intent, pic: FairPicture, inUi: number, outUi: number): FairFill {
    const spec = intent.fair!;
    const eff = effectivePrice(spec.side, inUi, outUi);
    return { ...pic, effPrice: eff, premiumBps: premiumBps(eff, pic.ref.price), side: spec.side, asset: spec.asset };
  }

  private async executeFair(intent: Intent, q: FairQuote, pic: FairPicture) {
    const spec = intent.fair!;
    const verb = spec.side === "buy" ? "Bought" : "Sold";
    if (intent.mode === "paper") {
      intent.status = "executed";
      intent.execution = {
        at: Date.now(),
        paper: true,
        ratio: q.eff,
        ...pick(q.summary),
        feeBps: q.summary.feeBps,
        expectedOutUi: q.summary.outUi,
        fair: this.fairFill(intent, pic, q.summary.inUi, q.summary.outUi),
      };
      store.event(intent, "success", `Paper: ${verb.toLowerCase()} ${spec.asset} at $${q.eff.toFixed(2)} vs $${pic.ref.price.toFixed(2)} real (${fmtBps(pic.premiumBps)})`);
      store.touch();
      return;
    }
    if (intent.style === "confirm") {
      intent.status = "ready";
      intent.readyAt = Date.now();
      store.event(intent, "success", "Ready: the price is within your limit. Confirm in your wallet.");
      store.touch();
      return;
    }
    if (!config.keeper || !config.liveExecution) {
      store.event(intent, "warn", "Live execution is disabled on this server");
      return;
    }
    if (this.busy) return; // one keeper transaction at a time
    this.busy = true;
    intent.status = "executing";
    store.event(intent, "info", "Price confirmed within your limit - executing");
    store.touch();
    try {
      const delegation = await this.delegationCheck(intent, true);
      if (!delegation.ok) throw new Error(delegation.detail);
      const { fresh, pic: now } = await this.limitQuote(intent);
      const owner = new PublicKey(intent.owner);
      const { tx, blockhash, lastValidBlockHeight, ownerDst } = await buildSwitchTx(config.keeper, owner, intent.from, intent.to, BigInt(intent.amountRaw), fresh.raw);
      const sig = await sendAndConfirm(tx, blockhash, lastValidBlockHeight);
      const dst = legAsset(intent.to);
      const got = await receivedRaw(sig, ownerDst);
      const outUi = got !== undefined ? uiFromRaw(got, dst.decimals, this.tokens.multiplier(intent.to)) : fresh.summary.outUi;
      const fill = this.fairFill(intent, now, fresh.summary.inUi, outUi);
      intent.status = "executed";
      intent.execution = {
        at: Date.now(),
        paper: false,
        signature: sig,
        ratio: fill.effPrice,
        ...pick(fresh.summary),
        outUi,
        shortfallBps: netShortfall(outUi, fresh.summary),
        feeBps: fresh.summary.feeBps,
        expectedOutUi: fresh.summary.outUi,
        fair: fill,
      };
      store.event(intent, "success", `${verb} ${spec.asset} at $${fill.effPrice.toFixed(2)} vs $${fill.ref.price.toFixed(2)} real (${fmtBps(fill.premiumBps)})`);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      if (e instanceof Refusal) {
        // Not a failure: the price moved past the limit between the check and the fill. Back to watching.
        intent.status = "armed";
        intent.lastEval = { ...intent.lastEval!, streak: 0, conditionMet: false };
        this.refuse(intent, "moved", msg, intent.lastEval?.fair, true);
      } else {
        const n = (this.attempts.get(intent.id) ?? 0) + 1;
        this.attempts.set(intent.id, n);
        if (n >= MAX_LIVE_ATTEMPTS) {
          intent.status = "failed";
          intent.execution = { at: Date.now(), paper: false, ratio: q.eff, ...pick(q.summary), error: msg };
          store.event(intent, "error", `Order failed after ${n} attempts: ${msg}`);
        } else {
          intent.status = "armed";
          intent.lastEval = { ...intent.lastEval!, streak: 0, conditionMet: false };
          store.event(intent, "warn", `Attempt ${n} failed, back to watching: ${msg}`);
        }
      }
    } finally {
      this.busy = false;
      store.touch();
    }
  }

  /** One-tap fair order: re-check the limit on a fresh quote, then hand back the swap for the owner to sign. */
  private async buildConfirmTxFair(intent: Intent): Promise<{ tx: string; quote: QuoteSummary }> {
    if (intent.status !== "ready") throw new Error("This order is not ready");
    const { fresh, pic } = await this.limitQuote(intent).catch((e) => {
      if (e instanceof Refusal) this.refuse(intent, "moved", e.message, intent.lastEval?.fair, true);
      throw e;
    });
    const checks = this.fairChecks(intent.fair!, pic, intent.limits, intent.mode);
    checks.push(await this.balanceCheck(intent, true), this.quoteCheck(fresh.summary, intent.limits));
    const failing = checks.find((c) => !c.ok);
    if (failing) {
      this.refuse(intent, failing.id, `${failing.label}: ${failing.detail}`, pic, true);
      throw new Error(`${failing.label}: ${failing.detail}`);
    }
    const tx = await getSwapTransaction(fresh.raw, intent.owner);
    this.fairQuotes.set(intent.id, fresh);
    this.fairPics.set(intent.id, pic);
    return { tx, quote: fresh.summary };
  }
}

const netShortfall = (outUi: number, s: QuoteSummary) => shortfallBps(outUi, s.fairOutUi * (1 - s.feeBps / 10_000));

const pick = (s: QuoteSummary) => ({ inUi: s.inUi, outUi: s.outUi, fairOutUi: s.fairOutUi, shortfallBps: s.shortfallBps, route: s.route });
