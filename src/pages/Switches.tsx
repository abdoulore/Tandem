import { useRef, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Intent } from "../../shared/types";
import { IntentList } from "../components/IntentList";
import { TelegramAlerts } from "../components/TelegramAlerts";
import { TrustPanel } from "../components/TrustPanel";
import { useAppData } from "../state/AppData";

const OPEN = new Set<Intent["status"]>(["armed", "ready", "awaiting_approval", "executing"]);
const TABS = ["open", "closed"] as const;
type Tab = (typeof TABS)[number];

const closedAt = (i: Intent) => i.execution?.at ?? i.events[i.events.length - 1]?.at ?? i.createdAt;

function EmptyState() {
  return (
    <div className="empty-rich">
      <h3>No open orders</h3>
      <p>Tandem watches the relationship between two assets and acts when your condition is met. Try this one:</p>
      <div className="empty-example">
        <div className="pair">
          OpenAI <ArrowRight size={14} weight="bold" /> Anthropic
        </div>
        <div className="cond">Move $100 when Anthropic becomes 10% cheaper relative to OpenAI</div>
      </div>
      <Link to="/app?from=OPENAI&to=ANTHROPIC&pct=10" className="btn btn-primary">
        Create this switch
      </Link>
      <p className="muted">Paper mode uses live market data and needs no wallet.</p>
    </div>
  );
}

export function Switches() {
  const wallet = useWallet();
  const { intents, cancel, confirmSwitch, busyId, readyCount } = useAppData();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "closed" ? "closed" : "open";
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ open: null, closed: null });

  // A switch that closes while you're watching stays in Open until you change tab or leave, so its result doesn't vanish mid-view.
  const watched = useRef(new Set<string>());
  for (const i of intents) if (OPEN.has(i.status)) watched.current.add(i.id);

  const open = intents
    .filter((i) => OPEN.has(i.status) || watched.current.has(i.id))
    .sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"));
  const closed = intents.filter((i) => !OPEN.has(i.status)).sort((a, b) => closedAt(b) - closedAt(a));
  const counts: Record<Tab, number> = { open: open.length, closed: closed.length };

  function pick(t: Tab) {
    for (const i of intents) if (!OPEN.has(i.status)) watched.current.delete(i.id);
    setParams(t === "open" ? {} : { tab: t }, { replace: true });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = tab === "open" ? "closed" : "open";
    pick(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <main className="page">
      <div className="page-head row">
        <div>
          <h1>My orders</h1>
          <p>
            {readyCount > 0
              ? `${readyCount} ready to confirm. Every check passed; confirm in your wallet.`
              : wallet.connected
                ? "Orders from this wallet and this browser."
                : "Paper orders from this browser. Connect a wallet to see live ones."}
          </p>
        </div>
        <Link to="/app" className="btn btn-primary">
          New order
        </Link>
      </div>

      <TelegramAlerts />
      <TrustPanel />

      <div className="tabs" role="tablist" aria-label="Orders" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls="switches-panel"
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? "on" : ""}
            onClick={() => pick(t)}
          >
            {t === "open" ? "Open" : "Closed"}
            <span className="n">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div id="switches-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "open" ? (
          <IntentList intents={open} onCancel={cancel} onConfirm={confirmSwitch} busyId={busyId ?? undefined} empty={<EmptyState />} />
        ) : (
          <IntentList
            intents={closed}
            onCancel={cancel}
            onConfirm={confirmSwitch}
            busyId={busyId ?? undefined}
            empty="Nothing closed yet. Orders that fill, expire or are cancelled show up here with their receipts."
          />
        )}
      </div>
    </main>
  );
}
