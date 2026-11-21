// Run: npm test
import assert from "node:assert/strict";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { InboxEntry } from "../shared/contract";
import { activityTime, applyOp, customSnoozeUntil, findSnoozePreset, isUnread, onAttention, onSnoozeTick, onTurnStart, resolveSnoozePresets, rowStatus, sectionOf, snoozeWakeLabel, sortKey } from "../shared/inbox";

const T0 = Date.parse("2026-11-21T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
function ws(over: Partial<PluginWorkspaceSnapshot> = {}): PluginWorkspaceSnapshot {
  return {
    id: "w1",
    status: "done",
    background: false,
    parentAgent: null,
    pinnedAt: null,
    createdAt: iso(T0 - 86400_000),
    lastPromptAt: iso(T0 - 3600_000),
    statusEnteredAt: iso(T0),
    ...over,
  } as unknown as PluginWorkspaceSnapshot;
}

// 1. Finished → unread; opening it (Paseo clears attention, statusEnteredAt resets to now) changes neither unread nor order
{
  let e: InboxEntry = onAttention({}, "finished", T0);
  assert.ok(isUnread(e));
  const opened = ws({ statusEnteredAt: iso(T0 + 60_000) });
  assert.equal(activityTime(opened, e), T0);
  assert.equal(sectionOf(opened, e, undefined, T0 + 60_000), "inbox");
  // 2. Mark read / mark unread
  e = applyOp(e, "read", T0 + 70_000);
  assert.ok(!isUnread(e));
  e = applyOp(e, "unread", T0 + 80_000);
  assert.ok(isUnread(e));
}

// 3. Order: most recently finished first; without a record, the last message time
{
  const a = ws({ id: "a", lastPromptAt: iso(T0 - 5000) });
  const b = ws({ id: "b", lastPromptAt: iso(T0 - 9_000_000) });
  const eb = onAttention({}, "finished", T0);
  assert.ok(sortKey(b, eb, "inbox") > sortKey(a, undefined, "inbox"));
}

// 4. Snooze: finishing does not wake it, failing / waiting for approval does; when due it returns to the inbox unread
{
  const s = applyOp({}, "snooze", T0, T0 + 3600_000);
  assert.equal(sectionOf(ws(), s, undefined, T0 + 1000), "snoozed");
  assert.equal(onAttention(s, "finished", T0 + 1000).snoozedUntil, T0 + 3600_000);
  assert.equal(onAttention(s, "permission", T0 + 1000).snoozedUntil, undefined);
  assert.equal(onSnoozeTick(s, T0 + 1000), null);
  const woke = onSnoozeTick(s, T0 + 3600_001)!;
  assert.ok(isUnread(woke) && woke.woke && woke.returnedAt === T0 + 3600_000);
}

// 5. Archive: running again unarchives; running agents sit in Working; new attention returns to the inbox
{
  const s = applyOp({}, "settle", T0);
  assert.equal(sectionOf(ws(), s, undefined, T0), "settled");
  assert.equal(sectionOf(ws({ status: "running" }), s, undefined, T0), "working");
  assert.equal(onTurnStart(s).settledAt, undefined);
  assert.equal(sectionOf(ws(), onAttention(s, "finished", T0 + 1), undefined, T0 + 1), "inbox");
}

// 6. Read and idle for 7 days → auto-archived; agents that need you are not; pinned wins
{
  const old = ws({ lastPromptAt: iso(T0 - 8 * 86400_000), createdAt: iso(T0 - 9 * 86400_000) });
  assert.equal(sectionOf(old, undefined, undefined, T0), "settled");
  assert.equal(sectionOf({ ...old, status: "needs_input" } as PluginWorkspaceSnapshot, undefined, undefined, T0), "inbox");
  assert.equal(sectionOf(old, applyOp({}, "pin", T0), undefined, T0), "pinned");
}

// 7. Snooze presets: sorted by wake time; next Monday 9:00; custom hours / days
{
  const morning = new Date(2026, 10, 21, 10, 0).getTime(); // Saturday 10:00
  assert.deepEqual(resolveSnoozePresets(morning).map((p) => p.id), ["after-60", "after-180", "at-tomorrow", "at-monday"]);
  const monday = findSnoozePreset("monday", morning)!;
  assert.equal(new Date(monday.until).getDay(), 1);
  assert.equal(new Date(monday.until).getHours(), 9);
  assert.equal(findSnoozePreset("5h", morning)!.until, morning + 5 * 3600_000);
  assert.equal(findSnoozePreset("2d", morning)!.until, morning + 2 * 86400_000);
  assert.equal(findSnoozePreset("1h", morning)!.id, "after-60");
  assert.equal(customSnoozeUntil(1.5, "hour", morning), morning + 5400_000);
  assert.equal(snoozeWakeLabel(morning + 45 * 60_000, morning), "45m");
  assert.equal(snoozeWakeLabel(morning + 3 * 3600_000, morning), "3h");
}

// 8. Status: needs you comes first; finished and unread shows Done; read shows none
{
  assert.equal(rowStatus(ws({ status: "needs_input" }), undefined, "inbox", T0)?.text, "Needs you");
  const e = onAttention({}, "finished", T0);
  assert.equal(rowStatus(ws(), e, "inbox", T0)?.text, "Done");
  assert.equal(rowStatus(ws(), applyOp(e, "read", T0 + 1), "inbox", T0 + 1), null);
}

console.log("All inbox logic tests passed");
