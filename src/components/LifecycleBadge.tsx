import { CalendarBlank, PauseCircle } from "@phosphor-icons/react";
import { useAppData } from "../state/AppData";

/** Small badges for a ticker's lifecycle events (multiplier change, issuer pause, conversion deadline); the detail is in the tooltip. */
export function LifecycleBadge({ ticker }: { ticker: string }) {
  const { lifecycle } = useAppData();
  const events = lifecycle.filter((e) => e.ticker === ticker);
  if (!events.length) return null;
  return (
    <>
      {events.map((e) => (
        <span key={e.key} className={`lc-badge ${e.kind}`} title={e.detail}>
          {e.kind === "paused" ? <PauseCircle size={12} weight="bold" /> : <CalendarBlank size={12} weight="bold" />}
          {e.title}
        </span>
      ))}
    </>
  );
}

/** The order form's version: the same events written out, with what they mean for this order. */
export function LifecycleNote({ ticker }: { ticker: string }) {
  const { lifecycle } = useAppData();
  const events = lifecycle.filter((e) => e.ticker === ticker);
  if (!events.length) return null;
  return (
    <>
      {events.map((e) => (
        <p key={e.key} className="hint warn">
          <strong>{e.title}.</strong> {e.detail}
        </p>
      ))}
    </>
  );
}
