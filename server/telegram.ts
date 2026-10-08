import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ASSET_BY_TICKER, tokenSymbol } from "../shared/assets";
import { describeSizing, fmtNum } from "../shared/math";
import { upcoming, type LifecycleEvent } from "../shared/lifecycle";
import type { Intent } from "../shared/types";
import { config } from "./config";
import { store } from "./store";

// Telegram alerts. One bot serves the whole app; each user links their own chat once and hears only
// about their own switches: ready to confirm, switched, failed. Nothing here can move funds.

const API = "https://api.telegram.org";
const FILE = path.join(config.dataDir, "telegram.json");
const LINK_TTL_MS = 10 * 60_000;
/** A switch that flips between Ready and monitoring re-alerts at most this often. */
const READY_REPEAT_MS = 15 * 60_000;
/** Lifecycle alerts: open orders are checked every few minutes, wallet holdings once a day. */
const LIFECYCLE_EVERY_MS = 10 * 60_000;
const HOLDINGS_EVERY_MS = 24 * 3600_000;
const LIFECYCLE_DAYS = 7;

export interface LifecycleDeps {
  lifecycle: () => LifecycleEvent[];
  /** Whether a wallet holds any of a token (wallet owners only, never guests). */
  holds: (owner: string, ticker: string) => Promise<boolean>;
}

type Button = { text: string; url: string };
interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const name = (t: string) => ASSET_BY_TICKER[t]?.name ?? t;
const page = (tab?: string) => `${config.appUrl}/app/orders${tab ? `?tab=${tab}` : ""}`;

/** On a phone, a wallet's own browser is where the confirm tap can sign. */
const confirmButtons = (url: string): Button[][] => [
  [{ text: "Confirm in Tandem", url }],
  [
    { text: "Open in Phantom", url: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(config.appUrl)}` },
    { text: "Open in Solflare", url: `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(config.appUrl)}` },
  ],
];

class Telegram {
  /** Bot username, set once the token checks out. */
  bot?: string;
  private links = new Map<string, number>(); // owner -> chat id
  /** Lifecycle alerts already sent, as "chat|event key", so each goes out once. */
  private sent = new Set<string>();
  private deps?: LifecycleDeps;
  private lastHoldings = 0;
  private pending = new Map<string, { owners: string[]; exp: number }>();
  private seen = new Map<string, Intent["status"]>();
  private readyAlerted = new Map<string, number>();
  private offset = 0;
  private dirty = false;

  get enabled() {
    return Boolean(this.bot);
  }

  linked(owner: string) {
    return this.links.has(owner);
  }

  async start(deps?: LifecycleDeps) {
    if (!config.telegramToken) return;
    this.deps = deps;
    try {
      const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
      this.links = new Map(Object.entries(saved.links ?? {}));
      this.sent = new Set(saved.sent ?? []);
    } catch {
      /* first run */
    }
    try {
      this.bot = (await this.call<{ username: string }>("getMe")).username;
    } catch (e) {
      console.error("Telegram bot token rejected, alerts off:", (e as Error).message);
      return;
    }
    console.log(`  alerts: Telegram via @${this.bot}`);
    for (const i of store.all()) this.seen.set(i.id, i.status);
    setInterval(() => this.scan(), 2_000);
    setInterval(() => this.flush(), 5_000);
    if (deps) {
      setTimeout(() => this.lifecycleScan(), 60_000);
      setInterval(() => this.lifecycleScan(), LIFECYCLE_EVERY_MS);
    }
    void this.poll();
  }

  /**
   * Lifecycle alerts, once per event per chat: open orders whose asset has an event within a week, and
   * (once a day) linked wallets still holding a token that must be converted by a deadline.
   */
  async lifecycleScan() {
    if (!this.deps) return;
    const events = this.deps.lifecycle();
    const sendOnce = async (chat: number, e: LifecycleEvent, lead: string) => {
      const k = `${chat}|${e.key}`;
      if (this.sent.has(k)) return;
      this.sent.add(k);
      this.dirty = true;
      const link = e.source ? `\n\n<a href="${e.source}">Source</a>` : "";
      await this.send(chat, `<b>${esc(name(e.ticker))}: ${esc(e.title)}</b>\n${esc(lead)}\n\n${esc(e.detail)}${link}`, [[{ text: "Open Tandem", url: page() }]]).catch(() => {
        this.sent.delete(k);
      });
    };
    for (const i of store.all()) {
      if (!["armed", "ready", "awaiting_approval"].includes(i.status)) continue;
      const chat = this.links.get(i.owner);
      if (chat === undefined) continue;
      const asset = i.kind === "fair" ? i.fair!.asset : undefined;
      for (const t of asset ? [asset] : [i.from, i.to]) for (const e of upcoming(events, t, LIFECYCLE_DAYS)) await sendOnce(chat, e, "One of your open orders is affected.");
    }
    if (Date.now() - this.lastHoldings < HOLDINGS_EVERY_MS) return;
    this.lastHoldings = Date.now();
    for (const e of events.filter((x) => x.kind === "conversion")) {
      for (const [owner, chat] of this.links) {
        if (owner.startsWith("guest:") || this.sent.has(`${chat}|${e.key}`)) continue;
        if (await this.deps.holds(owner, e.ticker).catch(() => false)) await sendOnce(chat, e, "Your wallet still holds this token.");
      }
    }
    this.flush();
  }

  /** A one-time t.me link that ties the chat that opens it to these owners. */
  linkUrl(owners: string[]): string {
    if (!this.bot) throw new Error("Telegram alerts aren't set up on this server");
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.exp < now) this.pending.delete(k);
    if (this.pending.size > 5_000) throw new Error("Too many pending links, try again in a few minutes");
    const code = crypto.randomBytes(18).toString("base64url");
    this.pending.set(code, { owners, exp: now + LINK_TTL_MS });
    return `https://t.me/${this.bot}?start=${code}`;
  }

  private async call<T>(method: string, body: unknown = {}, timeoutMs = 10_000): Promise<T> {
    // The token is part of the URL, so errors below never include the URL.
    const res = await fetch(`${API}/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!data.ok) throw Object.assign(new Error(data.description ?? `HTTP ${res.status}`), { code: data.error_code ?? res.status });
    return data.result as T;
  }

  private async send(chat: number, text: string, buttons?: Button[][]) {
    const base = { chat_id: chat, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
    try {
      await this.call("sendMessage", buttons ? { ...base, reply_markup: { inline_keyboard: buttons } } : base);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 403) {
        // The user blocked the bot: stop messaging that chat.
        for (const [o, c] of this.links) if (c === chat) this.links.delete(o);
        this.dirty = true;
        return;
      }
      // Telegram refuses some button URLs (localhost during development); the message still matters.
      if (buttons && /button|url/i.test((e as Error).message)) return void (await this.call("sendMessage", base));
      throw e;
    }
  }

  private async poll() {
    for (;;) {
      try {
        const updates = await this.call<Update[]>("getUpdates", { offset: this.offset, timeout: 30, allowed_updates: ["message"] }, 40_000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (m?.text) await this.onMessage(m.chat.id, m.text.trim()).catch((e) => console.warn("Telegram reply failed:", (e as Error).message));
        }
      } catch (e) {
        const conflict = (e as { code?: number }).code === 409;
        if (conflict) console.warn("Telegram: another server is reading this bot's messages, retrying in 30s");
        await sleep(conflict ? 30_000 : 5_000);
      }
    }
  }

  private async onMessage(chat: number, text: string) {
    const [first, arg] = text.split(/\s+/, 2);
    const cmd = first.split("@")[0];
    if (cmd === "/start" && arg) {
      const p = this.pending.get(arg);
      this.pending.delete(arg);
      if (!p || p.exp < Date.now()) {
        await this.send(chat, "That link has expired. In Tandem, open My orders and choose Get Telegram alerts again.");
        return;
      }
      for (const o of p.owners) this.links.set(o, chat);
      this.dirty = true;
      this.flush();
      const ready = store.all().filter((i) => p.owners.includes(i.owner) && i.status === "ready").length;
      await this.send(
        chat,
        "<b>Alerts on.</b> You'll get a message here when an order is ready to confirm, and when one completes or fails.\n\nSend /stop to turn them off." +
          (ready ? `\n\n<b>${ready === 1 ? "1 order is" : `${ready} orders are`} ready to confirm now.</b>` : ""),
        ready ? confirmButtons(page()) : [[{ text: "Open Tandem", url: page() }]],
      );
      return;
    }
    if (cmd === "/stop") {
      let n = 0;
      for (const [o, c] of this.links) {
        if (c !== chat) continue;
        this.links.delete(o);
        n++;
      }
      this.dirty = true;
      this.flush();
      await this.send(chat, n ? "Alerts off. You can link again any time from My orders in Tandem." : "No orders are linked to this chat.");
      return;
    }
    await this.send(chat, "Tandem sends alerts about your orders here. To link this chat, open My orders in Tandem and choose Get Telegram alerts.", [
      [{ text: "Open Tandem", url: page() }],
    ]);
  }

  /** Compare each switch with its last seen status and alert on the changes people act on. */
  private scan() {
    for (const i of store.all()) {
      const prev = this.seen.get(i.id);
      if (prev === i.status) continue;
      this.seen.set(i.id, i.status);
      const chat = this.links.get(i.owner);
      const msg = chat === undefined ? null : this.render(i);
      if (msg) this.send(chat!, msg.text, msg.buttons).catch((e) => console.warn("Telegram alert failed:", (e as Error).message));
    }
  }

  private render(i: Intent): { text: string; buttons: Button[][] } | null {
    const pair = `${esc(name(i.from))} → ${esc(name(i.to))}`;
    if (i.kind === "fair" && i.fair) return this.renderFair(i, pair);
    if (i.status === "ready") {
      if (Date.now() - (this.readyAlerted.get(i.id) ?? 0) < READY_REPEAT_MS) return null;
      this.readyAlerted.set(i.id, Date.now());
      const c = i.lastEval?.changePct;
      const move =
        c === undefined
          ? ""
          : i.direction === "cheaper"
            ? `${name(i.to)} is ${Math.abs(c).toFixed(1)}% cheaper relative to ${name(i.from)}. `
            : `${name(i.to)} is up ${c.toFixed(1)}% relative to ${name(i.from)}. `;
      return {
        text:
          `<b>Ready to switch</b>\n${pair}\n\n${esc(move)}Every check passed. Confirm to move ${esc(describeSizing(i.sizing, name(i.from)))}.\n\n` +
          "It stays ready while the condition holds, and everything is checked again when you confirm.",
        buttons: confirmButtons(page()),
      };
    }
    if (i.status === "executed" && i.execution) {
      const x = i.execution;
      const lines = [`<b>${x.paper ? "Switched (paper)" : "Switched"}</b>`, pair, "", `${fmtNum(x.inUi)} ${tokenSymbol(i.from)} → ${fmtNum(x.outUi)} ${tokenSymbol(i.to)}`];
      if (x.paper) lines.push("Live prices, no funds moved.");
      const row: Button[] = [{ text: "Receipt", url: page("closed") }];
      if (x.signature) row.push({ text: "Transaction", url: `https://solscan.io/tx/${x.signature}` });
      return { text: lines.join("\n"), buttons: [row] };
    }
    if (i.status === "failed") {
      const why = i.execution?.error ?? i.events[i.events.length - 1]?.message ?? "";
      return { text: `<b>Switch failed</b>\n${pair}\n\n${esc(why.slice(0, 300))}`, buttons: [[{ text: "Open Tandem", url: page("closed") }]] };
    }
    return null;
  }

  /** Fair-price orders: the price against the real stock is the story, not a ratio. */
  private renderFair(i: Intent, pair: string): { text: string; buttons: Button[][] } | null {
    const f = i.fair!;
    const verb = f.side === "buy" ? "buy" : "sell";
    const pic = i.lastEval?.fair;
    const vs = (p?: { effPrice: number; ref: { price: number }; premiumBps: number }) =>
      p ? `$${p.effPrice.toFixed(2)} vs $${p.ref.price.toFixed(2)} real (${p.premiumBps >= 0 ? "+" : ""}${p.premiumBps.toFixed(0)} bps)` : "";
    if (i.status === "ready") {
      if (Date.now() - (this.readyAlerted.get(i.id) ?? 0) < READY_REPEAT_MS) return null;
      this.readyAlerted.set(i.id, Date.now());
      return {
        text: `<b>Ready to ${verb} ${esc(name(f.asset))}</b>\n${esc(vs(pic))}, within your limit.\n\nConfirm to ${verb}. The price is checked again when you confirm.`,
        buttons: confirmButtons(page()),
      };
    }
    if (i.status === "executed" && i.execution) {
      const x = i.execution;
      const lines = [`<b>${x.paper ? "Filled (paper)" : "Filled"}: ${verb} ${esc(name(f.asset))}</b>`, pair, "", esc(vs(x.fair))];
      if (x.paper) lines.push("Live prices, no funds moved.");
      const row: Button[] = [{ text: "Receipt", url: page("closed") }];
      if (x.signature) row.push({ text: "Transaction", url: `https://solscan.io/tx/${x.signature}` });
      return { text: lines.join("\n"), buttons: [row] };
    }
    if (i.status === "failed") {
      const why = i.execution?.error ?? i.events[i.events.length - 1]?.message ?? "";
      return { text: `<b>Order failed</b>\n${pair}\n\n${esc(why.slice(0, 300))}`, buttons: [[{ text: "Open Tandem", url: page("closed") }]] };
    }
    return null;
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ links: Object.fromEntries(this.links), sent: [...this.sent] }));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      this.dirty = true;
      console.warn("saving Telegram links failed, retrying:", (e as Error).message);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean up */
      }
    }
  }
}

export const telegram = new Telegram();
