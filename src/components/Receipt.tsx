import { ArrowSquareOut } from "@phosphor-icons/react";
import { tokenSymbol } from "../../shared/assets";
import { describeCondition, fmtNum } from "../../shared/math";
import type { Intent, RefSnapshot } from "../../shared/types";

const SOURCE = { pyth: "Pyth", prestocks: "PreStocks mark", jupiter: "Backed via Jupiter" } as const;
const pct = (n: number, d = 2) => `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
const ageText = (s: number) => (s < 90 ? `${s}s old` : `${Math.round(s / 60)}m old`);

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="r-row">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Ref({ t, r }: { t: string; r?: RefSnapshot }) {
  if (!r) return <Row k={t} v="n/a" />;
  return <Row k={t} v={`${r.source ? SOURCE[r.source] : "n/a"}, $${r.price.toFixed(2)}, ${ageText(r.ageSec)}`} />;
}

/** Why and how a fair-price order filled: the real price, what was paid or received, and the premium. */
function FairReceipt({ i }: { i: Intent }) {
  const x = i.execution!;
  const f = x.fair!;
  const spec = i.fair!;
  const limit = spec.side === "buy" ? `at most ${(spec.limitBps / 100).toFixed(2)}% over` : `at most ${(spec.limitBps / 100).toFixed(2)}% under`;
  return (
    <div className="receipt">
      <section>
        <h4>Why it filled</h4>
        <dl>
          <Row k="Order" v={`${spec.side === "buy" ? "Buy" : "Sell"} ${spec.asset}, ${limit} the real price`} />
          <Row k="Session" v={f.session === "regular" ? "US market open" : f.session === "24/7" ? "Trades 24/7" : `Off-hours (${f.session}), opted in`} />
          <Row k="Confirmation" v={`${i.limits.confirmations} of ${i.limits.confirmations} quotes within the limit`} />
        </dl>
      </section>
      <section>
        <h4>Price</h4>
        <dl>
          <Ref t="Real price" r={f.ref} />
          <Row k={spec.side === "buy" ? "Paid" : "Received"} v={<span className="num">${f.effPrice.toFixed(4)} a share</span>} />
          <Row k="Vs real price" v={<span className="num">{pct(f.premiumBps / 100)}</span>} />
        </dl>
      </section>
      <section>
        <h4>Execution</h4>
        <dl>
          <Row k="Input" v={<span className="num">{fmtNum(x.inUi)} {tokenSymbol(i.from)}</span>} />
          {x.expectedOutUi !== undefined && <Row k="Expected output" v={<span className="num">{fmtNum(x.expectedOutUi)} {tokenSymbol(i.to)}</span>} />}
          <Row k={x.paper ? "Simulated output" : "Actual output"} v={<span className="num">{fmtNum(x.outUi)} {tokenSymbol(i.to)}</span>} />
          {x.feeBps !== undefined && <Row k="Transfer fees" v={x.feeBps > 0 ? `${(x.feeBps / 100).toFixed(1)}%` : "none"} />}
          {!!x.platformFeeBps && <Row k="Tandem fee" v={`${(x.platformFeeBps / 100).toFixed(2)}%, in USDC`} />}
          <Row k="Route" v={x.route} />
        </dl>
      </section>
      <Settlement i={i} />
    </div>
  );
}

function Settlement({ i }: { i: Intent }) {
  const x = i.execution!;
  return (
    <section>
      <h4>Settlement</h4>
      <dl>
        {x.paper ? (
          <Row k="Mode" v="Paper: live prices, no funds moved" />
        ) : (
          <>
            <Row k="Network" v="Solana" />
            <Row
              k="Transaction"
              v={
                x.signature ? (
                  <a href={`https://solscan.io/tx/${x.signature}`} target="_blank" rel="noreferrer">
                    {x.signature.slice(0, 6)}...{x.signature.slice(-6)} <ArrowSquareOut size={12} />
                  </a>
                ) : (
                  "n/a"
                )
              }
            />
          </>
        )}
        <Row k="Executed" v={new Date(x.at).toLocaleString()} />
      </dl>
    </section>
  );
}

/** Why and how a switch executed, from the numbers recorded at the time. */
export function Receipt({ i }: { i: Intent }) {
  const x = i.execution!;
  if (i.kind === "fair" && x.fair) return <FairReceipt i={i} />;
  const moved = (x.ratio / i.baseline.ratio - 1) * 100;
  return (
    <div className="receipt">
      <section>
        <h4>Why it executed</h4>
        <dl>
          <Row k="Condition" v={describeCondition(i.from, i.to, i.direction, i.thresholdPct)} />
          <Row k="Move at execution" v={<span className="num">{pct(moved, 1)}</span>} />
          <Row
            k="Ratio"
            v={
              <span className="num">
                {i.baseline.ratio.toFixed(5)} baseline, {i.triggerRatio.toFixed(5)} trigger, {x.ratio.toFixed(5)} observed
              </span>
            }
          />
          <Row k="Confirmation" v={`${i.limits.confirmations} of ${i.limits.confirmations} fresh price updates`} />
        </dl>
      </section>
      <section>
        <h4>Reference data</h4>
        <dl>
          <Ref t={i.from} r={x.refs?.from} />
          <Ref t={i.to} r={x.refs?.to} />
        </dl>
      </section>
      <section>
        <h4>Execution</h4>
        <dl>
          <Row k="Input" v={<span className="num">{fmtNum(x.inUi)} {tokenSymbol(i.from)}</span>} />
          {x.expectedOutUi !== undefined && <Row k="Expected output" v={<span className="num">{fmtNum(x.expectedOutUi)} {tokenSymbol(i.to)}</span>} />}
          <Row k={x.paper ? "Simulated output" : "Actual output"} v={<span className="num">{fmtNum(x.outUi)} {tokenSymbol(i.to)}</span>} />
          {x.feeBps !== undefined && <Row k="Transfer fees" v={x.feeBps > 0 ? `${(x.feeBps / 100).toFixed(1)}%` : "none"} />}
          <Row k="Vs market, after fees" v={<span className="num">{pct(-x.shortfallBps / 100)}</span>} />
          <Row k="Max slippage" v={`${(i.limits.maxSlippageBps / 100).toFixed(2)}%`} />
          <Row k="Route" v={x.route} />
        </dl>
      </section>
      <section>
        <h4>Settlement</h4>
        <dl>
          {x.paper ? (
            <Row k="Mode" v="Paper: live prices, no funds moved" />
          ) : (
            <>
              <Row k="Network" v="Solana" />
              <Row
                k="Transaction"
                v={
                  x.signature ? (
                    <a href={`https://solscan.io/tx/${x.signature}`} target="_blank" rel="noreferrer">
                      {x.signature.slice(0, 6)}...{x.signature.slice(-6)} <ArrowSquareOut size={12} />
                    </a>
                  ) : (
                    "n/a"
                  )
                }
              />
            </>
          )}
          <Row k="Executed" v={new Date(x.at).toLocaleString()} />
        </dl>
      </section>
    </div>
  );
}
