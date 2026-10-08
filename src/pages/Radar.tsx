import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Copy } from "@phosphor-icons/react";
import { ASSETS, ASSET_BY_TICKER, isConverting, tokenSymbol } from "../../shared/assets";
import { BrandMark } from "../components/Brand";
import { LifecycleBadge } from "../components/LifecycleBadge";
import { Logo } from "../components/Logo";
import { usePoll } from "../lib/hooks";
import { useAppData } from "../state/AppData";
import "./radar.css";

type Row = { ticker: string; session: string; refSrc?: string; samples: number; pegMedian?: number; maxPremium?: number; maxDiscount?: number; over50: number };
type Summary = { from: number; to: number; rows: Row[] };
type Point = { t: number; session: string; peg?: number };

/** Short source names for the table; the footnote spells out what each one is. */
const SOURCE = { pyth: "Pyth", prestocks: "PreStocks", jupiter: "Backed" } as const;
const pct = (bps: number, d = 2) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(d)}%`;
const age = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172_800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`);
const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** The larger move of a row's max premium and max discount, keeping its sign. */
const worst = (rows: Row[]) => {
  let w: number | undefined;
  for (const r of rows) for (const v of [r.maxPremium, r.maxDiscount]) if (v !== undefined && (w === undefined || Math.abs(v) > Math.abs(w))) w = v;
  return w;
};
const fetchJson = <T,>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);

function Spark({ points }: { points?: Point[] }) {
  const vals = (points ?? []).filter((p) => p.peg !== undefined) as Required<Point>[];
  if (vals.length < 2) return <span className="spark-empty">collecting</span>;
  const W = 120;
  const H = 30;
  const lo = Math.min(0, ...vals.map((p) => p.peg));
  const hi = Math.max(0, ...vals.map((p) => p.peg));
  const t0 = vals[0].t;
  const t1 = vals[vals.length - 1].t;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (W - 4) + 2;
  const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (H - 6);
  const d = vals.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.peg).toFixed(1)}`).join("");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="spark-zero" />
      <path d={d} />
    </svg>
  );
}

/** Public page: how far each tokenized stock trades from its real price, now and over the last days. */
export function Radar() {
  const { market, say } = useAppData();
  const [filter, setFilter] = useState<"xstock" | "prestock">("xstock");
  const [s72, setS72] = useState<Summary>();
  const [s24, setS24] = useState<Summary>();
  const [s7d, setS7d] = useState<Summary>();
  const [spark, setSpark] = useState<Record<string, Point[]>>({});

  const load = useCallback(() => {
    fetchJson<Summary>("/api/drift/summary?hours=72").then(setS72).catch(() => {});
    fetchJson<Summary>("/api/drift/summary?hours=24").then(setS24).catch(() => {});
    fetchJson<Summary>("/api/drift/summary?hours=168").then(setS7d).catch(() => {});
    fetchJson<Record<string, Point[]>>("/api/drift/series?hours=72&bucket=1800").then(setSpark).catch(() => {});
  }, []);
  usePoll(load, 60_000);

  const since = useMemo(() => {
    const ts = Object.values(spark).flatMap((ps) => ps.map((p) => p.t));
    return ts.length ? Math.min(...ts) : undefined;
  }, [spark]);
  const sinceText = since ? new Date(since * 1000).toUTCString().slice(5, 22) + " UTC" : "...";

  // Summary strip, from the 72-hour window
  const strip = useMemo(() => {
    const rows = s72?.rows ?? [];
    const off = rows.filter((r) => ASSET_BY_TICKER[r.ticker]?.kind === "xstock" && (r.session === "extended" || r.session === "weekend"));
    const offMedian = median(off.map((r) => r.pegMedian).filter((v): v is number => v !== undefined));
    const offSamples = off.reduce((a, r) => a + r.samples, 0);
    const offOver50 = offSamples ? off.reduce((a, r) => a + r.over50 * r.samples, 0) / offSamples : undefined;
    const pre = rows.filter((r) => r.session === "24/7");
    const preMedian = median(pre.map((r) => Math.abs(r.pegMedian ?? 0)));
    return { offMedian, offOver50, preMedian, offSamples };
  }, [s72]);

  const quotes = market?.assets ?? [];
  const list = ASSETS.filter((a) => a.kind === filter && !isConverting(a.ticker));

  function copyPost() {
    const pub = quotes.filter((q) => q.kind === "xstock" && q.pegBps !== undefined);
    const top = [...pub].sort((a, b) => Math.abs(b.pegBps!) - Math.abs(a.pegBps!))[0];
    if (!top || !top.ref) return say("Prices are still loading.", true);
    const now = new Date();
    const when = `${now.toUTCString().slice(0, 11)}, ${now.toISOString().slice(11, 16)} UTC`;
    const closed = top.marketOpen === false;
    const vs = closed ? "its last close" : "the stock";
    const src = top.sources?.ref === "pyth" ? "Pyth" : "Backed";
    const text = `${when}: ${tokenSymbol(top.ticker)} trades ${pct(Math.abs(top.pegBps!))} ${top.pegBps! >= 0 ? "over" : "under"} ${vs}. Tandem Radar, data from ${src} and Jupiter. ${location.origin}/radar`;
    navigator.clipboard
      .writeText(text)
      .then(() => say("Post copied."))
      .catch(() => say(text));
  }

  return (
    <div className="landing radar">
      <header className="l-nav">
        <div className="l-wrap l-nav-row">
          <Link to="/" className="brand">
            <BrandMark />
            Tandem
          </Link>
          <nav className="l-links" aria-label="Main">
            <Link to="/app/markets">Markets</Link>
            <Link to="/app/orders">My orders</Link>
          </nav>
          <Link to="/app" className="btn btn-primary btn-sm">
            Open the app
          </Link>
        </div>
      </header>

      <main className="l-wrap radar-main">
        <div className="radar-head">
          <div>
            <h1>Radar</h1>
            <p>How far each tokenized stock trades from the real stock, right now and over the last three days.</p>
          </div>
          <button className="btn btn-ghost" onClick={copyPost}>
            <Copy size={15} /> Copy post
          </button>
        </div>

        <section className="radar-strip" aria-label="Summary">
          <div>
            <div className="k">Typical gap when the US market is closed</div>
            <div className="v">{strip.offMedian !== undefined ? pct(strip.offMedian) : "..."}</div>
            <div className="s">Median token premium over the last close, public stocks</div>
          </div>
          <div>
            <div className="k">Off-hours time more than 0.5% off</div>
            <div className="v">{strip.offOver50 !== undefined ? `${Math.round(strip.offOver50 * 100)}%` : "..."}</div>
            <div className="s">Share of off-hours samples, public stocks</div>
          </div>
          <div>
            <div className="k">Typical pre-IPO gap to the mark</div>
            <div className="v">{strip.preMedian !== undefined ? `${(strip.preMedian / 100).toFixed(1)}%` : "..."}</div>
            <div className="s">Median distance from the PreStocks mark</div>
          </div>
        </section>
        <p className="radar-window">
          Tandem data, logged every minute since {sinceText}. Off-hours, the real price is the last regular-session price; pre-market, after-hours and overnight prices
          are not included.
        </p>

        <div className="radar-filter">
          <span className="seg" role="group" aria-label="Asset type">
            <button className={filter === "xstock" ? "on" : ""} onClick={() => setFilter("xstock")}>
              Public stocks
            </button>
            <button className={filter === "prestock" ? "on" : ""} onClick={() => setFilter("prestock")}>
              Pre-IPO
            </button>
          </span>
        </div>

        <div className="radar-table-wrap">
          <table className="radar-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>{filter === "xstock" ? "Real price" : "PreStocks mark"}</th>
                <th>Token on Solana</th>
                <th>Premium now</th>
                <th>Widest, 24h</th>
                <th>Widest, weekend</th>
                <th>Last 3 days</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const q = quotes.find((x) => x.ticker === a.ticker);
                const src = q?.sources?.ref;
                const lagging = src === "jupiter" && q?.marketOpen;
                const w24 = worst((s24?.rows ?? []).filter((r) => r.ticker === a.ticker));
                const wkd = worst((s7d?.rows ?? []).filter((r) => r.ticker === a.ticker && r.session === "weekend"));
                const peg = q?.pegBps;
                return (
                  <tr key={a.ticker}>
                    <td>
                      <span className="radar-asset">
                        <Logo asset={a} size={24} />
                        <span>
                          <strong>{a.name}</strong>
                          <small>
                            {tokenSymbol(a.ticker)} <LifecycleBadge ticker={a.ticker} />
                          </small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="num">{q?.ref ? `$${q.ref.price.toFixed(2)}` : "..."}</span>
                      <small>
                        {src ? SOURCE[src] : ""}
                        {q?.ref ? `, ${age(Math.max(0, Math.round(Date.now() / 1000 - q.ref.publishTime)))} old` : ""}
                      </small>
                    </td>
                    <td className="num">{q?.dex ? `$${q.dex.toFixed(2)}` : "..."}</td>
                    <td>
                      <span className={`num prem ${peg === undefined ? "" : Math.abs(peg) > 50 ? (peg > 0 ? "hi" : "lo") : "ok"}`}>
                        {peg === undefined ? "..." : `${lagging ? "≈ " : ""}${pct(peg)}`}
                      </span>
                      {lagging && <small title="In market hours, Backed's reference can lag the stock by a few minutes">reference lags</small>}
                    </td>
                    <td className="num">{w24 === undefined ? "..." : pct(w24)}</td>
                    <td className="num">{wkd === undefined ? <small>from Saturday</small> : pct(wkd)}</td>
                    <td>
                      <Spark points={spark[a.ticker]} />
                    </td>
                    <td>
                      <Link className="radar-cta" to={`/app?tab=buy&asset=${a.ticker}`}>
                        Buy at the real price <ArrowRight size={13} weight="bold" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="radar-foot">
          Premium is the token price on Solana against its real price: the Pyth or Backed stock price for public stocks, the PreStocks mark for pre-IPO. In market
          hours Backed&apos;s reference can lag the stock by a few minutes, so those rows show ≈. Not investment advice.
        </p>
      </main>
    </div>
  );
}
