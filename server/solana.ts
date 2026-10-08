import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createRevokeInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { legAsset, programOf } from "../shared/assets";
import { config } from "./config";
import { getSwapInstructions, type JupQuote } from "./jupiter";

export const conn = new Connection(config.rpcUrl, "confirmed");

const SET_CU_LIMIT = 2; // ComputeBudget instruction tag for SetComputeUnitLimit
const KEEPER_EXTRA_CU = 80_000;

/** Classic SPL Token for USDC, Token-2022 for stock tokens. */
export const programId = (mint: string) => (programOf(mint) === "spl" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);

export const ata = (owner: PublicKey, mint: string) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, true, programId(mint));

/** Raw balance and delegation of the owner's account for a stock token or USDC. */
export async function tokenAccountState(owner: PublicKey, ticker: string) {
  const asset = legAsset(ticker);
  const address = ata(owner, asset.mint);
  const info = await conn.getParsedAccountInfo(address);
  const parsed = (info.value?.data as any)?.parsed?.info;
  if (!parsed) return { address, exists: false, amount: 0n, delegate: undefined as string | undefined, delegatedAmount: 0n };
  return {
    address,
    exists: true,
    amount: BigInt(parsed.tokenAmount.amount),
    delegate: parsed.delegate as string | undefined,
    delegatedAmount: BigInt(parsed.delegatedAmount?.amount ?? "0"),
  };
}

/**
 * The only transaction the owner signs: make sure the target-stock account exists, and let the
 * keeper move exactly `totalRaw` of the source stock. Funds never leave the wallet until the
 * trigger fires, and the owner can revoke at any time.
 */
export async function buildApprovalTx(owner: PublicKey, keeper: PublicKey, from: string, to: string, totalRaw: bigint) {
  const src = legAsset(from);
  const dst = legAsset(to);
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, dst.mint), owner, new PublicKey(dst.mint), programId(dst.mint)),
    createApproveCheckedInstruction(ata(owner, src.mint), new PublicKey(src.mint), keeper, owner, totalRaw, src.decimals, [], programId(src.mint)),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return { tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight };
}

export async function buildRevokeTx(owner: PublicKey, from: string, keeper: PublicKey, remainingRaw: bigint) {
  const src = legAsset(from);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createApproveCheckedInstruction(ata(owner, src.mint), new PublicKey(src.mint), keeper, owner, remainingRaw, src.decimals, [], programId(src.mint)),
  ];
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

/** Remove the keeper's approval on one of the owner's token accounts entirely. The owner signs and pays. */
export async function buildFullRevokeTx(owner: PublicKey, ticker: string) {
  const src = legAsset(ticker);
  const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), createRevokeInstruction(ata(owner, src.mint), owner, [], programId(src.mint))];
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

/**
 * The atomic switch, signed only by the keeper:
 *   1. pull `amountRaw` of the source (stock or USDC) from the owner (keeper is the SPL delegate)
 *   2. Jupiter swap source -> target with a hard minimum-out
 *   3. output lands directly in the owner's target-stock account
 * All-or-nothing: if the swap can't meet its minimum, the pull reverts too.
 */
export async function switchInstructions(keeper: PublicKey, owner: PublicKey, from: string, to: string, amountRaw: bigint, quote: JupQuote) {
  const src = legAsset(from);
  const dst = legAsset(to);
  const keeperSrc = ata(keeper, src.mint);
  const ownerDst = ata(owner, dst.mint);
  const jup = await getSwapInstructions(conn, quote, keeper, ownerDst);
  // Jupiter sizes the compute limit for its swap alone; the account creation and the keeper's pull
  // run in the same transaction, so give the limit room for them.
  const budget = jup.computeBudget.map((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === SET_CU_LIMIT
      ? ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, ix.data.readUInt32LE(1) + KEEPER_EXTRA_CU) })
      : ix,
  );
  const ixs: TransactionInstruction[] = [
    ...budget,
    createAssociatedTokenAccountIdempotentInstruction(keeper, keeperSrc, keeper, new PublicKey(src.mint), programId(src.mint)),
    createAssociatedTokenAccountIdempotentInstruction(keeper, ownerDst, owner, new PublicKey(dst.mint), programId(dst.mint)),
    createTransferCheckedInstruction(ata(owner, src.mint), new PublicKey(src.mint), keeperSrc, keeper, amountRaw, src.decimals, [], programId(src.mint)),
    ...jup.setup,
    jup.swap,
    ...jup.cleanup,
    ...jup.other,
  ];
  return { ixs, alts: jup.alts, ownerDst };
}

export async function buildSwitchTx(keeper: Keypair, owner: PublicKey, from: string, to: string, amountRaw: bigint, quote: JupQuote) {
  const { ixs, alts, ownerDst } = await switchInstructions(keeper.publicKey, owner, from, to, amountRaw, quote);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: keeper.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([keeper]);
  return { tx, blockhash, lastValidBlockHeight, ownerDst };
}

export async function sendAndConfirm(tx: VersionedTransaction, blockhash: string, lastValidBlockHeight: number): Promise<string> {
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "processed" });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-6).join(" | ");
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)} ${logs}`);
  }
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  // Rebroadcast until confirmed or the blockhash expires.
  let done = false;
  const resend = setInterval(() => !done && conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}), 2_000);
  try {
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  } finally {
    done = true;
    clearInterval(resend);
  }
}

/** Actual amount of the target stock the owner received, from the confirmed transaction. */
export async function receivedRaw(sig: string, ownerDst: PublicKey): Promise<bigint | undefined> {
  for (let i = 0; i < 5; i++) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx?.meta) {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      const idx = keys.staticAccountKeys.concat(keys.accountKeysFromLookups?.writable ?? [], keys.accountKeysFromLookups?.readonly ?? []).findIndex((k) => k.equals(ownerDst));
      const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0";
      const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount;
      if (post !== undefined) return BigInt(post) - BigInt(pre);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return undefined;
}

/** Broadcast a transaction the user's wallet signed in the browser, and wait for confirmation. */
export async function submitSigned(b64: string): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "processed" });
  if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  for (let i = 0; i < 45; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    if (i % 2 === 0) await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Not confirmed in time: ${sig}`);
}
