import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { tokenSymbol } from "../../shared/assets";
import { fmtNum } from "../../shared/math";
import { BrandMark } from "../components/Brand";
import { usePoll } from "../lib/hooks";
import "./radar.css";

type Fill = {
  at: number;
  kind: "switch" | "fair";
  order: string;
  owner: string;
  usd?: number;
  session?: string;
  refPrice?: number;
  effPrice?: number;
  premiumBps?: number;
  inUi: number;
  outUi: number;
  from: string;
  to: string;
  signature: string;
};
type Refusal = {
  at: number;
  order: string;
  mode: "paper" | "live";
  owner: string;
  check: string;
  detail: string;
  snapshot?: { price: number; source?: string; ageSec: number; premiumBps?: number; session?: string };
};
type Held = Omit<Refusal, "check">;

const when = (t: number) => new Date(t).toUTCString().slice(5, 22) + " UTC";
const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
const SESSION: Record<string, string> = { regular: "Market open", extended: "Market closed", weekend: "Weekend", "24/7": "24/7" };

/** Public record of what Tandem filled on mainnet, and what it refused to fill. */
export function Proof() {
  const [data, setData] = useState<{ fills: Fill[]; refusals: Refusal[]; held?: Held[] }>();
  const load = useCallback(() => {
    fetch("/api/proof")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);
  usePoll(load, 30_000);

  return (
    <div className="landing radar">
      <header className="l-nav">
        <div className="l-wrap l-nav-row">
          <Link to="/" className="brand">
            <BrandMark />
            Tandem
          </Link>
          <nav className="l-links" aria-label="Main">
            <Link to="/radar">Radar</Link>
            <Link to="/app/markets">Markets</Link>
          </nav>
          <Link to="/app" className="btn btn-primary btn-sm">
            Open the app
          </Link>
        </div>
      </header>

      <main className="l-wrap radar-main">
        <div className="radar-head">
          <div>
            <h1>Proof</h1>
            <p>Every live order Tandem settled on Solana, the latest orders it refused to fill because a check failed or the price moved, and the orders it held back because the price was past their limit.</p>
          </div>
        </div>

        <h2 className="proof-h">Filled on mainnet</h2>
        <div className="radar-table-wrap">
          <table className="radar-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Order</th>
                <th>Size</th>
                <th>Session</th>
                <th>Real price</th>
                <th>Paid or received</th>
                <th>Vs real price</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={8} className="muted">
                    Loading
                  </td>
                </tr>
              )}
              {data?.fills.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No live fills yet.
                  </td>
                </tr>
              )}
              {data?.fills.map((f) => (
                <tr key={f.signature}>
                  <td>{when(f.at)}</td>
                  <td>
                    <strong>{f.order}</strong>
                    <small>{f.owner}</small>
                  </td>
                  <td className="num">
                    {f.usd !== undefined ? `$${f.usd.toFixed(2)}` : `${fmtNum(f.inUi)} ${tokenSymbol(f.from)}`}
                    <small>
                      {fmtNum(f.inUi)} {tokenSymbol(f.from)} to {fmtNum(f.outUi)} {tokenSymbol(f.to)}
                    </small>
                  </td>
                  <td>{f.session ? SESSION[f.session] : <small>Switch</small>}</td>
                  <td className="num">{f.refPrice !== undefined ? `$${f.refPrice.toFixed(2)}` : <small>n/a</small>}</td>
                  <td className="num">{f.effPrice !== undefined ? `$${f.effPrice.toFixed(2)}` : <small>n/a</small>}</td>
                  <td className="num">{f.premiumBps !== undefined ? pct(f.premiumBps) : <small>n/a</small>}</td>
                  <td>
                    <a href={`https://solscan.io/tx/${f.signature}`} target="_blank" rel="noreferrer" className="radar-cta">
                      {f.signature.slice(0, 6)}...{f.signature.slice(-6)} <ArrowSquareOut size={13} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="proof-h">Refused</h2>
        <p className="radar-window">When a safety check fails, or the price moves past the limit as the order fills, Tandem does not fill. Each refusal keeps the price it saw.</p>
        <div className="radar-table-wrap">
          <table className="radar-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Order</th>
                <th>Refused by</th>
                <th>Detail</th>
                <th>Real price then</th>
              </tr>
            </thead>
            <tbody>
              {data?.refusals.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No refusals yet.
                  </td>
                </tr>
              )}
              {data?.refusals.map((r, k) => (
                <tr key={`${r.at}-${k}`}>
                  <td>{when(r.at)}</td>
                  <td>
                    <strong>{r.order}</strong>
                    <small>
                      {r.mode === "live" ? "Live" : "Paper"}, {r.owner}
                    </small>
                  </td>
                  <td>
                    <span className="refused">Refused</span> {r.check}
                  </td>
                  <td>
                    <small className="detail">{r.detail}</small>
                  </td>
                  <td className="num">
                    {r.snapshot ? `$${r.snapshot.price.toFixed(2)}` : <small>n/a</small>}
                    {r.snapshot?.premiumBps !== undefined && <small>token {pct(r.snapshot.premiumBps)}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="proof-h">Held back</h2>
        <p className="radar-window">
          While the token trades past the order&apos;s limit against the real price, Tandem waits. Logged at most every 10 minutes per order.
        </p>
        <div className="radar-table-wrap">
          <table className="radar-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Order</th>
                <th>Price vs real, limit</th>
                <th>Session</th>
                <th>Real price then</th>
              </tr>
            </thead>
            <tbody>
              {data && !data.held?.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    No orders held back yet.
                  </td>
                </tr>
              )}
              {data?.held?.map((h, k) => (
                <tr key={`${h.at}-${k}`}>
                  <td>{when(h.at)}</td>
                  <td>
                    <strong>{h.order}</strong>
                    <small>
                      {h.mode === "live" ? "Live" : "Paper"}, {h.owner}
                    </small>
                  </td>
                  <td>
                    <small className="detail">{h.detail.replace(/, [^,]+$/, "")}</small>
                  </td>
                  <td>{h.snapshot?.session ? (SESSION[h.snapshot.session] ?? h.snapshot.session) : <small>n/a</small>}</td>
                  <td className="num">{h.snapshot ? `$${h.snapshot.price.toFixed(2)}` : <small>n/a</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
