// Plugin server: listens in the daemon for turn finished / waiting for approval / started running, keeps inbox state and pushes it to every client.
// Attention events are recorded even when no client is open. Paseo's agent data is never written.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { actionRpc, stateSubscription } from "./shared/contract";
import { applyOp, onAttention, onSnoozeTick, onTurnStart } from "./shared/inbox";
import { InboxStore } from "./server/store";

interface HookAgent {
  workspaceId: string | null;
  parentAgentId: string | null;
  background: boolean;
}

/** Only top-level, non-background agents in a workspace count; subagents and background helpers stay out of the inbox. */
function workspaceOf(agent: HookAgent): string | null {
  if (agent.background || agent.parentAgentId) return null;
  return agent.workspaceId;
}

export default function contribute(server: PluginServerContext) {
  const store = new InboxStore();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    server.addHook("agent.turn.after", async ({ agent, outcome }) => {
      const id = workspaceOf(agent);
      if (!id) return;
      const now = Date.now();
      if (outcome.kind === "canceled") {
        // Interrupted by you: back to the inbox, but not marked unread.
        store.update([id], (e) => ({ ...e, returnedAt: now }));
        return;
      }
      store.update([id], (e) => onAttention(e, outcome.kind === "failed" ? "failed" : "finished", now));
    }),
  );

  cleanups.push(
    server.addHook("agent.permission.before", async ({ agent }) => {
      const id = workspaceOf(agent);
      if (!id) return;
      store.update([id], (e) => onAttention(e, "permission", Date.now()));
    }),
  );

  cleanups.push(
    server.addHook("agent.turn.before", async ({ agent }) => {
      const id = workspaceOf(agent);
      if (!id) return;
      store.update([id], (e) => (e.settledAt == null ? null : onTurnStart(e)));
    }),
  );

  cleanups.push(
    server.addHook("workspace.archive.after", async ({ workspace }) => {
      store.remove(workspace.id);
    }),
  );

  // Check for expired snoozes.
  const tick = setInterval(() => {
    const now = Date.now();
    const due = Object.keys(store.snapshot()).filter((id) => {
      const u = store.get(id).snoozedUntil;
      return u != null && u <= now;
    });
    if (due.length) store.update(due, (e) => onSnoozeTick(e, now));
  }, 20_000);
  cleanups.push(() => clearInterval(tick));

  server.handle(actionRpc, ({ workspaceIds, op, until }) => {
    const now = Date.now();
    store.update(workspaceIds, (e) => applyOp(e, op, now, until));
    return { ok: true };
  });

  // The subscription closes as soon as the handler's promise settles, so keep it pending until the client disconnects (signal abort).
  server.handle(
    stateSubscription,
    (_input, ctx) =>
      new Promise<void>((resolve) => {
        void ctx.push({ state: store.snapshot() });
        const off = store.subscribe((state) => {
          void ctx.push({ state });
        });
        ctx.signal.addEventListener(
          "abort",
          () => {
            off();
            resolve();
          },
          { once: true },
        );
      }),
  );

  return () => {
    for (const c of cleanups.reverse()) c();
    store.flush();
  };
}
