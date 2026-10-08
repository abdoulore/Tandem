import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { ShieldCheck } from "@phosphor-icons/react";
import { api, type Trust } from "../api";
import { usePoll } from "../lib/hooks";
import { b64, useAppData } from "../state/AppData";

const short = (k: string) => `${k.slice(0, 4)}...${k.slice(-4)}`;
const amt = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/** What the keeper may move for this wallet, read on-chain, with a one-click revoke per token. */
export function TrustPanel() {
  const wallet = useWallet();
  const { owner, say } = useAppData();
  const [trust, setTrust] = useState<Trust>();
  const [busy, setBusy] = useState<string | null>(null);
  const isWallet = !owner.startsWith("guest:");
  const load = useCallback(() => {
    if (isWallet) api.trust(owner).then(setTrust).catch(() => {});
  }, [owner, isWallet]);
  usePoll(load, 30_000, [load]);
  if (!isWallet || !trust?.keeper) return null;

  async function revoke(token: string) {
    setBusy(token);
    try {
      if (!wallet.signTransaction) throw new Error("This wallet can't sign transactions");
      const { tx } = await api.revokeAllTx(owner, token);
      const signed = await wallet.signTransaction(VersionedTransaction.deserialize(Buffer.from(tx, "base64")));
      const r = await api.revokeAll(owner, token, b64(signed));
      say(`Approval revoked${r.cancelled ? `. ${r.cancelled} open order${r.cancelled === 1 ? "" : "s"} cancelled` : ""}.`);
      load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  const rows = trust.approvals.filter((a) => a.approvedUi > 0 || a.openOrders > 0);
  return (
    <section className="card trust" aria-label="What the keeper can move">
      <div className="trust-head">
        <ShieldCheck size={22} weight="duotone" className="alerts-icon" />
        <div>
          <strong>What the keeper can move</strong>
          <span>
            The keeper holds only SOL for network fees ({short(trust.keeper.pubkey)}
            {trust.keeper.sol !== undefined ? `, ${trust.keeper.sol.toFixed(3)} SOL` : ""}). It can move only what you approved. Tandem&apos;s code sends the
            output to your wallet; an on-chain program that enforces this is on the roadmap.
          </span>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="trust-empty">No approvals. Automatic orders ask you to approve the exact amount when you place them.</p>
      ) : (
        <ul className="trust-rows">
          {rows.map((a) => (
            <li key={a.token}>
              <div>
                <strong className="num">
                  {amt(a.approvedUi)} {a.symbol}
                </strong>{" "}
                approved, still in your wallet
                <small>
                  {a.openOrders} open order{a.openOrders === 1 ? "" : "s"} need {amt(a.neededUi)} {a.symbol}. Wallet holds {amt(a.balanceUi)}.
                </small>
              </div>
              <button className="btn btn-ghost" onClick={() => revoke(a.token)} disabled={busy === a.token || a.approvedUi === 0}>
                {busy === a.token ? "Revoking" : "Revoke now"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
