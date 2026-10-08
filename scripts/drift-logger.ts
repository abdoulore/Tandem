// Standalone drift logger for any always-on machine: prices and token state only, no API server, no engine.
// npm run drift
import { startDriftLogger, DRIFT_DIR } from "../server/drift";
import { PriceService } from "../server/prices";
import { conn } from "../server/solana";
import { TokenState } from "../server/tokenState";

const tokens = new TokenState(conn);
const prices = new PriceService(tokens);
tokens.start();
prices.start();
startDriftLogger(prices, tokens);
console.log(`drift logger running, writing to ${DRIFT_DIR}`);
