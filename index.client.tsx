// Plugin entry: registers the inbox sidebar view, ⌘K commands and the /snooze and /settle slash commands.
import type {
  PluginAgentCommandContext,
  PluginClientContext,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { InboxSidebar } from "./client/sidebar";
import { actionRpc, type InboxOp } from "./shared/contract";
import { findSnoozePreset, resolveSnoozePresets } from "./shared/inbox";

type Ctx = PluginAgentCommandContext | PluginWorkspaceCommandContext;

function run(ctx: Ctx, op: InboxOp, until?: number) {
  return ctx.rpc(actionRpc, { workspaceIds: [ctx.workspace.id], op, until }).then(() => undefined);
}

export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    client.addSidebarView({
      id: "inbox",
      title: "Inbox",
      description: "Agents sorted like email: what needs you stays in the inbox; archive when done, snooze or pin",
      Component: InboxSidebar,
    }),
  );

  const commands: Array<{ id: string; title: string; icon: string; op: InboxOp; until?: (now: number) => number }> = [
    { id: "settle", title: "Inbox: Done (archive)", icon: "CircleCheck", op: "settle" },
    { id: "unread", title: "Inbox: Mark unread", icon: "Mail", op: "unread" },
    { id: "unsettle", title: "Inbox: Move to inbox", icon: "Undo2", op: "unsettle" },
    { id: "unsnooze", title: "Inbox: Wake now", icon: "AlarmClockOff", op: "unsnooze" },
    { id: "pin", title: "Inbox: Pin", icon: "Pin", op: "pin" },
    { id: "unpin", title: "Inbox: Unpin", icon: "PinOff", op: "unpin" },
    ...["after-60", "after-180", "at-tomorrow", "at-monday"].map((pid) => ({
      id: `snooze-${pid}`,
      title: `Inbox: Snooze (${{ "after-60": "1 hour", "after-180": "3 hours", "at-tomorrow": "tomorrow 9:00", "at-monday": "next Monday 9:00" }[pid]})`,
      icon: "Clock",
      op: "snooze" as const,
      until: (now: number) => {
        const presets = resolveSnoozePresets(now);
        return (presets.find((p) => p.id === pid) ?? presets[0]!).until;
      },
    })),
  ];

  for (const cmd of commands) {
    for (const context of ["agent", "workspace"] as const) {
      const base = {
        id: `${cmd.id}-${context}`,
        title: cmd.title,
        icon: cmd.icon,
        keywords: ["inbox", cmd.op],
      };
      const onSelect = (ctx: Ctx) => run(ctx, cmd.op, cmd.until?.(Date.now()));
      cleanups.push(
        context === "agent"
          ? client.addCommandCenterItem({ ...base, context, onSelect })
          : client.addCommandCenterItem({ ...base, context, onSelect }),
      );
    }
  }

  cleanups.push(
    client.addSlashCommand({
      name: "snooze",
      description: "Inbox: snooze the current agent",
      argumentHint: "1h | 3h | tomorrow | monday | 5h | 2d",
      context: "agent",
      onSubmit: (ctx) => {
        const now = Date.now();
        const opt = findSnoozePreset(ctx.args, now) ?? resolveSnoozePresets(now)[0]!;
        return run(ctx, "snooze", opt.until);
      },
    }),
  );

  cleanups.push(
    client.addSlashCommand({
      name: "settle",
      description: "Inbox: archive the current agent",
      argumentHint: "",
      context: "agent",
      onSubmit: (ctx) => run(ctx, "settle"),
    }),
  );

  return () => {
    for (const c of cleanups.reverse()) c();
  };
}
