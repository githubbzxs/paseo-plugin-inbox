// Pure inbox logic: sections, ordering, state changes. No React or Node dependency; shared by client and server and easy to test.
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { InboxEntry, InboxOp } from "./contract";

/** Grace period before leaving Running, so items don't jump back and forth between turns. */
export const GRACE_MS = 2000;
/** A workspace with nothing unread and no activity for this long counts as archived (computed, never written). */
export const AUTO_SETTLE_MS = 7 * 24 * 3600 * 1000;

export type Section = "pinned" | "inbox" | "working" | "snoozed" | "settled";
export const SECTION_ORDER: readonly Section[] = ["pinned", "inbox", "working", "snoozed", "settled"];

export function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function isUnread(e: InboxEntry | undefined): boolean {
  return !!e && (e.unreadAt ?? 0) > (e.readAt ?? 0);
}

export function isSnoozed(e: InboxEntry | undefined, now: number): boolean {
  return e?.snoozedUntil != null && e.snoozedUntil > now;
}

/** The inbox only tracks top-level, non-background workspaces. */
export function isListed(ws: PluginWorkspaceSnapshot): boolean {
  return !ws.background && ws.parentAgent == null;
}

/**
 * Time used for ordering and display: when it returned to the inbox, else the last message you sent, else creation time.
 * Not statusEnteredAt: opening an agent clears its attention and resets that to now.
 */
export function activityTime(ws: PluginWorkspaceSnapshot, e: InboxEntry | undefined): number {
  return Math.max(e?.returnedAt ?? 0, ms(ws.lastPromptAt), ms(ws.createdAt));
}

export function isWorking(ws: PluginWorkspaceSnapshot, leftRunningAt: number | undefined, now: number): boolean {
  if (ws.status === "running") return true;
  if (ws.status !== "done") return false;
  return leftRunningAt != null && now - leftRunningAt < GRACE_MS;
}

export function sectionOf(
  ws: PluginWorkspaceSnapshot,
  e: InboxEntry | undefined,
  leftRunningAt: number | undefined,
  now: number,
): Section {
  if (e?.pinned || ws.pinnedAt) return "pinned";
  if (isSnoozed(e, now)) return "snoozed";
  if (isWorking(ws, leftRunningAt, now)) return "working";
  if (e?.settledAt != null) return "settled";
  const needsYou = ws.status === "needs_input" || ws.status === "failed";
  if (!needsYou && !isUnread(e) && now - activityTime(ws, e) > AUTO_SETTLE_MS) return "settled";
  return "inbox";
}

/** Sort key within a section; larger sorts higher. */
export function sortKey(ws: PluginWorkspaceSnapshot, e: InboxEntry | undefined, section: Section): number {
  // Snoozed: by wake time, earliest first.
  if (section === "snoozed") return -(e?.snoozedUntil ?? 0);
  // Like t3code: Running is ordered by the last message you sent.
  if (section === "working") return Math.max(ms(ws.lastPromptAt), ms(ws.createdAt));
  if (section === "settled") return e?.settledAt ?? activityTime(ws, e);
  return activityTime(ws, e);
}

// ---- Server side: state changes from events and actions ----

export type AttentionKind = "finished" | "failed" | "permission";

/** Turn finished / failed / waiting for approval: mark unread and move to the top of the inbox. Failures and approvals wake a snooze early. */
export function onAttention(e: InboxEntry, kind: AttentionKind, now: number): InboxEntry {
  const next: InboxEntry = { ...e, unreadAt: now, returnedAt: now, settledAt: undefined };
  if (isSnoozed(e, now) && kind !== "finished") {
    next.snoozedUntil = undefined;
    next.snoozedAt = undefined;
    next.woke = true;
  }
  return next;
}

/** Started running again: unarchive. */
export function onTurnStart(e: InboxEntry): InboxEntry {
  return e.settledAt == null ? e : { ...e, settledAt: undefined };
}

/** Snooze expired: back to the inbox, marked unread. Returns null if not yet due. */
export function onSnoozeTick(e: InboxEntry, now: number): InboxEntry | null {
  if (e.snoozedUntil == null || e.snoozedUntil > now) return null;
  const t = e.snoozedUntil;
  return { ...e, snoozedUntil: undefined, snoozedAt: undefined, woke: true, unreadAt: t, returnedAt: t };
}

export function applyOp(e: InboxEntry, op: InboxOp, now: number, until?: number): InboxEntry {
  switch (op) {
    case "read":
      return { ...e, readAt: now, woke: false };
    case "unread":
      return { ...e, unreadAt: now, readAt: Math.min(e.readAt ?? 0, now - 1) };
    case "snooze":
      return { ...e, snoozedUntil: until ?? now + 3600_000, snoozedAt: now, woke: false, settledAt: undefined };
    case "unsnooze":
      return { ...e, snoozedUntil: undefined, snoozedAt: undefined, returnedAt: now };
    case "settle":
      return { ...e, settledAt: now, readAt: now, woke: false, snoozedUntil: undefined, snoozedAt: undefined };
    case "unsettle":
      return { ...e, settledAt: undefined, snoozedUntil: undefined, snoozedAt: undefined, returnedAt: now };
    case "ack":
      return { ...e, woke: false };
    case "pin":
      return { ...e, pinned: true };
    case "unpin":
      return { ...e, pinned: false };
  }
}

/** Drop undefined fields; an empty object becomes null (removable from state). */
export function compact(e: InboxEntry): InboxEntry | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && v !== false) out[k] = v;
  return Object.keys(out).length ? (out as InboxEntry) : null;
}

// ---- Snooze presets (t3code's defaults without "This evening": in 1 hour, in 3 hours, tomorrow 9:00, next Monday 9:00; plus custom hours / days) ----

export interface SnoozePreset {
  id: string;
  label: string;
  /** Wake-up time, such as "18:00" or "Mon 09:00". */
  when: string;
  until: number;
}

type PresetSetting = { kind: "after"; minutes: number } | { kind: "at"; day: "today" | "tomorrow" | "monday"; time: string };

const PRESET_SETTINGS: readonly PresetSetting[] = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function resolvePreset(setting: PresetSetting, now: number): SnoozePreset | null {
  const nowDate = new Date(now);
  if (setting.kind === "after") {
    const wake = new Date(now + setting.minutes * 60_000);
    const h = setting.minutes / 60;
    const label = Number.isInteger(h) ? `In ${h} hour${h === 1 ? "" : "s"}` : `In ${setting.minutes} minutes`;
    const sameDay = wake.toDateString() === nowDate.toDateString();
    return { id: `after-${setting.minutes}`, label, when: sameDay ? hm(wake) : `${WEEKDAY[wake.getDay()]} ${hm(wake)}`, until: wake.getTime() };
  }
  const day = nowDate.getDay();
  const daysAhead = setting.day === "today" ? 0 : setting.day === "tomorrow" ? 1 : ((8 - day) % 7) || 7;
  const wake = new Date(now);
  wake.setDate(wake.getDate() + daysAhead);
  wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
  // Hide a time of day that has already passed today.
  if (wake.getTime() <= now) return null;
  let label: string;
  if (daysAhead === 0) {
    const hour = wake.getHours();
    label = hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  } else if (daysAhead === 1) label = "Tomorrow";
  else label = "Next week";
  const when = setting.day === "monday" && daysAhead > 1 ? `${WEEKDAY[wake.getDay()]} ${hm(wake)}` : hm(wake);
  return { id: `at-${setting.day}`, label, when, until: wake.getTime() };
}

/** Snooze menu: sorted by wake-up time, one entry per minute. */
export function resolveSnoozePresets(now: number): SnoozePreset[] {
  const seen = new Set<number>();
  return PRESET_SETTINGS.flatMap((s) => resolvePreset(s, now) ?? [])
    .sort((a, b) => a.until - b.until)
    .filter((p) => {
      const m = Math.floor(p.until / 60_000);
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
}

export type SnoozeUnit = "hour" | "day";

/** Custom snooze: a number of hours, or days at the same time of day. */
export function customSnoozeUntil(amount: number, unit: SnoozeUnit, now: number): number {
  return now + amount * (unit === "hour" ? 3600_000 : 86400_000);
}

/** Slash command argument: 1h, 3h, tomorrow, monday, a preset label, or any 5h / 2d. */
export function findSnoozePreset(arg: string, now: number): SnoozePreset | undefined {
  const presets = resolveSnoozePresets(now);
  const a = arg.trim().toLowerCase();
  if (!a) return presets[0];
  const m = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|d|days?)$/.exec(a);
  if (m && !["1h", "3h"].includes(a)) {
    const unit: SnoozeUnit = m[2].startsWith("d") ? "day" : "hour";
    const until = customSnoozeUntil(Number(m[1]), unit, now);
    return { id: "custom", label: `In ${m[1]} ${unit === "hour" ? "h" : "d"}`, when: hm(new Date(until)), until };
  }
  const alias: Record<string, string> = { "1h": "after-60", "3h": "after-180", tomorrow: "at-tomorrow", monday: "at-monday", week: "at-monday" };
  return presets.find((p) => p.id === alias[a] || p.label.replace(/\s/g, "") === a.replace(/\s/g, ""));
}

// ---- Display ----

/** Relative time in t3code's short style. */
export function relativeTime(t: number, now: number): string {
  if (!t) return "";
  const d = now - t;
  if (d < 60_000) return "now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h`;
  return `${Math.floor(d / 86400_000)}d`;
}

/** When a snooze wakes: Today 21:30, Tomorrow 09:00, Mon 09:00 (within a week), 11-30 09:00. */
export function snoozeWakeLabel(until: number, now: number): string {
  const d = new Date(until);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day0 = (t: number) => {
    const x = new Date(t);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  const days = Math.round((day0(until) - day0(now)) / 86400_000);
  if (days <= 0) return `Today ${hm}`;
  if (days === 1) return `Tomorrow ${hm}`;
  if (days < 7) return `${"Sun Mon Tue Wed Thu Fri Sat".split(" ")[d.getDay()]} ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** How long it has been running. */
export function elapsedLabel(since: number, now: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export type StatusTone = "approval" | "working" | "failed" | "done" | "woke";

export interface RowStatus {
  text: string;
  tone: StatusTone;
  icon: string;
  /** The running status icon spins. */
  spin?: boolean;
}

/** One status per row (snoozed rows show only their wake time), in t3code's priority: needs you → running → failed → woke → done; otherwise the time. */
export function rowStatus(
  ws: PluginWorkspaceSnapshot,
  e: InboxEntry | undefined,
  section: Section,
  now: number,
): RowStatus | null {
  // Snoozed rows show only when they wake, never Done / Needs you.
  if (section === "snoozed") return null;
  if (ws.status === "needs_input") return { text: "Needs you", tone: "approval", icon: "MessageCircleQuestion" };
  if (section === "working" || ws.status === "running") {
    const since = ms(ws.statusEnteredAt);
    return { text: `Running ${elapsedLabel(since, now)}`.trim(), tone: "working", icon: "LoaderCircle", spin: true };
  }
  if (ws.status === "failed") return { text: "Failed", tone: "failed", icon: "CircleAlert" };
  if (e?.woke && isUnread(e)) return { text: "Woke", tone: "woke", icon: "AlarmClock" };
  if (isUnread(e)) return { text: "Done", tone: "done", icon: "CircleCheck" };
  return null;
}

/** t3code-style dimming: running and read rows use the muted color and regular weight; rows that need you stay prominent. */
export function recedes(ws: PluginWorkspaceSnapshot, e: InboxEntry | undefined, section: Section): boolean {
  if (ws.status === "needs_input" || ws.status === "failed") return false;
  if (section === "working") return true;
  return !isUnread(e) && !e?.woke;
}
