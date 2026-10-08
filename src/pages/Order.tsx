import { useSearchParams } from "react-router-dom";
import type { KeyboardEvent } from "react";
import { FairOrder } from "./FairOrder";
import { NewSwitch } from "./NewSwitch";

const TABS = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "switch", label: "Switch" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const LEAD: Record<Tab, string> = {
  buy: "Priced against the real stock. Tandem only fills while the price is within your limit.",
  sell: "Priced against the real stock. Tandem only fills while the price is within your limit.",
  switch: "Move from one asset into another when the relationship between them moves your way.",
};

/** /app: buy, sell, or switch. Links that name a switch target (?to=) open the Switch tab. */
export function Order() {
  const [params, setParams] = useSearchParams();
  const t = params.get("tab");
  const tab: Tab = t === "buy" || t === "sell" || t === "switch" ? t : params.get("to") ? "switch" : "buy";

  const pick = (next: Tab) => {
    const keep = new URLSearchParams();
    keep.set("tab", next);
    const asset = params.get("asset");
    if (asset && next !== "switch") keep.set("asset", asset);
    setParams(keep, { replace: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = TABS.findIndex((x) => x.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id;
    pick(next);
    document.getElementById(`order-tab-${next}`)?.focus();
  };

  return (
    <main className="page">
      <div className="page-head">
        <h1>New order</h1>
        <p>{LEAD[tab]}</p>
      </div>
      <div className="tabs" role="tablist" aria-label="Order type" onKeyDown={onKey}>
        {TABS.map((x) => (
          <button
            key={x.id}
            id={`order-tab-${x.id}`}
            role="tab"
            aria-selected={tab === x.id}
            aria-controls="order-panel"
            tabIndex={tab === x.id ? 0 : -1}
            className={tab === x.id ? "on" : ""}
            onClick={() => pick(x.id)}
          >
            {x.label}
            {x.id === "switch" && <span className="n">Advanced</span>}
          </button>
        ))}
      </div>
      <div id="order-panel" role="tabpanel" aria-labelledby={`order-tab-${tab}`}>
        {tab === "switch" ? <NewSwitch embedded /> : <FairOrder side={tab} />}
      </div>
    </main>
  );
}
