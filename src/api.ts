import type { Check, ExecStyle, FairDraft, FairPicture, Intent, IntentDraft, MarketSnapshot, ParseResult, QuoteSummary, Status } from "../shared/types";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (data && typeof data === "object" && "error" in data)) throw new Error((data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Preview {
  draft: IntentDraft;
  fromRef: number;
  toRef: number;
  ratio: number;
  trigger: number;
  amountRaw: string;
  amountUi: number;
  usdValue: number;
  outNow: number;
  outAtTrigger: number;
  checks: Check[];
  quote?: QuoteSummary;
  balanceUi?: number;
  style: ExecStyle;
  /** Set (to the known fee %) when fees and spread would eat most of the trigger move. */
  thinTrigger?: number;
}

export interface FairPreview {
  draft: FairDraft;
  from: string;
  to: string;
  amountRaw: string;
  amountUi: number;
  usdValue: number;
  marketPrice: number;
  style: ExecStyle;
  checks: Check[];
  quote?: QuoteSummary;
  picture?: FairPicture;
  balanceUi?: number;
}

export interface Trust {
  keeper: { pubkey: string; sol?: number } | null;
  approvals: { token: string; symbol: string; approvedUi: number; balanceUi: number; neededUi: number; openOrders: number; otherDelegate?: string }[];
}

export const api = {
  status: () => call<Status>("/status"),
  market: () => call<MarketSnapshot>("/market"),
  pair: (from: string, to: string) => call<{ series: { t: number; r: number; rt: number }[] }>(`/pair?from=${from}&to=${to}`),
  parse: (text: string) => call<ParseResult>("/parse", { text }),
  preview: (draft: Partial<IntentDraft>, owner?: string) => call<Preview>("/preview", { draft, owner }),
  intents: (owner: string) => call<Intent[]>(`/intents?owner=${encodeURIComponent(owner)}`),
  fairPreview: (draft: FairDraft, owner?: string) => call<FairPreview>("/fair/preview", { draft, owner }),
  create: (body: { draft: IntentDraft | FairDraft; owner: string; ts?: number; signature?: string }) =>
    call<{ intent: Intent; approvalTx?: string }>("/intents", body),
  confirm: (id: string, signedTx?: string) => call<{ intent: Intent }>(`/intents/${id}/confirm`, { signedTx }),
  cancel: (id: string, body: { owner: string; ts?: number; signature?: string }) =>
    call<{ intent: Intent; revokeTx?: string }>(`/intents/${id}/cancel`, body),
  swapTx: (id: string, owner: string) => call<{ tx: string; quote: QuoteSummary }>(`/intents/${id}/swap-tx`, { owner }),
  executed: (id: string, signedTx: string) => call<{ intent: Intent }>(`/intents/${id}/executed`, { signedTx }),
  revoke: (id: string, signedTx: string) => call<{ signature: string }>(`/intents/${id}/revoke`, { signedTx }),
  trust: (owner: string) => call<Trust>(`/trust?owner=${encodeURIComponent(owner)}`),
  revokeAllTx: (owner: string, token: string) => call<{ tx: string }>("/trust/revoke-tx", { owner, token }),
  revokeAll: (owner: string, token: string, signedTx: string) => call<{ signature: string; cancelled: number }>("/trust/revoke", { owner, token, signedTx }),
  telegram: (owner: string) => call<{ enabled: boolean; bot?: string; linked: boolean }>(`/telegram?owner=${encodeURIComponent(owner)}`),
  telegramLink: (body: { owner: string; guest?: string; ts?: number; signature?: string }) => call<{ url: string }>("/telegram/link", body),
};
