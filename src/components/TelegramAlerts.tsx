import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { Check, TelegramLogo } from "@phosphor-icons/react";
import { telegramMessage } from "../../shared/messages";
import { api } from "../api";
import { usePoll } from "../lib/hooks";
import { useAppData } from "../state/AppData";

/** Links this wallet (or browser) to Telegram so switch alerts reach the user away from the app. */
export function TelegramAlerts() {
  const wallet = useWallet();
  const { owner, guest, say } = useAppData();
  const [state, setState] = useState<{ enabled: boolean; bot?: string; linked: boolean }>();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Check often while a link is waiting for Start in Telegram, rarely otherwise.
  usePoll(() => api.telegram(owner).then(setState).catch(() => {}), url ? 3_000 : 30_000, [owner, url]);
  const wasLinked = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (state?.linked && wasLinked.current === false) say("Telegram alerts on.");
    if (state?.linked) setUrl(null);
    if (state) wasLinked.current = state.linked;
  }, [state, say]);
  useEffect(() => {
    setUrl(null);
    wasLinked.current = undefined;
  }, [owner]);

  if (!state?.enabled) return null;

  async function link() {
    setBusy(true);
    try {
      if (owner.startsWith("guest:")) {
        setUrl((await api.telegramLink({ owner })).url);
        return;
      }
      if (!wallet.signMessage) throw new Error("This wallet can't sign messages");
      const ts = Date.now();
      const sig = await wallet.signMessage(new TextEncoder().encode(telegramMessage(owner, ts)));
      setUrl((await api.telegramLink({ owner, guest, ts, signature: bs58.encode(sig) })).url);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alerts-row">
      <TelegramLogo size={24} weight="duotone" className="alerts-icon" />
      <div className="alerts-text">
        {state.linked ? (
          <>
            <strong>Telegram alerts on</strong>
            <span>@{state.bot} messages you when an order is ready to confirm, completes or fails. Send /stop to the bot to turn them off.</span>
          </>
        ) : url ? (
          <>
            <strong>One more step</strong>
            <span>Open Telegram and press Start in the chat with @{state.bot}. The link works for 10 minutes.</span>
          </>
        ) : (
          <>
            <strong>Get Telegram alerts</strong>
            <span>Tandem messages you when an order is ready to confirm, and when one completes or fails. No need to keep this page open.</span>
          </>
        )}
      </div>
      {state.linked ? (
        <span className="badge good">
          <Check size={12} weight="bold" /> On
        </span>
      ) : url ? (
        <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">
          Open Telegram
        </a>
      ) : (
        <button className="btn btn-ghost" onClick={link} disabled={busy}>
          {busy ? "Linking" : "Turn on alerts"}
        </button>
      )}
    </div>
  );
}
