import { AddressLookupTableAccount, PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { config } from "./config";

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { percent: number; swapInfo: { label: string } }[];
  [k: string]: unknown;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (config.jupiterApiKey) h["x-api-key"] = config.jupiterApiKey;
  return h;
}

// ---- rate limiting -----------------------------------------------------------
// After a 429, pause all Jupiter calls briefly (5s, 10s, 20s, capped at 30s) instead of hammering it.
let pausedUntil = 0;
let backoffMs = 0;

function onRateLimited() {
  backoffMs = Math.min(30_000, backoffMs ? backoffMs * 2 : 5_000);
  pausedUntil = Date.now() + backoffMs;
}

function assertNotPaused() {
  if (Date.now() < pausedUntil) throw new Error(`Jupiter rate-limited, retrying in ${Math.ceil((pausedUntil - Date.now()) / 1000)}s`);
}

/** Parse a Jupiter response, turning rate limits and non-JSON errors into readable messages. */
async function readJson<T>(res: Response, label: string): Promise<T> {
  if (res.status === 429) {
    onRateLimited();
    throw new Error(`Jupiter rate-limited, retrying in ${Math.ceil(backoffMs / 1000)}s`);
  }
  const text = await res.text();
  let body: (T & { error?: string }) | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 80)}`);
  }
  if (!res.ok || body?.error) throw new Error(`${label}: ${body?.error ?? `HTTP ${res.status}`}`);
  backoffMs = 0;
  return body as T;
}

// ---- quotes ----------------------------------------------------------------------
// Identical quotes are shared for a few seconds across the engine and every open browser tab.
const QUOTE_TTL_MS = 5_000;
const quoteCache = new Map<string, { at: number; quote: Promise<JupQuote> }>();

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: bigint | string,
  slippageBps: number,
  fresh = false,
  platformFeeBps = 0,
): Promise<JupQuote> {
  const key = `${inputMint}|${outputMint}|${amountRaw}|${slippageBps}|${platformFeeBps}`;
  const hit = quoteCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote;
  assertNotPaused();
  const url =
    `${config.jupiterUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&swapMode=ExactIn&maxAccounts=40` + (platformFeeBps > 0 ? `&platformFeeBps=${platformFeeBps}` : "");
  const quote = fetch(url, { headers: headers(), signal: AbortSignal.timeout(8_000) }).then((res) => readJson<JupQuote>(res, "Jupiter quote"));
  quoteCache.set(key, { at: Date.now(), quote });
  quote.catch(() => quoteCache.delete(key)); // never cache failures
  if (quoteCache.size > 500) for (const [k, v] of quoteCache) if (Date.now() - v.at > QUOTE_TTL_MS) quoteCache.delete(k);
  return quote;
}

export function routeLabel(q: JupQuote): string {
  return q.routePlan.map((r) => r.swapInfo.label).join(" > ");
}

interface RawIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

const toIx = (ix: RawIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

/**
 * Swap instructions for `user` (the keeper) that deliver the output straight into
 * `destinationTokenAccount` (the owner's target-stock account).
 */
export async function getSwapInstructions(conn: Connection, quote: JupQuote, user: PublicKey, destinationTokenAccount: PublicKey, feeAccount?: PublicKey) {
  const res = await fetch(`${config.jupiterUrl}/swap-instructions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      destinationTokenAccount: destinationTokenAccount.toBase58(),
      ...(feeAccount ? { feeAccount: feeAccount.toBase58() } : {}),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "high" } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readJson<{
    computeBudgetInstructions: RawIx[];
    setupInstructions: RawIx[];
    swapInstruction: RawIx;
    cleanupInstruction?: RawIx;
    otherInstructions?: RawIx[];
    addressLookupTableAddresses: string[];
  }>(res, "Jupiter swap-instructions");

  const alts: AddressLookupTableAccount[] = [];
  if (body.addressLookupTableAddresses.length) {
    const infos = await conn.getMultipleAccountsInfo(body.addressLookupTableAddresses.map((a) => new PublicKey(a)));
    infos.forEach((info, i) => {
      if (info) alts.push(new AddressLookupTableAccount({ key: new PublicKey(body.addressLookupTableAddresses[i]), state: AddressLookupTableAccount.deserialize(info.data) }));
    });
  }
  return {
    computeBudget: body.computeBudgetInstructions.map(toIx),
    setup: body.setupInstructions.map(toIx),
    swap: toIx(body.swapInstruction),
    cleanup: body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : [],
    other: (body.otherInstructions ?? []).map(toIx),
    alts,
  };
}

/** A complete swap transaction for `user` to sign themselves (one-tap confirm switches). */
export async function getSwapTransaction(quote: JupQuote, user: string, feeAccount?: string): Promise<string> {
  const res = await fetch(`${config.jupiterUrl}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user,
      ...(feeAccount ? { feeAccount } : {}),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "high" } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readJson<{ swapTransaction?: string }>(res, "Jupiter swap");
  if (!body.swapTransaction) throw new Error("Jupiter swap: no transaction returned");
  return body.swapTransaction;
}
