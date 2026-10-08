// Assets Tandem can switch between. Every asset has three price feeds:
//   ref   - the real-world reference price the trigger is measured on
//   token - the price of the token on Solana
//   rate  - how many underlying shares one prescaled token represents
//
// xStock (public equities, Backed): ref = Pyth Equity.US.<T>/USD (US market hours),
//   token = Pyth Crypto.<T>X/USD (24/7), rate = Pyth Crypto.<T>X/<T>.RR.
// PreStock (pre-IPO companies, PreStocks): ref = PreStocks mark price, token = PreStocks token
//   price. Pre-IPO tokens have no Pyth feeds; their ids below are local keys, not Pyth ids.
// All mints are Token-2022. PreStocks also charge a 1% transfer fee.

export type AssetKind = "xstock" | "prestock";

/** Where a PreStocks company is in its life: still private, or listed with tokens converting to the public stock. */
export interface Lifecycle {
  stage: "private" | "listed_converting";
  listedAs?: string;
  /** ISO time after which unconverted tokens expire. */
  convertBy?: string;
  source?: string;
}

export interface Asset {
  ticker: string;
  name: string;
  kind: AssetKind;
  mint: string;
  decimals: number;
  feeds: { ref: string; token: string; rate: string };
  aliases: string[];
  image?: string;
  lifecycle?: Lifecycle;
}

const RAW: Omit<Asset, "aliases" | "kind">[] = [
  { ticker: "SPY", name: "S&P 500 ETF", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", decimals: 8, feeds: { ref: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5", token: "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14", rate: "9e916cc00d292da2367646ffd6537d6b8d0c3f15e2d5891ac44aed31291811a9" } },
  { ticker: "QQQ", name: "Nasdaq-100 ETF", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", decimals: 8, feeds: { ref: "9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d", token: "178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d", rate: "5fe0ad9fd9bd888bbdfb609dbe8a6233248fa3dee25755f986f473c43938c7ca" } },
  { ticker: "NVDA", name: "NVIDIA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", decimals: 8, feeds: { ref: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", token: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f", rate: "b675c4e9f46d94afa9174a7df09966b77a2950970bb50a77ec8ad4fcfd8266f4" } },
  { ticker: "AAPL", name: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", decimals: 8, feeds: { ref: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", token: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675", rate: "25babb83691a056fd65f879bfd7197eabd840aae741f69c87ccb31e204a979b2" } },
  { ticker: "MSFT", name: "Microsoft", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", decimals: 8, feeds: { ref: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1", token: "bb723a70af731ab56b9a650eb7e8ac22b7bc07ea77f8670bd1fa9a37bf6df3f5", rate: "fbc60d2549711c0fc72da0c9f6971170d4592c2fbd1e9780dc52464316225acc" } },
  { ticker: "TSLA", name: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", decimals: 8, feeds: { ref: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", token: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362", rate: "997362625415627e9e3177f6c0d32f200d4a221ccadb3dddab80d6079d03ea24" } },
  { ticker: "GOOGL", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", decimals: 8, feeds: { ref: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6", token: "b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e", rate: "d54f066daee8cfbee2ecbefc8faa351c7c38b2c2a7cd8b704af20875974e3c68" } },
  { ticker: "AMZN", name: "Amazon", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", decimals: 8, feeds: { ref: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a", token: "7148fbe6e493ff2580305c92a8d7f8628c9943b11b9b253aebc24863fec290e8", rate: "0ed9040c3fcdadf6ab2f1815f6b252e4c1ca5fd55108390f4acd52a7efac13dd" } },
  { ticker: "META", name: "Meta", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", decimals: 8, feeds: { ref: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe", token: "bf3e5871be3f80ab7a4d1f1fd039145179fb58569e159aee1ccd472868ea5900", rate: "dfeda47e0d3ed1db00062c9ae8b82f5d0d9699f772e7fee1bfd4e9b1dd168574" } },
  { ticker: "COIN", name: "Coinbase", mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu", decimals: 8, feeds: { ref: "fee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245", token: "641435d5dffb5311140b480517c79986d8488d5cf08a11eec53b83ad02cab33f", rate: "b663e208031820ed2ea373346501ceb897f230623439482f0e2a13150af08549" } },
  { ticker: "MSTR", name: "Strategy (MicroStrategy)", mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", decimals: 8, feeds: { ref: "e1e80251e5f5184f2195008382538e847fafc36f751896889dd3d1b1f6111f09", token: "53f95ba4e23ed15ea56083e2ee9a5eec48055d6f59033d4bb95f1ca2a2349c28", rate: "342df7ea9b8db28630933d55d0c9c1119525eb5be58d499ecc4e88faf061083a" } },
  { ticker: "CRCL", name: "Circle", mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1", decimals: 8, feeds: { ref: "92b8527aabe59ea2b12230f7b532769b133ffb118dfbd48ff676f14b273f1365", token: "c13184461c0c80d98ffcd89be627c2220b94a96c7c67f0c4b16bc12fd3b17758", rate: "381f301f3aabddfa8605be298e704bf7c40738a5f7aeb07dd0b023f993ce7638" } },
  { ticker: "HOOD", name: "Robinhood", mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", decimals: 8, feeds: { ref: "306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849", token: "dd49a9ac6df5cbfa9d8fc6371f7ae927a74d5c6763c1c01b4220d70314c647f9", rate: "d88c382daa11f3a377796bc3f9318e7fbffd69c5bbceb5e58548670a7ad23e7f" } },
];

const PRE: { ticker: string; name: string; mint: string; image: string; lifecycle?: Lifecycle }[] = [
  { ticker: "OPENAI", name: "OpenAI", mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF", image: "https://prestocks.com/logos/openai.png" },
  { ticker: "ANTHROPIC", name: "Anthropic", mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw", image: "https://prestocks.com/logos/anthropic.png" },
  { ticker: "SPACEX", name: "SpaceX", mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh", image: "https://prestocks.com/logos/spacex.png",
    // Listed on Nasdaq in June 2026. Tokens convert to the public stock and expire if not converted in time.
    lifecycle: { stage: "listed_converting", listedAs: "SPCX", convertBy: "2027-03-12T23:59:00Z", source: "https://defillama.com/rwa/asset/SPACEX" } },
  { ticker: "ANDURIL", name: "Anduril", mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB", image: "https://prestocks.com/logos/anduril.png" },
  { ticker: "NEURALINK", name: "Neuralink", mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S", image: "https://prestocks.com/logos/neuralink.png" },
  { ticker: "FIGUREAI", name: "Figure AI", mint: "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd", image: "https://prestocks.com/logos/figureai.png" },
  { ticker: "KALSHI", name: "Kalshi", mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua", image: "https://prestocks.com/logos/kalshi.png" },
  { ticker: "POLYMARKET", name: "Polymarket", mint: "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP", image: "https://prestocks.com/logos/polymarket.png" },
];

// Words people use for each asset in plain-English intents.
const ALIASES: Record<string, string[]> = {
  SPY: ["s&p 500", "s&p500", "s & p 500", "s&p", "sp500", "sp 500", "the s&p", "the market", "spx"],
  QQQ: ["nasdaq-100", "nasdaq 100", "nasdaq100", "nasdaq", "the nasdaq"],
  NVDA: ["nvidia"],
  AAPL: ["apple"],
  MSFT: ["microsoft"],
  TSLA: ["tesla"],
  GOOGL: ["alphabet", "google", "goog"],
  AMZN: ["amazon"],
  META: ["facebook", "meta platforms"],
  COIN: ["coinbase"],
  MSTR: ["microstrategy"],
  CRCL: ["circle"],
  HOOD: ["robinhood"],
  OPENAI: ["open ai", "open-ai"],
  SPACEX: ["space x", "space-x", "starlink"],
  FIGUREAI: ["figure ai", "figure"],
  POLYMARKET: ["poly market"],
};

export const ASSETS: Asset[] = [
  ...RAW.map((a) => ({
    ...a,
    kind: "xstock" as const,
    aliases: [a.ticker.toLowerCase(), `${a.ticker.toLowerCase()}x`, a.name.toLowerCase(), ...(ALIASES[a.ticker] ?? [])],
  })),
  ...PRE.map((p) => ({
    ...p,
    kind: "prestock" as const,
    decimals: 9,
    feeds: { ref: `prestocks:${p.ticker}:mark`, token: `prestocks:${p.ticker}:token`, rate: `prestocks:${p.ticker}:rate` },
    aliases: [p.ticker.toLowerCase(), p.name.toLowerCase(), ...(ALIASES[p.ticker] ?? [])],
  })),
];

/** Pyth feed ids (xStocks only). */
export const PYTH_FEED_IDS = ASSETS.filter((a) => a.kind === "xstock").flatMap((a) => [a.feeds.ref, a.feeds.token, a.feeds.rate]);

export const ASSET_BY_TICKER: Record<string, Asset> = Object.fromEntries(ASSETS.map((a) => [a.ticker, a]));

/** "Listed on Nasdaq as SPCX. Convert by Mar 12, 2027." for assets past their pre-IPO stage, else undefined. */
export function lifecycleNote(a: Asset | undefined): string | undefined {
  const l = a?.lifecycle;
  if (l?.stage !== "listed_converting") return undefined;
  const by = l.convertBy && new Date(l.convertBy).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `Listed on Nasdaq as ${l.listedAs}.${by ? ` Convert by ${by}.` : ""}`;
}

export const isConverting = (ticker: string) => ASSET_BY_TICKER[ticker]?.lifecycle?.stage === "listed_converting";

export function tokenSymbol(ticker: string): string {
  const a = ASSET_BY_TICKER[ticker];
  return a?.kind === "xstock" ? `${ticker}x` : ticker;
}

export function getAsset(ticker: string): Asset {
  const a = ASSET_BY_TICKER[ticker.toUpperCase()];
  if (!a) throw new Error(`Unknown asset ${ticker}`);
  return a;
}
