import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function loadKeeper(): Keypair | undefined {
  const s = process.env.KEEPER_SECRET_KEY?.trim();
  if (!s) return undefined;
  try {
    return s.startsWith("[") ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : Keypair.fromSecretKey(bs58.decode(s));
  } catch (e) {
    console.error("KEEPER_SECRET_KEY is set but invalid:", (e as Error).message);
    return undefined;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  pythApiKey: process.env.PYTH_API_KEY?.trim() || undefined,
  /** Finnhub key: real-time US stock prices, the live reference for public stocks when Pyth is not available. */
  finnhubKey: process.env.FINNHUB_API_KEY?.trim() || undefined,
  pythHermesUrl: (process.env.PYTH_HERMES_URL ?? "https://pyth.dourolabs.app/hermes").replace(/\/$/, ""),
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  jupiterUrl: (process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag/swap/v1").replace(/\/$/, ""),
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || undefined,
  keeper: loadKeeper(),
  liveExecution: (process.env.LIVE_EXECUTION ?? "true") !== "false",
  dataDir: process.env.DATA_DIR ?? "data",
  /** Live orders above this many USD are refused. */
  maxLiveUsd: Number(process.env.MAX_LIVE_USD ?? 250),
  /** Platform fee on fair-price orders, basis points, taken in USDC. Off (0) unless FEE_OWNER is also set. */
  platformFeeBps: process.env.FEE_OWNER ? Math.max(0, Math.min(100, Number(process.env.PLATFORM_FEE_BPS ?? 0))) : 0,
  /** Wallet that receives platform fees (its USDC account must exist: npx tsx scripts/create-fee-account.ts). */
  feeOwner: process.env.FEE_OWNER?.trim() || undefined,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
  /** Public address of the app, used in alert links. */
  appUrl: (process.env.APP_URL ?? "https://tandem.moonrider.online").replace(/\/$/, ""),
  pollMs: 2_000,
};
