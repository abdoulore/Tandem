import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Check, ShieldCheck, Wallet } from "@phosphor-icons/react";
import { ASSET_BY_TICKER, isConverting, tokenSymbol } from "../../shared/assets";
import { fmtUsd } from "../../shared/math";
import { fairMessage } from "../../shared/messages";
import { DEFAULT_FAIR, DEFAULT_LIMITS, canonicalFairDraft, type FairDraft, type Mode, type Side } from "../../shared/types";
import { api, type FairPreview } from "../api";
import { AssetPicker } from "../components/AssetPicker";
import { ChecksList } from "../components/Checks";
import { NumberField } from "../components/NumberField";
import { useDebounced, usePoll } from "../lib/hooks";
import { b64, useAppData } from "../state/AppData";

const SOURCE = { pyth: "Pyth", prestocks: "PreStocks mark", jupiter: "Backed via Jupiter" } as const;
const SESSION = { regular: "US market open", extended: "Market closed", weekend: "Weekend", "24/7": "Trades 24/7" } as const;
const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);
const signedPct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;

function startAsset(params: URLSearchParams): string {
  const t = params.get("asset")?.toUpperCase();
  return t && ASSET_BY_TICKER[t] && !isConverting(t) ? t : "TSLA";
}

function problem(d: FairDraft): string | null {
  const amount = d.sizing.kind === "usd" ? d.sizing.usd : d.sizing.shares;
  if (!(amount > 0)) return "Enter an amount above zero.";
  if (!Number.isFinite(d.limitBps)) return "Enter a limit.";
  if (d.offHours.allowed && !Number.isFinite(d.offHours.limitBps)) return "Enter an off-hours limit.";
  return null;
}

/** Buy or sell a stock token, priced against the real stock: fills only while the price stays within the limit. */
export function FairOrder({ side }: { side: Side }) {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { owner, status, market, say } = useAppData();
  const [draft, setDraft] = useState<FairDraft>(() => ({
    kind: "fair",
    side,
    asset: startAsset(params),
    sizing: { kind: "usd", usd: 25 },
    ...DEFAULT_FAIR,
    mode: "paper",
    limits: DEFAULT_LIMITS,
    expiresInDays: 7,
  }));
  const set = (patch: Partial<FairDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => setDraft((d) => (d.side === side ? d : { ...d, side })), [side]);

  // Live preview of the real price, what this order pays now, and every check
  const [preview, setPreview] = useState<FairPreview | null>(null);
  const [previewFor, setPreviewFor] = useState<FairDraft | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);
  const debounced = useDebounced(draft, 300);
  const refresh = useCallback(() => {
    const d = debounced;
    if (problem(d)) return;
    const n = ++seq.current;
    api
      .fairPreview(d, owner)
      .then((p) => {
        if (n !== seq.current) return;
        setPreview(p);
        setPreviewFor(d);
        setPreviewErr(null);
      })
      .catch((e) => n === seq.current && setPreviewErr(e.message));
  }, [debounced, owner]);
  usePoll(refresh, 10_000, [refresh]);

  const asset = ASSET_BY_TICKER[draft.asset];
  const unitWord = asset.kind === "prestock" ? "units" : "shares";
  const invalid = problem(draft);
  const stale = Boolean(invalid || previewErr || !preview || previewFor !== draft);
  const style = preview?.style ?? (asset.kind === "prestock" ? "confirm" : "auto");
  const liveReady = Boolean(status?.liveEnabled && (style === "confirm" || status.autoEnabled) && wallet.connected && wallet.signMessage && wallet.signTransaction);
  const mode: Mode = draft.mode === "live" && liveReady ? "live" : draft.mode;
  const pic = preview?.picture;
  const quote = preview?.quote;
  const dex = market?.assets.find((a) => a.ticker === draft.asset)?.dex;
  const amount = draft.sizing.kind === "usd" ? draft.sizing.usd : draft.sizing.shares;
  const buy = side === "buy";

  const sizeText = !Number.isFinite(amount) ? "..." : draft.sizing.kind === "usd" ? `${fmtUsd(amount, amount % 1 ? 2 : 0)} of ${asset.name}` : `${amount} ${asset.name} ${unitWord}`;
  const limitPct = draft.limitBps / 100;
  const sentence =
    (buy ? `Buy ${sizeText}, paying at most ${limitPct}% over the real price.` : `Sell ${sizeText} for no less than ${limitPct}% under the real price.`) +
    (draft.offHours.allowed ? ` When the market is closed, up to ${draft.offHours.limitBps / 100}% ${buy ? "over" : "under"} the last real price.` : " Fills only while the US market is open.");
  const withinLimit = pic && pic.limitBps !== null && (buy ? pic.premiumBps <= pic.limitBps : pic.premiumBps >= -pic.limitBps);
  const outText = quote ? (buy ? `${quote.outUi.toFixed(4)} ${unitWord}` : fmtUsd(quote.outUi)) : undefined;

  function setUnit(kind: "usd" | "shares") {
    if (kind === draft.sizing.kind) return;
    const px = preview?.marketPrice ?? dex;
    if (!px || !(amount > 0)) return set({ sizing: kind === "usd" ? { kind, usd: 25 } : { kind, shares: 0.1 } });
    set({ sizing: kind === "shares" ? { kind, shares: Number((amount / px).toFixed(4)) } : { kind, usd: Number((amount * px).toFixed(2)) } });
  }

  async function create() {
    setCreating(true);
    try {
      const full: FairDraft = { ...draft, mode, text: sentence };
      if (mode === "paper") {
        await api.create({ draft: full, owner });
        say("Paper order created. It fills when the price is within your limit.");
        navigate("/app/orders");
        return;
      }
      const pk = wallet.publicKey!.toBase58();
      const ts = Date.now();
      const sig = await wallet.signMessage!(new TextEncoder().encode(fairMessage(pk, canonicalFairDraft(full), ts)));
      const { intent, approvalTx } = await api.create({ draft: full, owner: pk, ts, signature: bs58.encode(sig) });
      if (!approvalTx) {
        say("Live order created. When the price is within your limit, you'll confirm in one tap.");
        navigate("/app/orders");
        return;
      }
      say(`Approve exactly ${preview?.amountUi.toFixed(buy ? 2 : 4)} ${tokenSymbol(preview?.from ?? "")} in your wallet. It stays there until the order fills.`);
      const signed = await wallet.signTransaction!(VersionedTransaction.deserialize(Buffer.from(approvalTx, "base64")));
      await api.confirm(intent.id, b64(signed));
      say("Live order created. Approval confirmed on-chain.");
      navigate("/app/orders");
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid">
      <div className="stack">
        <section className="card builder">
          <div className="card-pad builder-body">
            <div className="terms-row fair-row">
              <div className="field">
                <label htmlFor="asset">{buy ? "Buy" : "Sell"}</label>
                <AssetPicker id="asset" value={draft.asset} market={market} publicFirst onChange={(t) => set({ asset: t })} />
                <div className="field-help">{asset.kind === "prestock" ? "Pre-IPO tokens carry more risk: their companies have not approved these transfers." : " "}</div>
              </div>
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
                <div className="field-help">{preview ? `About ${fmtUsd(preview.usdValue)} at the market price` : " "}</div>
              </div>
            </div>

            <div className="field limit-row">
              <label htmlFor="limit">Limit</label>
              <div className="control-row">
                <span className="cond-name">{buy ? "Pay at most" : "Sell for no less than"}</span>
                <span className="pct-input">
                  <NumberField id="limit" className="num" min={0} max={10} value={limitPct} onChange={(n) => set({ limitBps: Math.round(n * 100) })} />
                  <span>%</span>
                </span>
                <span className="cond-name">{buy ? "over" : "under"} the real price</span>
              </div>
              <label className="check-line">
                <input type="checkbox" checked={draft.offHours.allowed} onChange={(e) => set({ offHours: { ...draft.offHours, allowed: e.target.checked } })} />
                <span>
                  Allow off-hours fills up to{" "}
                  <span className="pct-input small">
                    <NumberField
                      className="num"
                      min={0}
                      max={10}
                      value={draft.offHours.limitBps / 100}
                      disabled={!draft.offHours.allowed}
                      onChange={(n) => set({ offHours: { ...draft.offHours, limitBps: Math.round(n * 100) } })}
                    />
                    <span>%</span>
                  </span>{" "}
                  {buy ? "over" : "under"} the last real price
                </span>
              </label>
              <div className="field-help">
                {asset.kind === "prestock"
                  ? "The real price for a pre-IPO token is its PreStocks mark."
                  : "Off-hours, the real price is the last regular-session price. It does not move until the market reopens."}
              </div>
            </div>

            <div className="summary-line">
              <Check size={18} weight="bold" />
              <p>{sentence}</p>
            </div>
            {invalid && <p className="hint bad">{invalid}</p>}
            {previewErr && !invalid && <p className="hint bad">{previewErr}</p>}
          </div>

          <div className={`plan four${stale ? " stale" : ""}`} aria-busy={stale}>
            <div>
              <div className="k">Real price</div>
              <div className="v">{pic ? fmtUsd(pic.ref.price) : <span className="skeleton" style={{ display: "block", height: 24 }} />}</div>
              <div className="s">
                {pic ? (
                  <>
                    {pic.ref.source ? SOURCE[pic.ref.source] : "n/a"}, {age(pic.ref.ageSec)} old <span className={`session ${pic.session}`}>{SESSION[pic.session]}</span>
                  </>
                ) : (
                  " "
                )}
              </div>
            </div>
            <div>
              <div className="k">Token on Solana</div>
              <div className="v">{dex ? fmtUsd(dex) : <span className="skeleton" style={{ display: "block", height: 24 }} />}</div>
              <div className="s">{tokenSymbol(draft.asset)}, last trade price</div>
            </div>
            <div>
              <div className="k">{buy ? "You would pay now" : "You would get now"}</div>
              <div className={`v ${pic ? (withinLimit ? "pos" : "neg") : ""}`}>
                {pic ? signedPct(pic.premiumBps) : <span className="skeleton" style={{ display: "block", height: 24 }} />}
              </div>
              <div className="s">
                {pic
                  ? `${fmtUsd(pic.effPrice)} a ${unitWord === "units" ? "unit" : "share"} vs the real price. ${pic.limitBps === null ? "No fills while closed." : `Limit ${buy ? "+" : "-"}${(pic.limitBps / 100).toFixed(2)}%.`}`
                  : " "}
              </div>
            </div>
            <div>
              <div className="k">{buy ? "You would receive" : "You would receive"}</div>
              <div className="v">{outText ?? <span className="skeleton" style={{ display: "block", height: 24 }} />}</div>
              <div className="s">{quote ? `After fees${quote.feeBps > 0 ? ` (${(quote.feeBps / 100).toFixed(1)}% PreStocks transfer fee)` : ""}, via ${quote.route}` : " "}</div>
            </div>
          </div>
        </section>
      </div>

      <aside className="card">
        <div className="card-head">
          <h2>Safety checks</h2>
          <span className="sub">{preview ? "Checked now and again before it fills" : "Loading"}</span>
        </div>
        <ChecksList checks={preview?.checks} loading={!preview} />
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
              Live prices, the same checks and quotes. No funds move.
            </div>
          ) : (
            <div className="callout live">
              <strong>Live: real tokens move when it fills</strong>
              {style === "confirm"
                ? `${asset.name} charges a 1% transfer fee, so you confirm the swap yourself in one tap when the price is right.`
                : `You approve the exact ${buy ? "USDC" : unitWord} once. It stays in your wallet until the order fills, and you can revoke it any time.`}
            </div>
          )}
          {draft.mode === "live" && !liveReady && (
            <p className="hint warn">
              {!status?.liveEnabled
                ? "Live orders are disabled on this server."
                : style === "auto" && !status.autoEnabled
                  ? `Automatic orders unavailable: ${status.liveBlockers.join(", ")}.`
                  : "Connect a wallet that can sign messages and transactions."}
            </p>
          )}
          <label className="expiry-line">
            Expires after
            <NumberField min={1} max={90} value={draft.expiresInDays} onChange={(n) => set({ expiresInDays: n })} />
            days
          </label>
          <button className="btn btn-primary" onClick={create} disabled={stale || creating || (draft.mode === "live" && !liveReady)}>
            {mode === "live" ? <Wallet size={18} weight="bold" /> : <ShieldCheck size={18} weight="bold" />}
            {creating ? "Creating" : `${mode === "live" ? "Place live" : "Place paper"} ${buy ? "buy" : "sell"}`}
          </button>
        </div>
      </aside>
    </div>
  );
}
