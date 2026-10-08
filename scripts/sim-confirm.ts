// Dry-runs a one-tap confirm switch: the owner signs a Jupiter swap straight from their wallet, so
// fee-charging tokens (PreStocks) move only once. Uses a real recent holder as a stand-in and
// simulateTransaction(sigVerify: false).  Usage: npx tsx scripts/sim-confirm.ts OPENAI ANTHROPIC 0.01
// OWNER=<pubkey> uses that wallet as the stand-in instead of scanning recent holders.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAsset } from "../shared/assets";
import { getQuote, getSwapTransaction, routeLabel } from "../server/jupiter";
import { ata, conn } from "../server/solana";

const [from = "OPENAI", to = "ANTHROPIC", uiArg = "0.01"] = process.argv.slice(2);
const src = getAsset(from);
const dst = getAsset(to);
const amountRaw = BigInt(Math.floor(Number(uiArg) * 10 ** src.decimals));

// A recent holder with enough of the source token and some SOL for fees.
const sigs = await conn.getSignaturesForAddress(new PublicKey(src.mint), { limit: 40 });
const seen = new Set<string>();
let owner: PublicKey | undefined = process.env.OWNER ? new PublicKey(process.env.OWNER) : undefined;
for (const s of owner ? [] : sigs) {
  if (s.err || owner) continue;
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  for (const b of tx?.meta?.postTokenBalances ?? []) {
    if (b.mint !== src.mint || !b.owner || seen.has(b.owner)) continue;
    seen.add(b.owner);
    const pk = new PublicKey(b.owner);
    if (!PublicKey.isOnCurve(pk.toBytes())) continue;
    const bal = await conn.getTokenAccountBalance(ata(pk, src.mint)).catch(() => null);
    if (bal && BigInt(bal.value.amount) >= amountRaw && (await conn.getBalance(pk)) > 5_000_000) {
      owner = pk;
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 120));
}
if (!owner) throw new Error(`No stand-in holder with ${uiArg} ${from} found among ${seen.size} recent wallets`);
console.log("owner (stand-in)", owner.toBase58());

const quote = await getQuote(src.mint, dst.mint, amountRaw, Number(process.env.SLIP ?? 100));
console.log(`quote ${amountRaw} ${from} -> ${quote.outAmount} ${to} (min ${quote.otherAmountThreshold}) via ${routeLabel(quote)}`);
const tx = VersionedTransaction.deserialize(Buffer.from(await getSwapTransaction(quote, owner.toBase58()), "base64"));
const srcAcc = ata(owner, src.mint);
const dstAcc = ata(owner, dst.mint);
const srcBefore = BigInt((await conn.getTokenAccountBalance(srcAcc)).value.amount);
const dstBefore = await conn.getTokenAccountBalance(dstAcc).then((b) => BigInt(b.value.amount)).catch(() => 0n);
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [srcAcc.toBase58(), dstAcc.toBase58()] } });
if (sim.value.err) {
  console.log("SIMULATION FAILED", JSON.stringify(sim.value.err));
  console.log((sim.value.logs ?? []).slice(-12).join("\n"));
  process.exit(1);
}
const rd = (i: number) => Buffer.from(sim.value.accounts![i]!.data[0], "base64").readBigUInt64LE(64);
console.log(`SIMULATION OK - ${sim.value.unitsConsumed} CU, ${tx.serialize().length} bytes`);
console.log(`owner ${from}: ${srcBefore} -> ${rd(0)} (spent ${srcBefore - rd(0)} of ${amountRaw})`);
console.log(`owner ${to}: ${dstBefore} -> ${rd(1)} (received ${rd(1) - dstBefore}, quoted ${quote.outAmount}, min ${quote.otherAmountThreshold})`);
