// Dry-runs the full live switch against mainnet state without moving funds:
//   owner approves keeper -> keeper pulls source stock -> Jupiter swap -> output to owner.
// Uses real xStock holders as stand-ins and simulateTransaction(sigVerify: false), so no keys
// or balances are needed.  Usage: npm run simulate -- SPY NVDA 500
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createApproveCheckedInstruction } from "@solana/spl-token";
import { getAsset } from "../shared/assets";
import { rawFromUi, uiFromRaw } from "../shared/math";
import { getQuote, routeLabel } from "../server/jupiter";
import { ata, conn, switchInstructions } from "../server/solana";

const [from = "SPY", to = "NVDA", usdArg = "500"] = process.argv.slice(2);
const usd = Number(usdArg);
const src = getAsset(from);
const dst = getAsset(to);

async function multiplier(mint: string) {
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const s = (info.value?.data as any).parsed.info.extensions.find((e: any) => e.extension === "scaledUiAmountConfig")?.state;
  if (!s) return 1;
  return Date.now() / 1000 >= Number(s.newMultiplierEffectiveTimestamp) ? Number(s.newMultiplier) : Number(s.multiplier);
}

// Recent traders of the mint, as stand-in wallets (indexed "largest holders" calls are rate-limited on public RPCs).
async function holders(mint: string) {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 100 });
  const seen = new Map<string, bigint>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint !== mint || !b.owner || b.uiTokenAmount.amount === "0") continue;
      seen.set(b.owner, BigInt(b.uiTokenAmount.amount));
    }
    if (seen.size >= 12) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const out: { owner: PublicKey; amount: bigint; sol: number }[] = [];
  for (const [o] of [...seen].sort((a, b) => (b[1] > a[1] ? 1 : -1))) {
    const owner = new PublicKey(o);
    if (!PublicKey.isOnCurve(owner.toBytes())) continue; // skip program-owned pools
    const bal = await conn.getTokenAccountBalance(ata(owner, mint)).catch(() => null);
    if (!bal) continue; // want a wallet whose canonical account holds the stock
    out.push({ owner, amount: BigInt(bal.value.amount), sol: (await conn.getBalance(owner)) / 1e9 });
  }
  return out;
}

const mult = await multiplier(src.mint);
const hs = await holders(src.mint);
const pxRes = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${src.mint}`)).json();
const price = (pxRes as any)[src.mint].usdPrice as number;
const amountRaw = rawFromUi(usd / price, src.decimals, mult);
console.log("candidates:", hs.map((h) => `${h.owner.toBase58().slice(0, 6)} ${uiFromRaw(h.amount, src.decimals, mult).toFixed(3)} ${from}x ${h.sol.toFixed(3)} SOL`).join(" | "), "need", uiFromRaw(amountRaw, src.decimals, mult).toFixed(3));
async function wallet(pk: string) {
  const owner = new PublicKey(pk);
  const bal = await conn.getTokenAccountBalance(ata(owner, src.mint)).catch(() => null);
  return { owner, amount: BigInt(bal?.value.amount ?? "0"), sol: (await conn.getBalance(owner)) / 1e9 };
}
const owner = process.env.OWNER ? await wallet(process.env.OWNER) : hs.find((h) => h.amount >= amountRaw && h.sol > 0.01);
const keeper = process.env.KEEPER ? await wallet(process.env.KEEPER) : hs.find((h) => h !== owner && h.sol > 0.05);
if (!owner || !keeper) throw new Error("Could not find stand-in wallets");
console.log(`owner  (stand-in) ${owner.owner.toBase58()}  holds ${uiFromRaw(owner.amount, src.decimals, mult).toFixed(4)} ${from}x`);
console.log(`keeper (stand-in) ${keeper.owner.toBase58()}  ${keeper.sol.toFixed(3)} SOL`);

const quote = await getQuote(src.mint, dst.mint, amountRaw, 50);
console.log(`quote: ${uiFromRaw(amountRaw, src.decimals, mult).toFixed(6)} ${from}x -> ${quote.outAmount} raw ${to}x via ${routeLabel(quote)} (min ${quote.otherAmountThreshold})`);

const approve = createApproveCheckedInstruction(ata(owner.owner, src.mint), new PublicKey(src.mint), keeper.owner, owner.owner, amountRaw, src.decimals, [], TOKEN_2022_PROGRAM_ID);
const sw = await switchInstructions(keeper.owner, owner.owner, from, to, amountRaw, quote);
const ixs: TransactionInstruction[] = [approve, ...sw.ixs];
const { blockhash } = await conn.getLatestBlockhash();
const msg = new TransactionMessage({ payerKey: keeper.owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(sw.alts);
const tx = new VersionedTransaction(msg);
console.log(`tx size: ${tx.serialize().length} bytes (limit 1232), ${ixs.length} instructions`);

const dstBefore = await conn.getTokenAccountBalance(sw.ownerDst).then((b) => BigInt(b.value.amount)).catch(() => 0n);
const sim = await conn.simulateTransaction(tx, {
  sigVerify: false,
  replaceRecentBlockhash: true,
  accounts: { encoding: "base64", addresses: [sw.ownerDst.toBase58(), ata(owner.owner, src.mint).toBase58()] },
});
if (sim.value.err) {
  console.log("SIMULATION FAILED", JSON.stringify(sim.value.err));
  console.log((sim.value.logs ?? []).slice(-15).join("\n"));
  process.exit(1);
}
const dstAfter = sim.value.accounts?.[0] ? Buffer.from(sim.value.accounts[0].data[0], "base64").readBigUInt64LE(64) : 0n;
const srcAfter = sim.value.accounts?.[1] ? Buffer.from(sim.value.accounts[1].data[0], "base64").readBigUInt64LE(64) : 0n;
console.log(`SIMULATION OK - ${sim.value.unitsConsumed} CU`);
console.log(`owner ${from}x: ${owner.amount} -> ${srcAfter} raw (moved ${owner.amount - srcAfter})`);
console.log(`owner ${to}x: ${dstBefore} -> ${dstAfter} raw (received ${dstAfter - dstBefore}, quoted ${quote.outAmount}, min ${quote.otherAmountThreshold})`);
