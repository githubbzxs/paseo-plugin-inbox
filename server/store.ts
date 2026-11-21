// Inbox state persistence in $PASEO_HOME/plugin-data/paseo-inbox/state.json; writes go to a temp file, then rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateSchema, type InboxEntry, type InboxStateMap } from "../shared/contract";
import { compact } from "../shared/inbox";

function dataDir(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-inbox");
}

export class InboxStore {
  private state: InboxStateMap = {};
  private listeners = new Set<(state: InboxStateMap) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;

  constructor() {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    try {
      const parsed = stateSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) this.state = parsed.data;
    } catch {
      // No file on first run.
    }
  }

  snapshot(): InboxStateMap {
    return this.state;
  }

  get(id: string): InboxEntry {
    return this.state[id] ?? {};
  }

  /** Batch update; fn returns null to leave an entry unchanged. */
  update(ids: readonly string[], fn: (entry: InboxEntry, id: string) => InboxEntry | null): boolean {
    let changed = false;
    const next = { ...this.state };
    for (const id of ids) {
      const updated = fn(next[id] ?? {}, id);
      if (!updated) continue;
      const c = compact(updated);
      if (c) next[id] = c;
      else delete next[id];
      changed = true;
    }
    if (!changed) return false;
    this.state = next;
    this.scheduleSave();
    for (const l of this.listeners) l(this.state);
    return true;
  }

  remove(id: string) {
    if (!(id in this.state)) return;
    const next = { ...this.state };
    delete next[id];
    this.state = next;
    this.scheduleSave();
    for (const l of this.listeners) l(this.state);
  }

  subscribe(listener: (state: InboxStateMap) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 300);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
