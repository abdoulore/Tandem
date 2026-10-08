import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { cancelMessage } from "../../shared/messages";
import type { LifecycleEvent } from "../../shared/lifecycle";
import type { Intent, MarketSnapshot, Status } from "../../shared/types";
import { api } from "../api";
import { guestId, usePoll } from "../lib/hooks";

// Data every page shares: server status, market prices, the user's switches, and the actions on
// them. Lives above the router so switching pages doesn't refetch or drop notifications.

interface AppData {
  owner: string;
  guest: string;
  status?: Status;
  market?: MarketSnapshot;
  /** Conversion deadlines, multiplier changes and pauses, refreshed every few minutes. */
  lifecycle: LifecycleEvent[];
  intents: Intent[];
  readyCount: number;
  busyId: string | null;
  say: (msg: string, bad?: boolean) => void;
  confirmSwitch: (i: Intent) => Promise<void>;
  cancel: (i: Intent) => Promise<void>;
}

const Ctx = createContext<AppData | null>(null);

export const b64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString("base64");

export function AppDataProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const guest = useMemo(guestId, []);
  const owner = wallet.publicKey?.toBase58() ?? guest;

  const [status, setStatus] = useState<Status>();
  const [market, setMarket] = useState<MarketSnapshot>();
  const [lifecycle, setLifecycle] = useState<LifecycleEvent[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);

  const say = useCallback((msg: string, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), bad ? 7000 : 4000);
  }, []);

  usePoll(() => api.status().then(setStatus).catch(() => {}), 15_000);
  usePoll(() => api.market().then(setMarket).catch(() => {}), 5_000);
  usePoll(() => api.lifecycle().then(setLifecycle).catch(() => {}), 300_000);
  usePoll(
    () => {
      const owners = [...new Set([owner, guest])];
      Promise.all(owners.map((o) => api.intents(o).catch(() => [] as Intent[]))).then((lists) =>
        setIntents(lists.flat().sort((a, b) => b.createdAt - a.createdAt)),
      );
    },
    2_000,
    [owner, guest],
  );

  const confirmSwitch = useCallback(
    async (i: Intent) => {
      setBusyId(i.id);
      try {
        if (!wallet.publicKey || wallet.publicKey.toBase58() !== i.owner) throw new Error("Connect the wallet that created this order");
        const { tx } = await api.swapTx(i.id, i.owner);
        const signed = await wallet.signTransaction!(VersionedTransaction.deserialize(Buffer.from(tx, "base64")));
        await api.executed(i.id, b64(signed));
        say(i.kind === "fair" ? "Filled. The tokens are in your wallet." : "Switched. The new tokens are in your wallet.");
      } catch (e) {
        say((e as Error).message, true);
      } finally {
        setBusyId(null);
      }
    },
    [wallet, say],
  );

  const cancel = useCallback(
    async (i: Intent) => {
      setBusyId(i.id);
      try {
        if (i.mode === "paper") {
          await api.cancel(i.id, { owner: i.owner });
        } else {
          if (!wallet.publicKey || wallet.publicKey.toBase58() !== i.owner) throw new Error("Connect the wallet that created this order");
          const ts = Date.now();
          const sig = await wallet.signMessage!(new TextEncoder().encode(cancelMessage(i.owner, i.id, ts)));
          const { revokeTx } = await api.cancel(i.id, { owner: i.owner, ts, signature: bs58.encode(sig) });
          if (revokeTx) {
            say("Cancelled. Sign once more to shrink the keeper's approval.");
            const signed = await wallet.signTransaction!(VersionedTransaction.deserialize(Buffer.from(revokeTx, "base64")));
            await api.revoke(i.id, b64(signed));
          }
        }
        say(i.kind === "fair" ? "Order cancelled." : "Switch cancelled.");
      } catch (e) {
        say((e as Error).message, true);
      } finally {
        setBusyId(null);
      }
    },
    [wallet, say],
  );

  // Tell the user when a one-tap switch becomes ready, wherever they are in the app.
  const ready = intents.filter((i) => i.status === "ready" && i.mode === "live");
  const readyKey = ready.map((i) => i.id).join(",");
  const seenReady = useRef(new Set<string>());
  useEffect(() => {
    for (const i of ready) {
      if (seenReady.current.has(i.id)) continue;
      seenReady.current.add(i.id);
      const msg = i.kind === "fair" ? `Ready to ${i.fair?.side} ${i.fair?.asset} within your limit. Confirm in My orders.` : `Ready to switch ${i.from} into ${i.to}. Confirm in My orders.`;
      say(msg);
      try {
        if ("Notification" in window && Notification.permission === "granted") new Notification("Tandem", { body: msg });
      } catch {
        /* notifications are best-effort */
      }
    }
    document.title = ready.length ? `(${ready.length}) Ready - Tandem` : "Tandem";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey, say]);

  const value: AppData = { owner, guest, status, market, lifecycle, intents, readyCount: ready.length, busyId, say, confirmSwitch, cancel };
  return (
    <Ctx.Provider value={value}>
      {children}
      {toast && (
        <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">
          {toast.msg}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData outside AppDataProvider");
  return v;
}
