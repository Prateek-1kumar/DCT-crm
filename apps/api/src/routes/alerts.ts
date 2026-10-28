import { AlertListQuery, type AlertPage, ReadAlertsBody } from "@dct/shared";
import { count, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { alertReads, alerts, studies } from "../db/schema.js";
import { HttpError, parse } from "../lib/http.js";

/** Read for `person`: they marked it, or they caused it. */
const readBy = (person: string) =>
  sql<boolean>`(${alerts.by} = ${person} OR EXISTS (SELECT 1 FROM alert_reads r WHERE r.alert_id = ${alerts.id} AND r.person = ${person}))`;

/** created_at in whole microseconds: exact in a JS number, where a Date keeps only milliseconds. */
const micros = sql<number>`(extract(epoch FROM ${alerts.createdAt}) * 1000000)::float8`;

/** Keyset cursor: the last row's (created_at µs, id), base64url JSON. */
const Cursor = z.tuple([z.number().int(), z.uuid()]);
const encodeCursor = (r: { micros: number; id: string }) => Buffer.from(JSON.stringify([r.micros, r.id])).toString("base64url");
function decodeCursor(c: string) {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(c, "base64url").toString()));
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

export const alertRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    const unreadFor = async (person: string) => (await db.select({ n: count() }).from(alerts).where(not(readBy(person))))[0]!.n;

    app.get("/alerts", async (req): Promise<AlertPage> => {
      const q = parse(AlertListQuery, req.query);
      const after = q.cursor ? decodeCursor(q.cursor) : null;
      const rows = await db
        .select({ a: alerts, protocol: studies.protocol, sponsor: studies.sponsor, read: readBy(q.for), micros })
        .from(alerts)
        .innerJoin(studies, eq(studies.id, alerts.studyId))
        .where(after ? sql`(${alerts.createdAt}, ${alerts.id}) < (timestamptz 'epoch' + ${after[0]}::bigint * interval '1 microsecond', ${after[1]}::uuid)` : undefined)
        .orderBy(desc(alerts.createdAt), desc(alerts.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map(({ a, protocol, sponsor, read }) => ({
          id: a.id,
          kind: a.kind,
          studyId: a.studyId,
          protocol,
          sponsor,
          version: a.version,
          at: a.createdAt.toISOString(),
          by: a.by,
          count: a.count,
          note: a.note,
          read,
        })),
        unread: await unreadFor(q.for),
        nextCursor: rows.length > q.limit ? encodeCursor({ micros: page.at(-1)!.micros, id: page.at(-1)!.a.id }) : null,
      };
    });

    app.post("/alerts/read", async (req) => {
      const { by, ids } = parse(ReadAlertsBody, req.body);
      // Unknown ids select nothing; already read is a no-op. Not audit-logged: reading alerts changes no contract.
      await db
        .insert(alertReads)
        .select(db.select({ alertId: alerts.id, person: sql<string>`${by}::text`.as("person") }).from(alerts).where(ids ? inArray(alerts.id, ids) : undefined))
        .onConflictDoNothing();
      return { unread: await unreadFor(by) };
    });
  };
