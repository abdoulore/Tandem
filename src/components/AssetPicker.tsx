import { useEffect, useRef, useState } from "react";
import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";
import { ASSETS, ASSET_BY_TICKER, lifecycleNote, type Asset } from "../../shared/assets";
import type { MarketSnapshot } from "../../shared/types";
import { Logo } from "./Logo";

const converting = (a: Asset) => a.lifecycle?.stage === "listed_converting";
const GROUPS: { key: string; label: string; has: (a: Asset) => boolean }[] = [
  { key: "pre", label: "Pre-IPO, via PreStocks", has: (a) => a.kind === "prestock" && !converting(a) },
  { key: "pub", label: "Public stocks, via xStocks", has: (a) => a.kind === "xstock" },
  { key: "conv", label: "Listed, converting (PreStocks)", has: converting },
];

const kindLabel = (a: Asset) => (converting(a) ? `Listed as ${a.lifecycle?.listedAs}` : a.kind === "prestock" ? "Pre-IPO" : "Public stock");
const prem = (bps?: number) => (bps === undefined ? "" : `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`);

interface Props {
  id: string;
  value: string;
  onChange: (ticker: string) => void;
  /** The other side of the pair; shown but not selectable. */
  other?: string;
  market?: MarketSnapshot;
}

export function AssetPicker({ id, value, onChange, other, market }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const asset = ASSET_BY_TICKER[value];

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const match = (t: string) => {
    const a = ASSET_BY_TICKER[t];
    const s = q.trim().toLowerCase();
    return !s || a.ticker.toLowerCase().includes(s) || a.name.toLowerCase().includes(s);
  };

  return (
    <div className="picker" ref={root}>
      <button
        id={id}
        type="button"
        className="picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setQ("");
        }}
      >
        <Logo asset={asset} size={32} />
        <span className="pb-text">
          <span className="pb-name">{asset.name}</span>
          <span className="pb-sub">
            {kindLabel(asset)} · {asset.ticker}
          </span>
        </span>
        <CaretDown size={14} weight="bold" className="pb-caret" />
      </button>
      {open && (
        <div className="picker-pop">
          <label className="picker-search">
            <MagnifyingGlass size={16} />
            <input autoFocus placeholder={`Search ${ASSETS.length} assets`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search assets" />
          </label>
          <div className="picker-list" role="listbox" aria-labelledby={id}>
            {GROUPS.map((g) => {
              const items = ASSETS.filter((a) => g.has(a) && match(a.ticker));
              if (!items.length) return null;
              return (
                <div key={g.key}>
                  <div className="picker-group">{g.label}</div>
                  {items.map((a) => {
                    const peg = market?.assets.find((x) => x.ticker === a.ticker)?.pegBps;
                    return (
                      <button
                        key={a.ticker}
                        type="button"
                        role="option"
                        aria-selected={a.ticker === value}
                        className={`picker-opt ${a.ticker === value ? "sel" : ""}`}
                        disabled={a.ticker === other}
                        onClick={() => {
                          onChange(a.ticker);
                          setOpen(false);
                        }}
                      >
                        <Logo asset={a} size={24} />
                        <span className="po-name">{a.name}</span>
                        <span className="po-tick">{a.ticker}</span>
                        <span className="po-prem num" title={lifecycleNote(a)}>{converting(a) ? a.lifecycle?.listedAs : prem(peg)}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
