<img src="public/favicon.svg" width="56" height="56" alt="Tandem logo" />

# Tandem

**Buy tokenized stocks at the real price.**

Tandem prices every order for a tokenized stock against the real stock, not the token. Set *"buy $100 of Tesla, paying at most 0.5% over the real price"* and Tandem quotes your actual order size, compares what you would pay with the stock's real price, and fills on Solana only while the price is within your limit. When it is not, Tandem refuses and records why.

[Live app](https://tandem.moonrider.online/app) · [Radar](https://tandem.moonrider.online/radar) · [Proof](https://tandem.moonrider.online/proof)

It covers **13 public stocks (Backed xStocks)** and **7 pre-IPO companies (PreStocks)**. Switching from one asset into another when the relationship between them moves is the advanced order type.

---

## Built during Crypto World's Fair

**Disclosure.** Tandem's first commit is 2026-09-24, inside the hackathon window (Sep 14 to Oct 12, 2026). The first version, a relative-value switching app, was also submitted to Stocklana (Main track, PreStocks bounty) on 2026-09-25. Everything from 2026-10-08 onward was built after that submission: fair-price buy and sell orders, the drift logger and Radar, the Proof page, the trust panel, lifecycle alerts and the platform fee.

| Date | Change |
|---|---|
| 2026-09-24 | [e8dba5e](https://github.com/abdoulore/Tandem/commit/e8dba5e) First version: relative-value switches between xStocks and PreStocks |
| 2026-09-24 | [12524eb](https://github.com/abdoulore/Tandem/commit/12524eb) Pre-IPO price handling · [af93715](https://github.com/abdoulore/Tandem/commit/af93715) landing and app pages |
| 2026-09-25 | [4eb7ad7](https://github.com/abdoulore/Tandem/commit/4eb7ad7) Pre-IPO safety · [bb8543a](https://github.com/abdoulore/Tandem/commit/bb8543a) renamed to Tandem · [af4bcd7](https://github.com/abdoulore/Tandem/commit/af4bcd7) switch builder |
| 2026-09-25 | [58325b9](https://github.com/abdoulore/Tandem/commit/58325b9) market-price sizing · [3dd3732](https://github.com/abdoulore/Tandem/commit/3dd3732) Telegram alerts · [9289443](https://github.com/abdoulore/Tandem/commit/9289443) single engine per server |
| 2026-10-08 | [b5b8ab7](https://github.com/abdoulore/Tandem/commit/b5b8ab7) Drift logger: every token against its reference, every minute |
| 2026-10-08 | [dcf084c](https://github.com/abdoulore/Tandem/commit/dcf084c) Health endpoint · [9311627](https://github.com/abdoulore/Tandem/commit/9311627) SpaceX marked as listed and paused |
| 2026-10-08 | [7401252](https://github.com/abdoulore/Tandem/commit/7401252) USDC alongside Token-2022 stock tokens |
| 2026-10-08 | [bceaa6f](https://github.com/abdoulore/Tandem/commit/bceaa6f) Fair-price order model · [4290713](https://github.com/abdoulore/Tandem/commit/4290713) engine · [f7180ac](https://github.com/abdoulore/Tandem/commit/f7180ac) API · [f02edde](https://github.com/abdoulore/Tandem/commit/f02edde) buy and sell forms |
| 2026-10-08 | [7af1f66](https://github.com/abdoulore/Tandem/commit/7af1f66) Radar · [4304176](https://github.com/abdoulore/Tandem/commit/4304176) Proof · [9318542](https://github.com/abdoulore/Tandem/commit/9318542) trust panel · [a7a917c](https://github.com/abdoulore/Tandem/commit/a7a917c) lifecycle alerts |
| 2026-10-08 | [8bb817b](https://github.com/abdoulore/Tandem/commit/8bb817b) Optional platform fee · [60f314d](https://github.com/abdoulore/Tandem/commit/60f314d) landing rewrite |
| 2026-10-08 | [8b6483a](https://github.com/abdoulore/Tandem/commit/8b6483a) Finnhub stock reference, cross-checked against Backed |

## Why

- Solana carries about 95% of onchain tokenized-equity volume ([rwa.xyz, July 2026](https://cryptobriefing.com/solana-tokenized-stocks-analytics-dashboard)).
- More than half of that volume trades outside normal US hours, when the stock itself is not trading ([Blockworks and RWA.xyz, cited](https://www.financemagnates.com/thought-leadership/the-convergence-trade-nobody-planned-on-chain-fridays-to-nyse-mondays/)). That is when tokens drift from their stock ([Pine Analytics](https://pineanalytics.substack.com/p/tokenized-equities-on-solana)).
- Limit and trigger orders on Solana run on the token's own swap price ([Jupiter](https://developers.jup.ag/blog/lov2-the-any-any-problem)), so they cannot tell a fair price from a premium.

Tandem prices the order against the stock instead, and refuses to fill past the user's limit.

## Verified on Solana mainnet

**Live.** A one-tap switch created in the app, triggered by the engine and confirmed from a wallet:

| | |
|---|---|
| Transaction | [`2LxBEz5p…DraCEfvJ`](https://solscan.io/tx/2LxBEz5pmcL9BZkjmuYY3xVtZ5ZieLm9jNZUv4AEU3c4QPtbnwY65XbzRk6HdLLWoBConUiEmrEnZntfDraCEfvJ) |
| When | 2026-09-25 10:17 UTC, slot 450,323,285 |
| Order | Switch OpenAI into Anthropic, one tap |
| Spent / received | 0.004884 OPENAI / 0.006181 ANTHROPIC, into an account created in the same transaction |
| Route | OpenAI to USDC to SOL to Anthropic via Jupiter, 153k compute units |

Live fair-price fills and refusals are listed as they happen on the [Proof page](https://tandem.moonrider.online/proof).

**Simulated** with `simulateTransaction` against current mainnet state, using real holders as stand-ins:

| Path | Order | Result |
|---|---|---|
| Fair buy, keeper (`scripts/simulate-fair.ts`) | $5 USDC into TSLAx | Exactly 5.000000 USDC pulled, received equal to the quote, new account opened in the same transaction, $372.28 a share |
| Fair sell, keeper | TSLAx into $5 USDC | Exactly the order amount pulled, received above the on-chain minimum, $372.20 a share |
| Fair sell with a 10 bps platform fee | TSLAx into $5 USDC | Fee account received 4,999 raw USDC through the same transaction |
| Switch, keeper (`scripts/simulate.ts`) | SPYx into NVDAx | Received above the quote, one atomic transaction |
| Switch, one tap (`scripts/sim-confirm.ts`) | Anthropic into OpenAI | Received inside the minimum after the 1% PreStocks input fee |

**Refused.** A live TSLA buy whose price was within its limit was refused because the reference was Backed's price rather than a trusted feed: "Trusted reference price: TSLA: Backed via Jupiter, live needs Pyth or PreStocks prices", recorded with the real price it saw ($373.09) and the token's premium (-0.13%).

Two corrections Tandem makes along the way: Jupiter's quotes leave out the Token-2022 transfer fee on the input token, so Tandem prices it itself; and Jupiter sizes the compute limit for its swap alone, so the keeper's transaction adds room for its own instructions.

## What the data shows

Tandem logs every token against its real price every minute, and quotes a $100 buy of each one every five minutes (`server/drift.ts`). The [Radar](https://tandem.moonrider.online/radar) shows it live; `npm run drift:report -- --since 2026-10-09` prints medians, p90s and the share of time each token sits more than 0.5%, 1% and 2% from its reference, by US session. Figures for the full window, including the weekend, are added here after it closes.

Off-hours, the "real price" is the last regular-session price; pre-market, after-hours and overnight prices are not included. In market hours, rows priced by Backed (data logged before Finnhub was added, or when Finnhub is unavailable) can lag the stock by a few minutes, and the Radar marks them.

## How it works

1. **Order.** Buy or sell an amount in dollars or shares, with a limit: "pay at most 0.5% over the real price", or "sell for no less than 0.5% under". Off-hours fills are off unless you allow them, with their own limit.
2. **Reference.** The real price is the stock's price from Finnhub for public stocks, and the PreStocks mark for pre-IPO tokens. In market hours a live order also needs Finnhub to agree with the issuer Backed's price within 0.5%; if Finnhub is unavailable, live orders pause rather than run on one source. Every price shows its source and age.
3. **Quote.** Every 20 seconds Tandem quotes your actual order size through Jupiter, after fees, and compares the effective price with the reference.
4. **Checks.** The price must be within your limit on 3 separate quotes, and every check must pass: trusted and fresh reference (or, off-hours, a last real price under 100 hours old and your opt-in), references in agreement, no dividend or split in flight, token not paused, slippage within your limit after fees, funds approved, and the live cap.
5. **Execution.** Public stocks run automatically: you approve the exact amount once, and the keeper sends one atomic transaction that pulls it, swaps through Jupiter, and delivers the tokens to your wallet. Your limit is the swap's on-chain minimum out. Pre-IPO tokens charge 1% per transfer, so you confirm those yourself in one tap.
6. **Refusals.** When the price moves past your limit or a check fails, Tandem does not fill, and logs the refusal with the price it saw.

**Switches** use the same checks: move from one asset into another when the price of one in units of the other moves by your threshold, confirmed across 3 fresh price updates on each leg.

## PreStocks integration

- Marks, token prices and implied valuations for every PreStocks company, with premium or discount to the mark shown live and enforced.
- The mark is the reference for pre-IPO orders. Companies that list (SpaceX, as SPCX, in June 2026) leave the pre-IPO views, live orders pause, and holders get a conversion reminder before the deadline ([DefiLlama](https://defillama.com/rwa/asset/SPACEX)).
- The 1% Token-2022 transfer fee is priced into every quote, PreStocks are never moved an extra time, and pre-IPO orders default to a 2.5% slippage limit for thinner pools.
- Pre-IPO tokens are labelled higher risk: in May 2026 OpenAI and Anthropic said they don't recognize unapproved share transfers ([Invezz](https://invezz.com/uk/news/2026/05/13/solana-ai-prestocks-crash-after-openai-and-anthropic-stock-transfer-warnings/)).

## Security model

- **Your tokens stay in your wallet until an order fills.** Automatic orders use a standard SPL approval capped at the exact amount. My orders shows what the keeper may move, read on-chain, with a Revoke now button.
- **Your limit is enforced on-chain** as the swap's minimum out. The whole transaction reverts if it can't be met.
- **The keeper holds only SOL** for network fees and can move only what you approved. Sending the output to your wallet is enforced by Tandem's server code today, not by an on-chain program; that program is on the roadmap.
- **Only you can place or cancel a live order.** Both need a signature from your wallet.
- **Live orders are capped** (`MAX_LIVE_USD`, default $250), and live execution can be switched off entirely (`LIVE_EXECUTION=false`).
- **Live trading needs a trusted reference.** Without one, public-stock orders run in paper mode.

## Architecture

```
browser (React + Solana wallet adapter)
   │  orders, previews, signed messages and transactions
   ▼
server (Node + Express, one process)
   ├─ prices.ts      Finnhub stock prices, Backed prices via Jupiter, PreStocks API, Pyth Hermes (per-feed entitlement), market hours
   ├─ tokenState.ts  Token-2022 state: scaled-UI multiplier, pause flag, transfer fees
   ├─ engine.ts      switch and fair-price evaluation, checks, quotes, execution, refusals
   ├─ drift.ts       drift logger: every token vs its reference each minute, $100 quote probes
   ├─ jupiter.ts     quotes, swap instructions, swap transactions, platform fee
   ├─ solana.ts      approvals, revokes, the atomic keeper transaction, submission
   ├─ lifecycle.ts   conversion deadlines, multiplier changes, pauses
   ├─ telegram.ts    alerts
   └─ store.ts       orders (JSON file under DATA_DIR)
shared/              assets, fair-price math, types, signed messages (used by both sides)
```

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env         # add PYTH_API_KEY and a private RPC URL if you have them
npm run keygen               # creates the keeper wallet in .env
npm run dev                  # site on http://localhost:5173, API on :8787
```

Paper mode works with no key and no wallet. Production: `npm run build && npm start`.

```bash
npm test                                         # intent parser
npm run test:fair                                # fair-price math, then paper orders on live prices
npm run drift                                    # standalone drift logger
npm run drift:report -- --since 2026-10-09       # drift statistics by ticker and session
npx tsx scripts/simulate-fair.ts buy TSLA 5      # dry-run a fair buy on mainnet state (or: sell TSLA 5)
npm run simulate -- SPY NVDA 50                  # dry-run an automatic switch
npx tsx scripts/sim-confirm.ts OPENAI ANTHROPIC 0.01   # dry-run a one-tap switch
npx tsx scripts/check-dashes.ts                  # house style check
```

### Configuration

| Variable | Purpose |
|---|---|
| `FINNHUB_API_KEY` | Finnhub stock prices, the live reference for public stocks |
| `PYTH_API_KEY`, `PYTH_HERMES_URL` | Optional Pyth Hermes access. Tandem detects which feeds the key can read and prefers them |
| `SOLANA_RPC_URL` | Mainnet RPC; use a private one in production |
| `JUPITER_API_URL`, `JUPITER_API_KEY` | Jupiter swap API |
| `KEEPER_SECRET_KEY` | Keeper wallet, created by `npm run keygen` |
| `MAX_LIVE_USD` | Live orders above this are refused (default 250) |
| `PLATFORM_FEE_BPS`, `FEE_OWNER` | Optional fee on fair sells, in USDC. Off unless both are set |
| `TELEGRAM_BOT_TOKEN`, `APP_URL` | Optional Telegram alerts and their links |
| `DATA_DIR` | Where orders and drift logs are written |
| `LIVE_EXECUTION` | `false` disables all real orders |

## Roadmap

- **On-chain order program** that verifies the reference price and enforces the swap and its recipient, so an approval can only execute the order it was given for.
- **Session price feeds** (Pyth Pro or similar), so pre-market, after-hours and overnight orders use a live price rather than the last close.
- **Issuer routing**: quote xStocks and Ondo tokens for the same stock against the same reference, and fill on the better one.
- **Jupiter Swap V2** migration, which also allows fees on buys.
- **A fair-price API** for wallets and lending markets that need to know whether a token trades at its stock's price.

Not investment advice. xStocks and PreStocks are offered by their issuers outside the US; see their terms for eligibility.
