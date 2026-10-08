import { CaretDown, CheckCircle, Clock, XCircle } from "@phosphor-icons/react";
import type { Check, CheckId } from "../../shared/types";

const GROUPS: { title: "Reference data" | "Asset" | "Execution"; ids: CheckId[] }[] = [
  { title: "Reference data", ids: ["source", "fresh", "market", "confidence"] },
  { title: "Asset", ids: ["price", "peg", "private", "corporate", "paused"] },
  { title: "Execution", ids: ["quote", "cap", "balance", "delegation"] },
];

function Icon({ state }: { state: "ok" | "bad" | "pending" }) {
  if (state === "pending") return <Clock size={18} weight="bold" className="ic-pending" aria-label="Pending" />;
  if (state === "ok") return <CheckCircle size={18} weight="fill" className="ic-good" aria-label="Passing" />;
  return <XCircle size={18} weight="fill" className="ic-bad" aria-label="Failing" />;
}

const stateOf = (c: Check) => (c.pending ? "pending" : c.ok ? "ok" : "bad");

export type GroupTitle = "Reference data" | "Asset" | "Execution";

interface Props {
  checks?: Check[];
  loading?: boolean;
  /** Plain-word summary shown for a group when all its checks pass. */
  summaries?: Partial<Record<GroupTitle, string>>;
}

export function ChecksList({ checks, loading, summaries }: Props) {
  if (!checks) {
    return (
      <ul className="checks" aria-busy={loading}>
        {GROUPS.map((g) => (
          <li key={g.title}>
            <span className="skeleton" style={{ width: 18, height: 18, borderRadius: 999 }} />
            <span className="skeleton" style={{ height: 30 }} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="check-groups-app">
      {GROUPS.map((g) => {
        const items = checks.filter((c) => g.ids.includes(c.id));
        if (!items.length) return null;
        const failing = items.filter((c) => !c.ok);
        const state = failing.length ? "bad" : items.every((c) => c.pending) ? "pending" : "ok";
        const summary = failing.length ? failing.map((c) => c.label).join(", ") : (summaries?.[g.title] ?? `${items.length} of ${items.length} passing`);
        return (
          <details key={g.title} className="check-group" open={failing.length > 0}>
            <summary>
              <Icon state={state} />
              <span className="cg-title">{g.title}</span>
              <span className="cg-sum">{summary}</span>
              <CaretDown size={14} className="cg-caret" />
            </summary>
            <ul className="checks">
              {items.map((c) => (
                <li key={c.id}>
                  <Icon state={stateOf(c)} />
                  <div>
                    <div className="t">{c.label}</div>
                    <div className="d">{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
