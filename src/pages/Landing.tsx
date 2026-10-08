import { useState } from "react";
import { Logo } from "../components/Logo";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle, Clock, XCircle } from "@phosphor-icons/react";
import { ASSETS, isConverting, lifecycleNote, type Asset } from "../../shared/assets";
import type { AssetQuote, Check } from "../../shared/types";
import { api, type Preview } from "../api";
import { BrandMark } from "../components/Brand";
import { usePoll, useReveal } from "../lib/hooks";
import { useAppData } from "../state/AppData";
import "./landing.css";

const HERO_DRAFT = {
  from: "OPENAI",
  to: "ANTHROPIC",
  sizing: { kind: "usd" as const, usd: 100 },
  direction: "cheaper" as const,
  thresholdPct: 10,
  mode: "paper" as const,
  text: "Move $100 from OpenAI into Anthropic when Anthropic becomes 10% cheaper relative to OpenAI",
};

const CTA = "Create a switch";

const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const move = (p: number) => `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

function Sparkline({ series }: { series: { t: number; r: number }[] }) {
  const W = 320;
  const H = 64;
  if (series.length < 2) return <div className="spark-empty">Collecting price history</div>;
  const vals = series.map((p) => p.r);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i: number) => (i / (series.length - 1)) * (W - 8) + 2;
  const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 12);
  const d = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join("");
  const last = series[series.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Anthropic priced in OpenAI, recent history">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(series.length - 1)} cy={y(last.r)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

// The teaser smooths single-poll mark noise with a 5-point rolling median; the app chart shows raw data.
function median5(s: { t: number; r: number }[]) {
  return s.map((p, i) => {
    const w = s.slice(Math.max(0, i - 2), i + 3).map((q) => q.r).sort((a, b) => a - b);
    return { t: p.t, r: w[Math.floor(w.length / 2)] };
  });
}

const CheckIcon = ({ c }: { c: Check }) =>
  c.pending ? <Clock size={16} weight="bold" className="ic-pending" /> : c.ok ? <CheckCircle size={16} weight="fill" className="ic-good" /> : <XCircle size={16} weight="fill" className="ic-bad" />;

/** The real product, running on live data: the hero's right side. */
function LivePreview({ market }: { market?: { assets: AssetQuote[] } }) {
  const [p, setP] = useState<Preview>();
  const [series, setSeries] = useState<{ t: number; r: number }[]>([]);
  usePoll(() => api.preview(HERO_DRAFT).then(setP).catch(() => {}), 15_000);
  usePoll(
    () =>
      api
        .pair("OPENAI", "ANTHROPIC")
        .then((r) => setSeries(median5(r.series.filter((q) => q.t >= Date.now() / 1000 - 86_400))))
        .catch(() => {}),
    30_000,
  );
  const recent = series.length > 1 ? (series[series.length - 1].r / series[0].r - 1) * 100 : undefined;
  const fullDay = series.length > 1 && series[0].t <= Date.now() / 1000 - 20 * 3600;
  const cost = p?.quote ? (p.quote.feeBps + Math.max(0, p.quote.shortfallBps)) / 100 : undefined;
  const prem = (t: string) => market?.assets.find((a) => a.ticker === t)?.pegBps;
  const pick = (id: string) => p?.checks.find((c) => c.id === id);
  const shown = [pick("fresh"), pick("private"), pick("quote")].filter(Boolean) as Check[];
  return (
    <div className="preview card">
      <div className="preview-pair">
        OpenAI <ArrowRight size={14} weight="bold" /> Anthropic
      </div>
      <div className="preview-sentence">{"“"}{HERO_DRAFT.text}{"”"}</div>
      <div className="preview-nums three">
        <div>
          <div className="k">{fullDay ? "Last 24h" : "Recent move"}</div>
          <div className="v num">{recent !== undefined ? move(recent) : "..."}</div>
        </div>
        <div>
          <div className="k">Switch fires at</div>
          <div className="v num">-10.0%</div>
        </div>
        <div>
          <div className="k">Costs</div>
          <div className="v num">{cost !== undefined ? `${cost.toFixed(1)}%` : "..."}</div>
        </div>
      </div>
      <Sparkline series={series} />
      <div className="preview-prem">
        <span>
          OpenAI <strong className="num">{prem("OPENAI") !== undefined ? pct(prem("OPENAI")!) : "..."}</strong> vs mark
        </span>
        <span>
          Anthropic <strong className="num">{prem("ANTHROPIC") !== undefined ? pct(prem("ANTHROPIC")!) : "..."}</strong> vs mark
        </span>
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
        <span className="muted">Live PreStocks marks for both companies</span>
        <Link to="/app" className="text-link">
          Try it <ArrowRight size={14} weight="bold" />
        </Link>
      </div>
    </div>
  );
}

const STEPS = [
  { title: "Define", body: "Pick two assets, an amount and a condition. Tandem turns it into a deterministic order and reads it back in plain words." },
  { title: "Measure", body: "It prices one asset in units of the other from reference prices, fixes the baseline, and marks the level that fires." },
  { title: "Verify", body: "Fresh reference data, token state, premium to mark, fees, liquidity and slippage are checked before anything moves." },
  { title: "Execute", body: "Jupiter routes the switch and Solana settles it in one transaction with a hard minimum out." },
];

const CHECK_GROUPS = [
  {
    title: "Reference data",
    items: ["PreStocks marks for pre-IPO, Pyth for public stocks", "Fresh within 3 minutes for marks, 60 seconds for Pyth", "US market open for any public stock", "Pyth confidence interval tight"],
  },
  {
    title: "Asset",
    items: ["Pre-IPO tokens within 10% of their mark", "xStocks within 1.5% of their stock", "No dividend or split in flight", "Not paused by the issuer"],
  },
  {
    title: "Execution",
    items: ["Trigger holds across 3 fresh price updates", "Slippage within your limit, after fees", "Hard minimum out, enforced on-chain"],
  },
];

const LIVE_TX = "https://solscan.io/tx/2LxBEz5pmcL9BZkjmuYY3xVtZ5ZieLm9jNZUv4AEU3c4QPtbnwY65XbzRk6HdLLWoBConUiEmrEnZntfDraCEfvJ";

const PROOF: { path: string; pair: string; result: string; href?: string }[] = [
  { path: "Live, one tap", pair: "OpenAI to Anthropic", result: "Triggered by the engine, confirmed from a wallet, settled in one transaction", href: LIVE_TX },
  { path: "Simulated, one tap", pair: "OpenAI to Anthropic", result: "Output matched the fee-adjusted quote to within 0.001%" },
  { path: "Simulated, automatic", pair: "Tesla to SpaceX", result: "Public stock into a PreStocks token, new token account opened in the same transaction" },
  { path: "Simulated, automatic", pair: "S&P 500 to NVIDIA", result: "One atomic transaction: 968 bytes, 140k compute units" },
];

const FAQ = [
  {
    q: "Does Tandem hold my funds?",
    a: "No. One-tap switches are signed by you from your own wallet. Automatic switches use an SPL approval capped at the exact amount, and tokens only move inside the switch transaction. You can revoke or cancel at any time.",
  },
  {
    q: "Do I need to keep Tandem open?",
    a: "No. Tandem watches every switch on its server around the clock, and automatic switches execute on their own. For one-tap switches, turn on Telegram alerts in My switches: you get a message the moment one is ready, with buttons that open it in your mobile wallet.",
  },
  {
    q: "What does it cost?",
    a: "Tandem charges nothing. You pay Solana network fees, the pool spread, and PreStocks' 1% transfer fee on pre-IPO tokens. The app shows all of it before you arm a switch.",
  },
  {
    q: "Where do the prices come from?",
    a: "PreStocks marks for pre-IPO tokens and Pyth for public stocks. Every price in the app shows its source and age, and live switches only run on fresh PreStocks or Pyth data.",
  },
  {
    q: "What happens when the US market is closed?",
    a: "Pre-IPO switches keep running. Switches involving a public stock wait, because Tandem won't act on a stock price that isn't moving.",
  },
  {
    q: "Who can use it?",
    a: "Anyone with a Solana wallet where xStocks and PreStocks are offered. Both are issued outside the US; their terms cover eligibility.",
  },
  {
    q: "How do I start?",
    a: "Create a switch and keep it in paper mode: same checks and quotes on live prices, no funds move. When you go live, one-tap switches need only your wallet.",
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

export function Landing() {
  const { market } = useAppData();
  const navigate = useNavigate();
  useReveal([Boolean(market)]);

  // Companies that have listed no longer have a private mark, so they leave the pre-IPO views.
  const pre = market?.assets.filter((a) => a.kind === "prestock" && !isConverting(a.ticker)) ?? [];
  const pub = ASSETS.filter((a) => a.kind === "xstock");
  const priv = ASSETS.filter((a) => a.kind === "prestock" && !isConverting(a.ticker));
  const converting = ASSETS.filter((a) => isConverting(a.ticker));

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
            <Link to="/app/markets">Markets</Link>
          </nav>
          <Link to="/app" className="btn btn-primary btn-sm">
            {CTA}
          </Link>
        </div>
      </header>

      <main>
        <section className="l-wrap hero">
          <h1>Switch when the relationship is right, not just the price.</h1>
          <div className="hero-grid">
            <div className="hero-copy">
              <p>Set a private-market or relative-value condition. Tandem watches the reference data and switches on Solana when it's met.</p>
              <div className="hero-ctas">
                <Link to="/app" className="btn btn-primary">
                  {CTA}
                </Link>
                <Link to="/app/markets" className="btn btn-quiet">
                  Explore markets
                </Link>
              </div>
            </div>
            <LivePreview market={market} />
          </div>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Pre-IPO tokens rarely trade at their mark.</h2>
            <p>Live from PreStocks. Tandem turns these gaps into executable conditions, and won't buy far above a company's mark or sell far below it.</p>
          </div>
          <div className="tiles">
            {pre.length
              ? pre.map((q) => <PreIpoTile key={q.ticker} q={q} onPick={() => navigate(`/app?to=${q.ticker}`)} />)
              : Array.from({ length: 8 }, (_, i) => <div key={i} className="tile skeleton" style={{ height: 118 }} />)}
          </div>
          <Link to="/app/markets" className="text-link more">
            Explore markets <ArrowRight size={14} weight="bold" />
          </Link>
        </section>

        <section className="l-wrap l-section problem reveal">
          <h2>Rotating by hand is slow, and blind.</h2>
          <ol className="problem-list">
            <li>
              <span className="fig num">2 trades</span>
              <div>
                <h3>Sell to cash, then buy back</h3>
                <p>Every manual rotation leaves you exposed in the gap between two trades.</p>
              </div>
            </li>
            <li>
              <span className="fig num">1%</span>
              <div>
                <h3>Fees that eat small moves</h3>
                <p>PreStocks charge 1% per transfer. On a thin move, a careless route leaves nothing.</p>
              </div>
            </li>
            <li>
              <span className="fig num">24/7</span>
              <div>
                <h3>Tokens trade when stocks don't</h3>
                <p>At night and on weekends a public-stock token can drift from its stock, and you pay the drift.</p>
              </div>
            </li>
          </ol>
        </section>

        <section id="how" className="l-section how-section reveal">
          <div className="l-wrap">
            <h2>From a condition to a settled switch.</h2>
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

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Checked before every trade.</h2>
            <p>If any check fails, the switch waits. Your limits never loosen on their own.</p>
          </div>
          <div className="check-groups">
            {CHECK_GROUPS.map((g) => (
              <div key={g.title}>
                <h3>{g.title}</h3>
                <ul>
                  {g.items.map((it) => (
                    <li key={it}>
                      <CheckCircle size={16} weight="fill" className="ic-good" />
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>Your tokens stay in your wallet until they switch.</h2>
          </div>
          <div className="ways">
            <div className="way">
              <h3>One tap, for pre-IPO</h3>
              <p>
                PreStocks charge a 1% transfer fee, so Tandem never moves them an extra time. When every check passes you get a Ready alert, in the app or on Telegram,
                and confirm the swap from your own wallet, phone included.
              </p>
            </div>
            <div className="way">
              <h3>Automatic, for public stocks</h3>
              <p>
                Approve an exact amount once. When the trigger fires, one atomic transaction swaps it and delivers the new token to your wallet. Revoke any time.
              </p>
            </div>
          </div>
        </section>

        <section className="l-wrap l-section proof reveal">
          <div>
            <h2>Live on Solana mainnet.</h2>
            <p>A real switch has settled on mainnet, and every live path was also simulated against current mainnet state using real token holders.</p>
          </div>
          <table className="proof-table">
            <tbody>
              {PROOF.map((r) => (
                <tr key={r.path + r.pair}>
                  <td className="proof-path">{r.path}</td>
                  <td className="proof-pair">{r.pair}</td>
                  <td className="proof-result">
                    {r.result}
                    {r.href && (
                      <>
                        {" "}
                        <a href={r.href} target="_blank" rel="noreferrer" className="proof-link">
                          View transaction <ArrowUpRight size={12} weight="bold" />
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="l-wrap l-section reveal">
          <div className="section-lead">
            <h2>21 assets. Mix private and public.</h2>
            <p>Switch between any two: OpenAI into Anthropic, Tesla into OpenAI, the S&amp;P 500 into NVIDIA.</p>
          </div>
          <div className="coverage">
            <div>
              <h3>Pre-IPO companies, via PreStocks</h3>
              <div className="pills">
                {priv.map((a) => (
                  <span className="pill" key={a.ticker}>
                    <Logo asset={a} size={18} />
                    {a.name}
                  </span>
                ))}
              </div>
              {converting.map((a) => (
                <p className="muted converting-note" key={a.ticker}>
                  <Logo asset={a} size={16} /> {a.name}: {lifecycleNote(a)}
                </p>
              ))}
            </div>
            <div>
              <h3>Public stocks, via Backed xStocks</h3>
              <div className="pills">
                {pub.map((a) => (
                  <span className="pill" key={a.ticker}>
                    <Logo asset={a} size={18} />
                    {a.ticker}
                  </span>
                ))}
              </div>
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
            <h2>Set up your first switch.</h2>
            <p>Paper mode uses live prices and needs no wallet.</p>
          </div>
          <Link to="/app" className="btn btn-primary">
            {CTA}
          </Link>
        </section>
      </main>

      <footer className="l-wrap l-foot">
        <div className="foot-row">
          <span>Tandem, built on Solana for Stocklana</span>
          <span className="muted">Prices from PreStocks, Pyth and Jupiter</span>
        </div>
        <p className="disclaimer">
          PreStocks and xStocks provide tokenized economic exposure and may not confer shareholder rights. Availability depends on jurisdiction.
        </p>
      </footer>
    </div>
  );
}
