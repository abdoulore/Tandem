import { ASSETS } from "./assets";

// Things that happen to a token on a date and change what holding or trading it means:
// a listed company's conversion deadline, a scaled-UI multiplier change (dividend or split), an issuer pause.

export interface LifecycleEvent {
  /** Stable id: one alert per event per chat. */
  key: string;
  ticker: string;
  kind: "conversion" | "multiplier" | "paused";
  /** When it happens, unix seconds (none for an ongoing pause). */
  at?: number;
  /** Short badge text. */
  title: string;
  detail: string;
  source?: string;
}

const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Events that come from the asset list itself (no chain reads). */
export function staticEvents(): LifecycleEvent[] {
  return ASSETS.filter((a) => a.lifecycle?.stage === "listed_converting" && a.lifecycle.convertBy).map((a) => {
    const at = Math.floor(Date.parse(a.lifecycle!.convertBy!) / 1000);
    return {
      key: `conversion:${a.ticker}:${at}`,
      ticker: a.ticker,
      kind: "conversion" as const,
      at,
      title: `Convert by ${day(at)}`,
      detail: `${a.name} listed as ${a.lifecycle!.listedAs}. Its PreStocks tokens convert into the listed stock and expire if not converted by ${day(at)}, 23:59 UTC.`,
      source: a.lifecycle!.source,
    };
  });
}

/** Events for one ticker that happen within `days` from now (pauses always count). */
export function upcoming(events: LifecycleEvent[], ticker: string, days: number, nowSec = Date.now() / 1000): LifecycleEvent[] {
  return events.filter((e) => e.ticker === ticker && (e.at === undefined || (e.at >= nowSec && e.at - nowSec <= days * 86_400)));
}

export const multiplierEvent = (ticker: string, from: number, to: number, at: number): LifecycleEvent => ({
  key: `multiplier:${ticker}:${at}`,
  ticker,
  kind: "multiplier",
  at,
  title: `Multiplier change ${day(at)}`,
  detail: `The token's on-chain multiplier changes from ${from} to ${to} on ${new Date(at * 1000).toUTCString().slice(5, 22)} UTC (a dividend or split). Orders close to it pause until it has passed.`,
});

export const pausedEvent = (ticker: string): LifecycleEvent => ({
  key: `paused:${ticker}`,
  ticker,
  kind: "paused",
  title: "Paused by issuer",
  detail: "The issuer has paused transfers of this token. Orders wait until it is unpaused.",
});
