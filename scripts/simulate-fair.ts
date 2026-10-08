// Dry-runs a fair-price order through the keeper path against mainnet state, without moving funds:
//   owner approves keeper -> keeper pulls USDC (buy) or the stock (sell) -> Jupiter swap -> output to owner.
// USDC is classic SPL Token and stock tokens are Token-2022, so this exercises both programs in one transaction.
// Uses real holders as stand-ins and simulateTransaction(sigVerify: false).
// Usage: npx tsx scripts/simulate-fair.ts buy TSLA 5   |   npx tsx scripts/simulate-fair.ts sell TSLA 5
// OWNER=<pubkey> and KEEPER=<pubkey> pin the stand-in wallets instead of scanning recent holders.
// FEE_BPS=<bps> FEE_OWNER=<pubkey> add Tandem's platform fee in USDC and report what the fee account receives.
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createApproveCheckedInstruction } from "@solana/spl-token";
import { USDC, getAsset, legAsset } from "../shared/assets";
import { rawFromUi, uiFromRaw } from "../shared/math";
import { getQuote, routeLabel } from "../server/jupiter";
import { ata, conn, programId, switchInstructions } from "../server/solana";

const [side = "buy", ticker = "TSLA", usdArg = "5"] = process.argv.slice(2);
if (side !== "buy" && side !== "sell") throw new Error("side must be buy or sell");
const usd = Number(usdArg);
const stock = getAsset(ticker);
const from = side === "buy" ? USDC.ticker : stock.ticker;
const to = side === "buy" ? stock.ticker : USDC.ticker;
const src = legAsset(from);
const dst = legAsset(to);

async function multiplier(mint: string) {
  if (mint === USDC.mint) return 1;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const s = (info.value?.data as any).parsed.info.extensions.find((e: any) => e.extension === "scaledUiAmountConfig")?.state;
  if (!s) return 1;
  return Date.now() / 1000 >= Number(s.newMultiplierEffectiveTimestamp) ? Number(s.newMultiplier) : Number(s.multiplier);
}

// Recent traders of the mint, as stand-in wallets (largest-holder calls are rate-limited on public RPCs).
async function holders(mint: string) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 40 });
  const seen = new Map<string, bigint>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) if (b.mint === mint && b.owner) seen.set(b.owner, BigInt(b.uiTokenAmount.amount));
    if (seen.size >= 12) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const out: { owner: PublicKey; amount: bigint; sol: number }[] = [];
  for (const [o] of [...seen].sort((a, b) => (b[1] > a[1] ? 1 : -1))) {
    const owner = new PublicKey(o);
    if (!PublicKey.isOnCurve(owner.toBytes())) continue; // skip program-owned pools
    const bal = await conn.getTokenAccountBalance(ata(owner, mint)).catch(() => null);
    if (!bal) continue; // want a wallet whose canonical account holds the token
    out.push({ owner, amount: BigInt(bal.value.amount), sol: (await conn.getBalance(owner)) / 1e9 });
  }
  return out;
}

const srcMult = await multiplier(src.mint);
const dstMult = await multiplier(dst.mint);
let amountRaw: bigint;
if (side === "buy") amountRaw = BigInt(Math.round(usd * 10 ** USDC.decimals));
else {
  const px = (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${stock.mint}`)).json()) as Record<string, { usdPrice: number }>;
  amountRaw = rawFromUi(usd / px[stock.mint].usdPrice, stock.decimals, srcMult);
}

// OWNER / KEEPER pin the stand-ins; otherwise they come from recent holders of the source token.
async function wallet(pk: string) {
  const owner = new PublicKey(pk);
  const bal = await conn.getTokenAccountBalance(ata(owner, src.mint)).catch(() => null);
  return { owner, amount: BigInt(bal?.value.amount ?? "0"), sol: (await conn.getBalance(owner)) / 1e9 };
}
const hs = process.env.OWNER && process.env.KEEPER ? [] : await holders(src.mint);
const owner = process.env.OWNER ? await wallet(process.env.OWNER) : hs.find((h) => h.amount >= amountRaw && h.sol > 0.01);
const keeper = process.env.KEEPER ? await wallet(process.env.KEEPER) : hs.find((h) => h !== owner && h.sol > 0.05);
if (!owner || !keeper) throw new Error(`Could not find stand-in wallets among ${hs.length} recent ${from} holders`);
console.log(`${side} ${ticker} $${usd}: ${uiFromRaw(amountRaw, src.decimals, srcMult).toFixed(6)} ${from} -> ${to}`);
console.log(`owner  (stand-in) ${owner.owner.toBase58()}  holds ${uiFromRaw(owner.amount, src.decimals, srcMult).toFixed(4)} ${from}`);
console.log(`keeper (stand-in) ${keeper.owner.toBase58()}  ${keeper.sol.toFixed(3)} SOL`);
console.log(`programs: ${from} ${src.program}, ${to} ${dst.program}`);

const feeBps = Number(process.env.FEE_BPS ?? 0);
const feeAcc = feeBps > 0 && process.env.FEE_OWNER ? ata(new PublicKey(process.env.FEE_OWNER), USDC.mint) : undefined;
const quote = await getQuote(src.mint, dst.mint, amountRaw, 50, false, feeAcc ? feeBps : 0);
console.log(`quote: ${quote.outAmount} raw ${to} via ${routeLabel(quote)} (min ${quote.otherAmountThreshold})`);

const approve = createApproveCheckedInstruction(ata(owner.owner, src.mint), new PublicKey(src.mint), keeper.owner, owner.owner, amountRaw, src.decimals, [], programId(src.mint));
const sw = await switchInstructions(keeper.owner, owner.owner, from, to, amountRaw, quote, feeAcc);
const ixs: TransactionInstruction[] = [approve, ...sw.ixs];
const { blockhash } = await conn.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: keeper.owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(sw.alts));
console.log(`tx size: ${tx.serialize().length} bytes (limit 1232), ${ixs.length} instructions`);

const feeBefore = feeAcc ? await conn.getTokenAccountBalance(feeAcc).then((b) => BigInt(b.value.amount)) : 0n;
const dstBefore = await conn.getTokenAccountBalance(sw.ownerDst).then((b) => BigInt(b.value.amount)).catch(() => 0n);
// Read right before simulating: stand-ins are live wallets whose balances keep changing.
const srcBefore = await conn.getTokenAccountBalance(ata(owner.owner, src.mint)).then((b) => BigInt(b.value.amount));
const sim = await conn.simulateTransaction(tx, {
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { encoding: "base64", addresses: [sw.ownerDst.toBase58(), ata(owner.owner, src.mint).toBase58(), ...(feeAcc ? [feeAcc.toBase58()] : [])] },
});
if (sim.value.err) {
  console.log("SIMULATION FAILED", JSON.stringify(sim.value.err));
  console.log((sim.value.logs ?? []).slice(-15).join("\n"));
  process.exit(1);
}
// The token amount sits at byte 64 in both SPL Token and Token-2022 accounts.
const dstAfter = sim.value.accounts?.[0] ? Buffer.from(sim.value.accounts[0].data[0], "base64").readBigUInt64LE(64) : 0n;
const srcAfter = sim.value.accounts?.[1] ? Buffer.from(sim.value.accounts[1].data[0], "base64").readBigUInt64LE(64) : 0n;
const got = dstAfter - dstBefore;
if (feeAcc) {
  const feeAfter = sim.value.accounts?.[2] ? Buffer.from(sim.value.accounts[2].data[0], "base64").readBigUInt64LE(64) : feeBefore;
  const usdcSide = side === "buy" ? amountRaw : got;
  console.log(`platform fee: ${feeBps} bps -> fee account received ${feeAfter - feeBefore} raw USDC (expected about ${(usdcSide * BigInt(feeBps)) / 10_000n})`);
}
console.log(`SIMULATION OK - ${sim.value.unitsConsumed} CU`);
console.log(`owner ${from}: ${srcBefore} -> ${srcAfter} raw (moved ${srcBefore - srcAfter}, order ${amountRaw})`);
console.log(`owner ${to}: ${dstBefore} -> ${dstAfter} raw (received ${got}, quoted ${quote.outAmount}, min ${quote.otherAmountThreshold})`);
const outUi = uiFromRaw(got, dst.decimals, dstMult);
const inUi = uiFromRaw(amountRaw, src.decimals, srcMult);
console.log(`effective price: $${(side === "buy" ? inUi / outUi : outUi / inUi).toFixed(4)} per ${ticker} share`);
process.exit(0);
