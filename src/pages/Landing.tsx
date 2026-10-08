import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle, Clock, XCircle } from "@phosphor-icons/react";
import { ASSETS, isConverting } from "../../shared/assets";
import { DEFAULT_FAIR, DEFAULT_LIMITS, type AssetQuote, type Check, type FairDraft } from "../../shared/types";
import { api, type FairPreview } from "../api";
import { BrandMark } from "../components/Brand";
import { Logo } from "../components/Logo";
import { usePoll, useReveal } from "../lib/hooks";
import { useAppData } from "../state/AppData";
import "./landing.css";

const pct = (bps: number, d = 1) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(d)}%`;
const SOURCE = { pyth: "Pyth", prestocks: "PreStocks mark", finnhub: "Finnhub", jupiter: "Backed" } as const;
const SESSION = { regular: "US market open", extended: "Market closed", weekend: "Weekend", "24/7": "Trades 24/7" } as const;

/** The hero's live example: a real fair-price buy, previewed on current prices. */
const HERO: FairDraft = { kind: "fair", side: "buy", asset: "TSLA", sizing: { kind: "usd", usd: 100 }, ...DEFAULT_FAIR, mode: "paper", limits: DEFAULT_LIMITS, expiresInDays: 7 };

const CheckIcon = ({ c }: { c: Check }) =>
  c.pending ? <Clock size={16} weight="bold" className="ic-pending" /> : c.ok ? <CheckCircle size={16} weight="fill" className="ic-good" /> : <XCircle size={16} weight="fill" className="ic-bad" />;

function LiveOrder() {
  const [p, setP] = useState<FairPreview>();
  usePoll(() => api.fairPreview(HERO).then(setP).catch(() => {}), 15_000);
  const pic = p?.picture;
  const within = pic && pic.limitBps !== null && pic.premiumBps <= pic.limitBps;
  const verdict = !pic
    ? " "
    : pic.limitBps === null
      ? "Market closed: this order waits for the open."
      : within
        ? "Within the limit: Tandem would fill it."
        : "Above the limit: Tandem waits and does not fill.";
  const shown = ["price", "fresh", "quote"].map((id) => p?.checks.find((c) => c.id === id)).filter(Boolean) as Check[];
  return (
    <div className="preview card">
      <div className="preview-pair">Live order, paper mode</div>
      <div className="preview-sentence">{"“"}Buy $100 of Tesla, paying at most 0.5% over the real price.{"”"}</div>
      <div className="preview-nums three">
        <div>
          <div className="k">Real price</div>
          <div className="v num">{pic ? `$${pic.ref.price.toFixed(2)}` : "..."}</div>
        </div>
        <div>
          <div className="k">You would pay</div>
          <div className="v num">{pic ? `$${pic.effPrice.toFixed(2)}` : "..."}</div>
        </div>
        <div>
          <div className="k">Vs real price</div>
          <div className={`v num ${pic ? (within ? "good" : "bad") : ""}`}>{pic ? pct(pic.premiumBps, 2) : "..."}</div>
        </div>
      </div>
      <div className="preview-prem">
        <span>{pic ? `${pic.ref.source ? SOURCE[pic.ref.source] : ""} price, ${SESSION[pic.session]}` : " "}</span>
        <span>{verdict}</span>
      </div>
      <ul className="preview-checks">
        {shown.length
          ? shown.map((c) => (
              <li key={c.id}>
                <CheckIcon c={c} />
                <span>{c.label}</span>
              </li>
            ))
          : [0, 1, 2].map((i) => (
              <li key={i}>
                <span className="skeleton" style={{ width: "70%", height: 14 }} />
              </li>
            ))}
      </ul>
      <div className="preview-foot">
        <span className="muted">Same checks as a live order</span>
        <Link to="/app?tab=buy&asset=TSLA" className="text-link">
          Try it <ArrowRight size={14} weight="bold" />
        </Link>
      </div>
    </div>
  );
}

const STEPS = [
  { title: "Reference", body: "Every order is measured against the real price: the stock's price from Finnhub, checked against the issuer's price, for public stocks, and the PreStocks mark for pre-IPO. Each price shows its source and age." },
  { title: "Checks", body: "Fresh reference, market session, token state and slippage after fees are checked on every quote. Off-hours fills only happen if you opt in." },
  { title: "Execution", body: "Jupiter routes the swap and Solana settles it in one transaction. Your limit becomes the on-chain minimum out, so a late price move can't fill past it." },
  { title: "Refusals", body: "When the price is past your limit or a check fails, Tandem does not fill. It records why, with the price it saw, on the public Proof page." },
];

const FAQ = [
  {
    q: "What is the real price?",
    a: "For a public stock, the stock's own price from Finnhub, which must agree with the issuer Backed's price within 0.5% before a live order fills in market hours. For a pre-IPO token, its PreStocks mark. Every price in the app shows where it came from and how old it is.",
  },
  {
    q: "What happens when the US market is closed?",
    a: "By default, orders on public stocks wait for the open. You can allow off-hours fills with a separate limit. Off-hours, the real price is the last regular-session price, and it does not move until the market reopens.",
  },
  {
    q: "Does Tandem hold my funds?",
    a: "No. Automatic orders use an SPL approval capped at the exact amount, so your tokens stay in your wallet until the order fills, and you can revoke from My orders at any time. Pre-IPO orders are signed by you in one tap. The keeper holds only SOL for network fees.",
  },
  {
    q: "What does it cost?",
    a: "Tandem charges no fee today. You pay Solana network fees, the pool spread, and PreStocks' 1% transfer fee on pre-IPO tokens. The app shows all of it before you place an order.",
  },
  {
    q: "Do I need to keep Tandem open?",
    a: "No. Tandem checks every order on its server around the clock. Turn on Telegram alerts in My orders to hear when a one-tap order is ready, or when any order fills.",
  },
  {
    q: "Who can use it?",
    a: "Anyone with a Solana wallet where xStocks and PreStocks are offered. Both are issued outside the US, and their terms cover eligibility.",
  },
];

function PreIpoTile({ q, onPick }: { q: AssetQuote; onPick: () => void }) {
  const asset = ASSETS.find((a) => a.ticker === q.ticker)!;
  const above = (q.pegBps ?? 0) >= 0;
  return (
    <button className="tile" onClick={onPick}>
      <div className="tile-top">
        <Logo asset={asset} />
        <span className="tile-name">{asset.name}</span>
      </div>
      <div className="tile-prem num">
        {q.pegBps === undefined ? "..." : pct(q.pegBps)}
        {q.pegBps !== undefined && (above ? <ArrowUpRight size={16} weight="bold" /> : <ArrowDownRight size={16} weight="bold" />)}
      </div>
      <div className="tile-sub">{q.pegBps === undefined ? " " : above ? "above its mark" : "below its mark"}</div>
    </button>
  );
}

type ProofData = {
  fills: { at: number; order: string; signature: string; premiumBps?: number; session?: string }[];
  refusals: { at: number; order: string; check: string; detail: string }[];
};
type DriftRow = { ticker: string; session: string; samples: number; over50: number };

export function Landing() {
  const { market } = useAppData();
  const navigate = useNavigate();
  const [proof, setProof] = useState<ProofData>();
  const [offShare, setOffShare] = useState<{ share: number; since: number }>();
  useReveal([Boolean(market)]);

  const load = useCallback(() => {
    fetch("/api/proof")
      .then((r) => r.json())
      .then(setProof)
      .catch(() => {});
    // One Radar number for the problem section: how often public-stock tokens sit more than 0.5% off the real price off-hours.
    fetch("/api/drift/summary?hours=168")
      .then((r) => r.json())
      .then((s: { from: number; first?: number; rows: DriftRow[] }) => {
        const off = s.rows.filter((r) => ASSETS.find((a) => a.ticker === r.ticker)?.kind === "xstock" && (r.session === "extended" || r.session === "weekend"));
        const n = off.reduce((a, r) => a + r.samples, 0);
        if (n > 100) setOffShare({ share: off.reduce((a, r) => a + r.over50 * r.samples, 0) / n, since: s.first ?? s.from });
      })
      .catch(() => {});
  }, []);
  usePoll(load, 60_000);

  const pre = market?.assets.filter((a) => a.kind === "prestock" && !isConverting(a.ticker)) ?? [];
  const fills = proof?.fills.slice(0, 3) ?? [];
  const refusal = proof?.refusals[0];

  return (
    <div className="landing">
      <header className="l-nav">
        <div className="l-wrap l-nav-row">
          <Link to="/" className="brand">
            <BrandMark />
            Tandem
          </Link>
          <nav className="l-links" aria-label="Main">
            <a href="#how">How it works</a>
            <Link to="/radar">Radar</Link>
            <Link to="/proof">Proof</Link>
          </nav>
          <Link to="/app" className="btn btn-primary btn-sm">
            Open the app
          </Link>
        </div>
      </header>

      <main>
        <section className="l-wrap hero">
          <h1>Buy tokenized stocks at the real price.</h1>
          <div className="hero-grid">
            <div className="hero-copy">
              <p>
                Over half of tokenized-stock trading happens when the real market is closed. Tandem prices every order against the real stock and refuses to
                overpay.
              </p>
              <div className="hero-ctas">
                <Link to="/app" className="btn btn-primary">
                  Open the app
                </Link>
                <Link to="/radar" className="btn btn-quiet">
                  See the Radar
                </Link>
              </div>
            </div>
            <LiveOrder />
          </div>
        </section>

        <section className="l-wrap l-section problem reveal">
          <h2>A token is not the stock. Its price drifts.</h2>
          <ol className="problem-list">
            <li>
              <span className="fig num">95%</span>
              <div>
                <h3>Tokenized stocks trade on Solana</h3>
                <p>
                  Solana carries about 95% of onchain tokenized-equity volume (rwa.xyz, July 2026).{" "}
                  <a href="https://cryptobriefing.com/solana-tokenized-stocks-analytics-dashboard" target="_blank" rel="noreferrer">
                    Source
                  </a>
                </p>
              </div>
            </li>
            <li>
              <span className="fig num">&gt;50%</span>
              <div>
                <h3>Of trading happens off-hours</h3>
                <p>
                  More than half of onchain tokenized-equity volume trades outside normal US hours, when the stock itself is not trading.{" "}
                  <a href="https://www.financemagnates.com/thought-leadership/the-convergence-trade-nobody-planned-on-chain-fridays-to-nyse-mondays/" target="_blank" rel="noreferrer">
                    Source
                  </a>
                </p>
              </div>
            </li>
            <li>
              <span className="fig num">{offShare ? `${Math.round(offShare.share * 100)}%` : "Live"}</span>
              <div>
                <h3>Of off-hours time, more than 0.5% off</h3>
                <p>
                  {offShare
                    ? `Share of off-hours minutes a public-stock token traded more than 0.5% from its last close. Tandem data since ${new Date(offShare.since * 1000).toUTCString().slice(5, 16)}.`
                    : "Tandem measures every token against its real price, every minute."}{" "}
                  <Link to="/radar">See the Radar</Link>
                </p>
              </div>
            </li>
          </ol>
          <p className="problem-note">
            Limit orders on Solana trigger on the token&apos;s own swap price, not the stock&apos;s.{" "}
            <a href="https://developers.jup.ag/blog/lov2-the-any-any-problem" target="_blank" rel="noreferrer">
              Jupiter explains why
            </a>
            . Tandem checks the real price instead.
          </p>
        </section>

        <section id="how" className="l-section how-section reveal">
          <div className="l-wrap">
            <h2>From an order to a fair fill.</h2>
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.title}>
                  <span className="dot" aria-hidden />
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="l-wrap l-section proof reveal">
          <div>
            <h2>Live on Solana mainnet.</h2>
            <p>Every live fill links to its transaction, and every refusal keeps the price Tandem saw.</p>
            <Link to="/proof" className="text-link more">
              See all fills and refusals <ArrowRight size={14} weight="bold" />
            </Link>
          </div>
          <table className="proof-table">
            <tbody>
              {fills.map((f) => (
                <tr key={f.signature}>
                  <td className="proof-path">Filled</td>
                  <td className="proof-pair">{f.order}</td>
                  <td className="proof-result">
                    {f.premiumBps !== undefined ? `${pct(f.premiumBps, 2)} vs the real price, ${f.session === "regular" ? "market open" : f.session}. ` : ""}
                    <a href={`https://solscan.io/tx/${f.signature}`} target="_blank" rel="noreferrer" className="proof-link">
                      View transaction <ArrowUpRight size={12} weight="bold" />
                    </a>
                  </td>
                </tr>
              ))}
              {refusal && (
                <tr>
                  <td className="proof-path refused-path">Refused</td>
                  <td className="proof-pair">{refusal.order}</td>
                  <td className="proof-result">
                    {refusal.check}: {refusal.detail}
                  </td>
                </tr>
              )}
              {!proof && (
                <tr>
                  <td className="proof-result">Loading</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Switching, for the advanced order.</h2>
            <p>
              Move from one asset into another when the relationship between them moves your way: Tesla into the S&amp;P 500, OpenAI into Anthropic. The same checks,
              and one atomic transaction.
            </p>
          </div>
          <Link to="/app?tab=switch" className="text-link more">
            Set up a switch <ArrowRight size={14} weight="bold" />
          </Link>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Pre-IPO tokens, with the risk stated.</h2>
            <p>
              PreStocks tokens track private companies against a PreStocks mark. In May 2026 OpenAI and Anthropic said they don&apos;t recognize unapproved share
              transfers, and their tokens fell about 30 to 40%.{" "}
              <a href="https://invezz.com/uk/news/2026/05/13/solana-ai-prestocks-crash-after-openai-and-anthropic-stock-transfer-warnings/" target="_blank" rel="noreferrer">
                Source
              </a>
              . Tandem lists them as higher risk.
            </p>
          </div>
          <div className="tiles">
            {pre.length
              ? pre.map((q) => <PreIpoTile key={q.ticker} q={q} onPick={() => navigate(`/app?tab=buy&asset=${q.ticker}`)} />)
              : Array.from({ length: 7 }, (_, i) => <div key={i} className="tile skeleton" style={{ height: 118 }} />)}
          </div>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Your tokens stay in your wallet.</h2>
          </div>
          <div className="ways">
            <div className="way">
              <h3>Approvals you can see and revoke</h3>
              <p>
                An automatic order asks you to approve the exact amount, and it stays in your wallet until the order fills. My orders shows what the keeper may move,
                read on-chain, with a Revoke now button.
              </p>
            </div>
            <div className="way">
              <h3>What is enforced, and where</h3>
              <p>
                Your limit is the on-chain minimum out, and the keeper can move only what you approved. Sending the output to your wallet is enforced by Tandem&apos;s
                code today; an on-chain program that enforces it is on the roadmap.
              </p>
            </div>
          </div>
        </section>

        <section className="l-wrap l-section faq reveal">
          <h2>Questions</h2>
          <div className="faq-list">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="l-wrap cta-band reveal">
          <div>
            <h2>Place your first order.</h2>
            <p>Paper mode uses live prices and needs no wallet.</p>
          </div>
          <Link to="/app" className="btn btn-primary">
            Open the app
          </Link>
        </section>
      </main>

      <footer className="l-wrap l-foot">
        <div className="foot-row">
          <span>Tandem, on Solana</span>
          <span className="muted">Prices from Finnhub, Backed, PreStocks and Jupiter</span>
        </div>
        <p className="disclaimer">
          Not investment advice. xStocks and PreStocks are offered by their issuers outside the US, provide tokenized economic exposure, and may not confer
          shareholder rights.
        </p>
      </footer>
    </div>
  );
}
