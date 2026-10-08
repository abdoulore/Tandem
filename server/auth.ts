import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

// Live intents and cancellations must be signed by the wallet that owns the funds, so nobody
// can arm a switch against someone else's delegated tokens.
const MAX_SKEW_MS = 5 * 60_000;

export { cancelMessage, fairMessage, intentMessage, telegramMessage } from "../shared/messages";

export function verify(owner: string, message: string, signatureB58: string, ts: number): string | undefined {
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return "Signature expired - sign again";
  try {
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signatureB58), new PublicKey(owner).toBytes());
    return ok ? undefined : "Invalid wallet signature";
  } catch {
    return "Malformed signature";
  }
}
