import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { auditLog, documents, reads, studies, studyDocuments, versions } from "../db/schema.js";
import { describeAudit } from "../lib/activity.js";
import { parse } from "../lib/parse.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHOLE = (what: string) => z.coerce.number({ error: what }).int({ error: what });

const ActivityQuery = z.object({
  study: z.string().regex(UUID, { error: "Pick a contract from the list." }).optional(),
  before: WHOLE("The place to continue from must be a whole number.").min(1, { error: "The place to continue from must be a whole number." }).optional(),
  limit: WHOLE("How many to show must be a whole number from 1 to 100.").min(1, { error: "How many to show must be a whole number from 1 to 100." }).max(100, { error: "How many to show must be a whole number from 1 to 100." }).default(30),
});

export async function activityRoutes(api: FastifyInstance, { db }: Ctx) {
  api.get("/activity", async (req) => {
    const { study, before, limit } = parse(ActivityQuery, req.query);
    const readVersion = alias(versions, "read_version");
    // which contract an entry belongs to: the study itself, a version or read of it, or a study id its detail names
    const studyOf = sql<string | null>`coalesce(
      case when ${auditLog.entity} = 'study' then ${auditLog.entityId} end,
      ${versions.studyId},
      ${readVersion.studyId},
      case when ${auditLog.detail}->>'studyId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${auditLog.detail}->>'studyId')::uuid end)`;

    const rows = await db
      .select({ entry: auditLog, studyId: studyOf, versionNumber: sql<number | null>`coalesce(${versions.number}, ${readVersion.number})` })
      .from(auditLog)
      .leftJoin(versions, and(eq(auditLog.entity, "version"), eq(versions.id, auditLog.entityId)))
      .leftJoin(reads, and(eq(auditLog.entity, "read"), eq(reads.id, auditLog.entityId)))
      .leftJoin(readVersion, eq(readVersion.id, reads.versionId))
      .where(and(before ? lt(auditLog.id, before) : undefined, study ? sql`${studyOf} = ${study}::uuid` : undefined))
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const ids = [...new Set(page.flatMap((r) => (r.studyId ? [r.studyId] : [])))];
    const [protocols, firsts] = ids.length
      ? await Promise.all([
          db.select({ id: studies.id, protocol: studies.protocol }).from(studies).where(inArray(studies.id, ids)),
          db
            .selectDistinctOn([studyDocuments.studyId], { studyId: studyDocuments.studyId, name: documents.name })
            .from(studyDocuments)
            .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
            .where(inArray(studyDocuments.studyId, ids))
            .orderBy(studyDocuments.studyId, studyDocuments.addedAt, documents.name),
        ])
      : [[], []];
    const title = (id: string | null) => (id ? protocols.find((p) => p.id === id)?.protocol || firsts.find((f) => f.studyId === id)?.name || null : null);

    return {
      items: page.map(({ entry, studyId, versionNumber }) => ({
        id: entry.id,
        at: entry.at.toISOString(),
        by: entry.by,
        ...describeAudit({ by: entry.by, action: entry.action, detail: entry.detail, versionNumber }),
        studyId,
        studyTitle: title(studyId),
        versionNumber,
      })),
      next: rows.length > limit ? page.at(-1)!.entry.id : null,
    };
  });
}
