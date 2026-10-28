import { z } from "zod";
import { Person } from "./evidence";

/**
 * Alerts: a contract has reached a step where someone is needed. Everyone on the team sees every alert; whether it has
 * been read is kept per person (there is no login yet, so a person is the name they picked). Alerts someone caused
 * themselves count as read for them.
 */

/** Raised when a contract moves into a step. questions_ready: into Needs you (reading finished, or a question sent it back
 * from approval) · ready_for_approval: nothing left to answer · sent_back: an approver reopened answers · couldnt_read: reading failed. */
export const AlertKind = z.enum(["questions_ready", "ready_for_approval", "sent_back", "couldnt_read"]);
export type AlertKind = z.infer<typeof AlertKind>;

export const AlertDto = z.object({
  id: z.string(),
  kind: AlertKind,
  studyId: z.string(),
  protocol: z.string().nullable(),
  sponsor: z.string().nullable(),
  version: z.number().int(),
  at: z.string(),
  /** Who caused it; "system" for the result of reading. */
  by: z.string(),
  /** questions_ready: open questions · sent_back: answers reopened. */
  count: z.number().int().nullable(),
  /** sent_back: the approver's note. */
  note: z.string().nullable(),
  /** For the person asking. */
  read: z.boolean(),
});
export type AlertDto = z.infer<typeof AlertDto>;

/** GET /alerts?for=&cursor=&limit=: newest first, with `read` and `unread` for `for`. `cursor` is opaque. */
export const AlertListQuery = z.object({
  for: Person,
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AlertListQuery = Partial<z.infer<typeof AlertListQuery>> & { for: string };

export const AlertPage = z.object({ items: z.array(AlertDto), unread: z.number().int(), nextCursor: z.string().nullable() });
export type AlertPage = z.infer<typeof AlertPage>;

/** POST /alerts/read: marks `ids` (or, without ids, every alert) read for `by`. Returns `{ unread }`. */
export const ReadAlertsBody = z.object({ by: Person, ids: z.array(z.string()).min(1).max(100).optional() });
export type ReadAlertsBody = z.infer<typeof ReadAlertsBody>;
