import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ArrowsLeftRight, Check, ShieldCheck, Wallet } from "@phosphor-icons/react";
import { ASSET_BY_TICKER, tokenSymbol } from "../../shared/assets";
import { fmtUsd } from "../../shared/math";
import { intentMessage } from "../../shared/messages";
import { DEFAULT_LIMITS, PRE_IPO_SLIPPAGE_BPS, canonicalDraft, type IntentDraft, type Mode } from "../../shared/types";
import { api, type Preview } from "../api";
import { AssetPicker } from "../components/AssetPicker";
import { ChecksList } from "../components/Checks";
import { NumberField } from "../components/NumberField";
import { PairChart } from "../components/PairChart";
import { useDebounced, usePoll } from "../lib/hooks";
import { b64, useAppData } from "../state/AppData";

const INITIAL: IntentDraft = {
  from: "OPENAI",
  to: "ANTHROPIC",
  sizing: { kind: "usd", usd: 100 },
  direction: "cheaper",
  thresholdPct: 10,
  mode: "paper",
  limits: DEFAULT_LIMITS,
  expiresInDays: 7,
};

const SOURCE_NAMES = { pyth: "Pyth", prestocks: "PreStocks marks", jupiter: "Backed via Jupiter" } as const;
const ORDER = ["pyth", "prestocks", "jupiter"] as const;

/** Start from ?to= (and optionally ?from=, ?pct=, ?usd=) when arriving from Markets or the landing page. */
function initialDraft(params: URLSearchParams): IntentDraft {
  const to = params.get("to")?.toUpperCase();
  if (!to || !ASSET_BY_TICKER[to]) return INITIAL;
  let from = params.get("from")?.toUpperCase();
  // Pre-IPO targets default to a pre-IPO source so the pair is live around the clock.
  const fallback = ASSET_BY_TICKER[to].kind === "prestock" ? (to === "OPENAI" ? "ANTHROPIC" : "OPENAI") : to === "TSLA" ? "QQQ" : "TSLA";
  if (!from || !ASSET_BY_TICKER[from] || from === to) from = fallback;
  const pct = Number(params.get("pct")) > 0 ? Number(params.get("pct")) : INITIAL.thresholdPct;
  const usd = Number(params.get("usd")) > 0 ? Number(params.get("usd")) : 100;
  return { ...INITIAL, from, to, thresholdPct: pct, sizing: { kind: "usd", usd } };
}

const amountOf = (d: IntentDraft) => (d.sizing.kind === "usd" ? d.sizing.usd : d.sizing.shares);

/** What stops a draft from being previewed or created, in the words shown under the form. */
function problem(d: IntentDraft): string | null {
  if (d.from === d.to) return "Pick two different assets.";
  if (!(amountOf(d) > 0)) return "Enter an amount above zero.";
  if (!Number.isFinite(d.thresholdPct)) return "Enter a trigger percentage.";
  if (!Number.isFinite(d.expiresInDays) || Object.values(d.limits).some((v) => !Number.isFinite(v))) return "Fill in every limit.";
  return null;
}

const age = (t?: number) => {
  if (!t) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
};

/** The switch builder. Embedded inside the order page as its Switch tab, without its own page header. */
export function NewSwitch({ embedded = false }: { embedded?: boolean }) {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { owner, status, market, say } = useAppData();

  const [draft, setDraft] = useState<IntentDraft>(() => initialDraft(params));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFor, setPreviewFor] = useState<IntentDraft | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const previewSeq = useRef(0);
  const [series, setSeries] = useState<{ t: number; r: number }[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (params.get("to")) setDraft(initialDraft(params));
  }, [params]);

  // Live preview: baseline, trigger, checks, executable quote
  const debouncedDraft = useDebounced(draft, 300);
  const refreshPreview = useCallback(() => {
    const d = debouncedDraft;
    if (problem(d)) return;
    const n = ++previewSeq.current;
    api
      .preview(d, owner)
      .then((p) => {
        if (n !== previewSeq.current) return;
        setPreview(p);
        setPreviewFor(d);
        setPreviewErr(null);
      })
      .catch((e) => n === previewSeq.current && setPreviewErr(e.message));
  }, [debouncedDraft, owner]);
  usePoll(refreshPreview, 10_000, [refreshPreview]);
  usePoll(() => api.pair(draft.from, draft.to).then((r) => setSeries(r.series)).catch(() => {}), 30_000, [draft.from, draft.to]);

  const style = preview?.style ?? (ASSET_BY_TICKER[draft.from]?.kind === "prestock" ? "confirm" : "auto");
  const liveReady = Boolean(
    status?.liveEnabled && (style === "confirm" || status.autoEnabled) && wallet.connected && wallet.signMessage && wallet.signTransaction,
  );
  const mode: Mode = draft.mode === "live" && liveReady ? "live" : draft.mode;
  const set = (patch: Partial<IntentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // Pre-IPO pools are thinner: use the wider slippage default for them unless the user set their own.
  const slippageTouched = useRef(false);
  const preIpo = ASSET_BY_TICKER[draft.from]?.kind === "prestock" || ASSET_BY_TICKER[draft.to]?.kind === "prestock";
  useEffect(() => {
    if (slippageTouched.current) return;
    const want = preIpo ? PRE_IPO_SLIPPAGE_BPS : DEFAULT_LIMITS.maxSlippageBps;
    setDraft((d) => (d.limits.maxSlippageBps === want ? d : { ...d, limits: { ...d.limits, maxSlippageBps: want } }));
  }, [preIpo]);
  const allPass = preview?.checks.every((c) => c.ok) ?? false;
  const invalid = problem(draft);
  // The plan and checks describe the last previewed draft; until they catch up with the form, they're dimmed and Create waits.
  const stale = Boolean(invalid || previewErr || !preview || previewFor !== draft);

  // Names, prices and wording for the form
  const fromA = ASSET_BY_TICKER[draft.from];
  const toA = ASSET_BY_TICKER[draft.to];
  const q = (t: string) => market?.assets.find((a) => a.ticker === t);
  // Amounts in USD convert at the price the token trades at, not the reference mark.
  const fq = q(draft.from);
  const fromPx = fq?.dex ?? fq?.token?.price ?? fq?.ref?.price;
  const amount = amountOf(draft);
  const unitWord = fromA.kind === "prestock" ? "units" : "shares";
  const meta = (t: string) => {
    const a = q(t);
    if (!a?.token) return " ";
    const vs = ASSET_BY_TICKER[t].kind === "prestock" ? "vs mark" : "vs stock";
    const p = a.pegBps === undefined ? "" : ` · ${a.pegBps >= 0 ? "+" : ""}${(a.pegBps / 100).toFixed(1)}% ${vs}`;
    return `${fmtUsd(a.token.price)}${p}`;
  };
  const sizeText = !Number.isFinite(amount)
    ? "…"
    : draft.sizing.kind === "usd"
      ? fmtUsd(amount, amount % 1 ? 2 : 0)
      : `${amount} ${unitWord}`;
  const amountText = draft.sizing.kind === "usd" ? `${sizeText} of ${fromA.name}` : `${Number.isFinite(amount) ? amount : "…"} ${fromA.name} ${unitWord}`;
  const pctText = Number.isFinite(draft.thresholdPct) ? draft.thresholdPct : "…";
  const sentence =
    draft.direction === "cheaper"
      ? `Move ${amountText} into ${toA.name} when ${toA.name} becomes ${pctText}% cheaper relative to ${fromA.name}.`
      : `Move ${amountText} into ${toA.name} when ${toA.name} outperforms ${fromA.name} by ${pctText}%.`;

  // Switching USD <-> units converts the amount so the trade size stays the same.
  function setUnit(kind: "usd" | "shares") {
    if (kind === draft.sizing.kind) return;
    if (!fromPx || !(amount > 0)) return set({ sizing: kind === "usd" ? { kind, usd: 100 } : { kind, shares: 1 } });
    if (kind === "shares") set({ sizing: { kind, shares: Number((amount / fromPx).toFixed(4)) } });
    else set({ sizing: { kind, usd: Number((amount * fromPx).toFixed(2)) } });
  }
  const amountHelp =
    !fromPx || !(amount > 0)
      ? " "
      : draft.sizing.kind === "usd"
        ? `About ${(amount / fromPx).toFixed(4)} ${fromA.name} ${unitWord} at the market price`
        : `About ${fmtUsd(amount * fromPx)} at the market price`;

  async function create() {
    setCreating(true);
    try {
      const full: IntentDraft = { ...draft, mode, text: sentence, limits: { ...DEFAULT_LIMITS, ...draft.limits } };
      if (mode === "paper") {
        await api.create({ draft: full, owner });
        say("Paper switch created. Track it in My switches.");
        navigate("/app/orders");
        return;
      }
      const pk = wallet.publicKey!.toBase58();
      const ts = Date.now();
      const sig = await wallet.signMessage!(new TextEncoder().encode(intentMessage(pk, canonicalDraft(full), ts)));
      const { intent, approvalTx } = await api.create({ draft: full, owner: pk, ts, signature: bs58.encode(sig) });
      if (!approvalTx) {
        if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
        say("Live switch created. When it triggers and every check passes, you'll confirm in one tap.");
        navigate("/app/orders");
        return;
      }
      say("Approve the exact amount in your wallet. Your tokens stay with you until the switch.");
      const signed = await wallet.signTransaction!(VersionedTransaction.deserialize(Buffer.from(approvalTx, "base64")));
      await api.confirm(intent.id, b64(signed));
      say("Live switch created. Approval confirmed on-chain.");
      navigate("/app/orders");
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setCreating(false);
    }
  }

  const digits = preview && preview.ratio < 1 ? 5 : 4;
  // Name the reference sources actually behind this pair.
  const srcOf = (t: string) => q(t)?.sources?.ref;
  const pairSources = new Set([srcOf(draft.from), srcOf(draft.to)]);
  const refLabel =
    ORDER.filter((k) => pairSources.has(k))
      .map((k) => SOURCE_NAMES[k])
      .join(" + ") || "loading prices";
  const fmtMove = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
  const quote = preview?.quote;
  const costPct = quote ? (quote.feeBps + Math.max(0, quote.shortfallBps)) / 100 : undefined;
  const leftPct = preview && costPct !== undefined ? preview.draft.thresholdPct - costPct : undefined;
  const outNow = quote ? quote.outUi : preview?.outNow;
  const outAtTrigger = preview && outNow !== undefined ? outNow * (preview.ratio / preview.trigger) : undefined;
  const chg = outNow && outAtTrigger ? ((outAtTrigger / outNow - 1) * 100).toFixed(1) : "";

  // Plain-word summaries for passing check groups
  const oldest = Math.max(...[draft.from, draft.to].map((t) => (q(t)?.ref ? Date.now() / 1000 - q(t)!.ref!.publishTime : 0)));
  const summaries = {
    "Reference data": `${refLabel}, ${age(Date.now() / 1000 - oldest)} old`,
    Asset: "Near reference prices",
    Execution: quote
      ? `${(Math.max(0, quote.shortfallBps) / 100).toFixed(1)}% slippage, limit ${(draft.limits.maxSlippageBps / 100).toFixed(1)}%`
      : "Quoting",
  };

  const grid = (
      <div className="grid">
        <div className="stack">
          <section className="card builder">
            <div className="card-pad builder-body">
              <div className="pair-row">
                <div className="field">
                  <label htmlFor="from">From</label>
                  <AssetPicker id="from" value={draft.from} other={draft.to} market={market} onChange={(t) => set({ from: t })} />
                  <div className="field-help num">{meta(draft.from)}</div>
                </div>
                <button type="button" className="flip" aria-label="Swap from and to" onClick={() => set({ from: draft.to, to: draft.from })}>
                  <ArrowsLeftRight size={18} weight="bold" />
                </button>
                <div className="field">
                  <label htmlFor="to">To</label>
                  <AssetPicker id="to" value={draft.to} other={draft.from} market={market} onChange={(t) => set({ to: t })} />
                  <div className="field-help num">{meta(draft.to)}</div>
                </div>
              </div>

              <div className="terms-row">
                <div className="field">
                  <label htmlFor="amount">Amount</label>
                  <div className="control-row">
                    <span className="seg big" role="group" aria-label="Amount unit">
                      <button type="button" className={draft.sizing.kind === "usd" ? "on" : ""} onClick={() => setUnit("usd")}>
                        USD
                      </button>
                      <button type="button" className={draft.sizing.kind === "shares" ? "on" : ""} onClick={() => setUnit("shares")}>
                        {unitWord === "units" ? "Units" : "Shares"}
                      </button>
                    </span>
                    <NumberField
                      id="amount"
                      className="text-input num"
                      value={amount}
                      onChange={(n) => set({ sizing: draft.sizing.kind === "usd" ? { kind: "usd", usd: n } : { kind: "shares", shares: n } })}
                    />
                  </div>
                  <div className="field-help">{amountHelp}</div>
                </div>
                <div className="field">
                  <label htmlFor="pct">Condition</label>
                  <div className="control-row">
                    <span className="cond-name">{toA.name}</span>
                    <span className="seg big" role="group" aria-label="Direction">
                      <button type="button" className={draft.direction === "cheaper" ? "on" : ""} onClick={() => set({ direction: "cheaper" })}>
                        gets cheaper
                      </button>
                      <button type="button" className={draft.direction === "richer" ? "on" : ""} onClick={() => set({ direction: "richer" })}>
                        outperforms
                      </button>
                    </span>
                    <span className="pct-input">
                      <NumberField id="pct" className="num" min={0} max={50} value={draft.thresholdPct} onChange={(n) => set({ thresholdPct: n })} />
                      <span>%</span>
                    </span>
                  </div>
                  <div className="field-help">
                    Relative to {fromA.name}, measured from today's {refLabel}
                  </div>
                </div>
              </div>

              <div className="summary-line">
                <Check size={18} weight="bold" />
                <p>{sentence}</p>
              </div>
              {invalid && <p className="hint bad">{invalid}</p>}
              {previewErr && !invalid && <p className="hint bad">{previewErr}</p>}
              {preview?.thinTrigger !== undefined && !invalid && (
                <p className="hint warn">
                  Fees and spread on this route are about {preview.thinTrigger.toFixed(1)}%, which would eat most of a {preview.draft.thresholdPct}% move. Consider a
                  trigger of {Math.ceil(preview.thinTrigger * 2)}% or more.
                </p>
              )}
            </div>

            <div className={`plan four${stale ? " stale" : ""}`} aria-busy={stale}>
              <div>
                <div className="k">Switch fires at</div>
                <div className="v">
                  {preview ? fmtMove(preview.draft.direction === "cheaper" ? -preview.draft.thresholdPct : preview.draft.thresholdPct) : <span className="skeleton" style={{ display: "block", height: 24 }} />}
                </div>
                <div className="s">
                  {preview ? `${toA.name} vs ${fromA.name}, from today. Ratio ${preview.ratio.toFixed(digits)} to ${preview.trigger.toFixed(digits)}` : " "}
                </div>
              </div>
              <div>
                <div className="k">Costs on this route</div>
                <div className="v">{costPct !== undefined ? `${costPct.toFixed(1)}%` : <span className="skeleton" style={{ display: "block", height: 24 }} />}</div>
                <div className="s">
                  {quote
                    ? quote.feeBps > 0
                      ? `${(quote.feeBps / 100).toFixed(1)}% PreStocks transfer fees + ${(Math.max(0, quote.shortfallBps) / 100).toFixed(1)}% spread`
                      : `Spread and price impact at today's liquidity`
                    : " "}
                </div>
              </div>
              <div>
                <div className="k">Left after costs</div>
                <div className={`v ${leftPct !== undefined && leftPct <= 0 ? "neg" : ""}`}>
                  {leftPct !== undefined ? `${leftPct.toFixed(1)}%` : <span className="skeleton" style={{ display: "block", height: 24 }} />}
                </div>
                <div className="s">{leftPct !== undefined ? (leftPct > 0 ? "Of the move, once it fires" : "Costs would exceed the move") : " "}</div>
              </div>
              <div>
                <div className="k">You would receive</div>
                <div className="v">
                  {preview && outAtTrigger !== undefined ? (
                    <>
                      {outAtTrigger.toFixed(4)}
                      <span className="unit">{preview.draft.to}</span>
                    </>
                  ) : (
                    <span className="skeleton" style={{ display: "block", height: 24 }} />
                  )}
                </div>
                <div className="s">
                  {preview && outNow !== undefined
                    ? `vs ${outNow.toFixed(4)} today (${Number(chg) >= 0 ? "+" : ""}${chg}%)${quote ? ", after fees" : ""}`
                    : " "}
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                {toA.name} priced in {fromA.name}
              </h2>
              <span className="sub">Priced by {refLabel}. Shaded area is where the switch fires.</span>
            </div>
            <PairChart series={series} from={draft.from} to={draft.to} baseline={preview?.ratio} trigger={preview?.trigger} direction={draft.direction} />
          </section>
        </div>

        <aside className="card">
          <div className="card-head">
            <h2>Safety checks</h2>
            <span className="sub">{preview ? (allPass ? "Checked now and again when it fires" : "Blocking now, re-checked continuously") : "Loading"}</span>
          </div>
          <ChecksList checks={preview?.checks} loading={!preview} summaries={summaries} />
          <div className="side-actions">
            <div className="mode" role="group" aria-label="Execution mode">
              <button className={mode === "paper" ? "on" : ""} onClick={() => set({ mode: "paper" })}>
                Paper
              </button>
              <button className={mode === "live" ? "on" : ""} onClick={() => set({ mode: "live" })} disabled={!status?.liveEnabled}>
                Live
              </button>
            </div>
            {mode === "paper" ? (
              <div className="callout paper">
                <strong>Paper mode</strong>
                Live market data and the same checks and quotes. No funds move.
              </div>
            ) : (
              <div className="callout live">
                <strong>Live: real tokens move when it fires</strong>
                Up to {sizeText} of {tokenSymbol(draft.from)}.{" "}
                {style === "confirm"
                  ? `${fromA.name} charges a 1% transfer fee, so it stays in your wallet until you confirm in one tap.`
                  : `You approve the exact amount once; it stays in your wallet until the switch fires.`}
              </div>
            )}
            {draft.mode === "live" && !liveReady && (
              <p className="hint warn">
                {!status?.liveEnabled
                  ? "Live switching is disabled on this server."
                  : style === "auto" && !status.autoEnabled
                    ? `Automatic switching unavailable: ${status.liveBlockers.join(", ")}.`
                    : "Connect a wallet that can sign messages and transactions."}
              </p>
            )}

            <details className="advanced limits-line">
              <summary>
                Max slippage {(draft.limits.maxSlippageBps / 100).toFixed(1)}% after fees, expires in {draft.expiresInDays} days. <span className="edit">Edit</span>
              </summary>
              <div className="limits">
                {(
                  [
                    ["maxSlippageBps", "Max slippage after fees (bps)"],
                    ["maxPegDeviationBps", "xStock premium limit (bps)"],
                    ["maxPrivatePremiumBps", "Pre-IPO premium limit (bps)"],
                    ["maxStalenessSec", "Max price age (s)"],
                    ["maxConfBps", "Max Pyth confidence (bps)"],
                    ["confirmations", "Confirmations"],
                    ["corporateActionWindowHours", "Corporate action window (h)"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k}>
                    {label}
                    <NumberField
                      min={k === "confirmations" ? 1 : 0}
                      value={draft.limits[k]}
                      onChange={(n) => {
                        if (k === "maxSlippageBps") slippageTouched.current = true;
                        setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: n } }));
                      }}
                    />
                  </label>
                ))}
                <label>
                  Expires after (days)
                  <NumberField min={1} max={90} value={draft.expiresInDays} onChange={(n) => set({ expiresInDays: n })} />
                </label>
              </div>
            </details>

            <button className="btn btn-primary" onClick={create} disabled={stale || creating || (draft.mode === "live" && !liveReady)}>
              {mode === "live" ? <Wallet size={18} weight="bold" /> : <ShieldCheck size={18} weight="bold" />}
              {creating ? "Creating" : mode === "live" ? "Create live switch" : "Create paper switch"}
            </button>
          </div>
        </aside>
      </div>
  );
  if (embedded) return grid;
  return (
    <main className="page">
      <div className="page-head">
        <h1>New switch</h1>
        <p>Pick two assets and a condition. Tandem checks everything before it moves.</p>
      </div>
      {grid}
    </main>
  );
}
