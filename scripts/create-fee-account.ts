// Opens FEE_OWNER's USDC account, which Jupiter needs before it can pay Tandem's platform fee into it.
// The keeper pays the rent (about 0.002 SOL). Prints what it would do unless run with --send.
// npx tsx scripts/create-fee-account.ts [--send]
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { USDC } from "../shared/assets";
import { config } from "../server/config";
import { ata, conn, programId } from "../server/solana";

if (!config.feeOwner) throw new Error("Set FEE_OWNER in .env first");
if (!config.keeper) throw new Error("KEEPER_SECRET_KEY is needed to pay the account rent");
const owner = new PublicKey(config.feeOwner);
const account = ata(owner, USDC.mint);
const exists = !!(await conn.getAccountInfo(account));
console.log(`fee owner ${owner.toBase58()}\nUSDC account ${account.toBase58()} ${exists ? "already exists" : "does not exist yet"}`);
if (exists || !process.argv.includes("--send")) {
  if (!exists) console.log("Run again with --send to create it.");
  process.exit(0);
}
const ix = createAssociatedTokenAccountIdempotentInstruction(config.keeper.publicKey, account, owner, new PublicKey(USDC.mint), programId(USDC.mint));
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: config.keeper.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
tx.sign([config.keeper]);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
console.log(`created: https://solscan.io/tx/${sig}`);
process.exit(0);
