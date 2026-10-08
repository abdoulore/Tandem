import fs from "node:fs";
import path from "node:path";
import type { Intent, IntentEvent } from "../shared/types";
import { config } from "./config";

const FILE = path.join(config.dataDir, "intents.json");
const MAX_EVENTS = 60;

class Store {
  private intents = new Map<string, Intent>();
  private dirty = false;

  constructor() {
    try {
      for (const i of JSON.parse(fs.readFileSync(FILE, "utf8")) as Intent[]) this.intents.set(i.id, { ...i, kind: i.kind ?? "switch" });
    } catch {
      /* first run */
    }
    setInterval(() => this.flush(), 1_000);
  }

  all(): Intent[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  byOwner(owner: string): Intent[] {
    return this.all().filter((i) => i.owner === owner);
  }

  get(id: string): Intent | undefined {
    return this.intents.get(id);
  }

  put(intent: Intent) {
    this.intents.set(intent.id, intent);
    this.dirty = true;
  }

  event(intent: Intent, kind: IntentEvent["kind"], message: string) {
    const last = intent.events[intent.events.length - 1];
    if (last && last.message === message) return; // don't spam repeated blockers
    intent.events.push({ at: Date.now(), kind, message });
    if (intent.events.length > MAX_EVENTS) intent.events.splice(0, intent.events.length - MAX_EVENTS);
    this.dirty = true;
  }

  touch() {
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 1));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      this.dirty = true; // try again on the next tick
      console.warn("saving switches failed, retrying:", (e as Error).message);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean up */
      }
    }
  }
}

export const store = new Store();
