import type { Tx } from "../db/index.js";
import { auditLog } from "../db/schema.js";

export interface AuditEntry {
  by: string;
  action: string;
  entity: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

/** Records an action; call it inside the same transaction as the change, so the log never disagrees with the data. */
export async function audit(tx: Tx, entry: AuditEntry) {
  await tx.insert(auditLog).values(entry);
}
