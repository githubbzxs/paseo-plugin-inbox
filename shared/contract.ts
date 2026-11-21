// Contract between the client and the plugin server. Inbox state lives on the server in the plugin's own data file; Paseo's agent data is never written.
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const entrySchema = z.object({
  /** Last time the agent needed attention (turn finished, failed, waiting for approval, snooze expired). */
  unreadAt: z.number().optional(),
  /** Last time it was marked read; unread when unreadAt is later than this. */
  readAt: z.number().optional(),
  /** When it returned to the inbox; the inbox is sorted by this, newest first. */
  returnedAt: z.number().optional(),
  snoozedUntil: z.number().optional(),
  snoozedAt: z.number().optional(),
  woke: z.boolean().optional(),
  settledAt: z.number().optional(),
  pinned: z.boolean().optional(),
});
export type InboxEntry = z.infer<typeof entrySchema>;

export const stateSchema = z.record(z.string(), entrySchema);
export type InboxStateMap = z.infer<typeof stateSchema>;

export const stateSubscription = defineSubscription({
  name: "inbox.state",
  input: z.object({}),
  event: z.object({ state: stateSchema }),
});

export const opSchema = z.enum(["read", "unread", "ack", "snooze", "unsnooze", "settle", "unsettle", "pin", "unpin"]);
export type InboxOp = z.infer<typeof opSchema>;

export const actionRpc = defineRpc({
  name: "inbox.action",
  input: z.object({
    workspaceIds: z.array(z.string()).min(1),
    op: opSchema,
    /** For snooze: wake-up time (epoch milliseconds). */
    until: z.number().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});
