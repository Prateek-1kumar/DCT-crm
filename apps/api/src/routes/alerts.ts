import { AlertListQuery, type AlertPage, blankNumbers, ReadAlertsBody } from "@dct/shared";
import { count, desc, eq, inArray, not, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import type { Tx } from "../db/index.js";
import { alertReads, alerts, studies } from "../db/schema.js";
import { HttpError, parse } from "../lib/http.js";
import { write } from "../lib/idempotency.js";

/** Read for `person`: they marked it, or they caused it. Names compared as samePerson (@dct/shared) compares them: trimmed, ignoring case. */
const same = (a: SQL, person: string) => sql`lower(btrim(${a})) = lower(btrim(${person}))`;
const readBy = (person: string) =>
  sql<boolean>`(${same(sql`${alerts.by}`, person)} OR EXISTS (SELECT 1 FROM alert_reads r WHERE r.alert_id = ${alerts.id} AND ${same(sql`r.person`, person)}))`;

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
    const unreadFor = async (person: string, tx: Tx = db) => (await tx.select({ n: count() }).from(alerts).where(not(readBy(person))))[0]!.n;

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
          // everyone sees every alert, and a send-back note can name the value being answered again blind
          note: a.note && blankNumbers(a.note),
          read,
        })),
        unread: await unreadFor(q.for),
        nextCursor: rows.length > q.limit ? encodeCursor({ micros: page.at(-1)!.micros, id: page.at(-1)!.a.id }) : null,
      };
    });

    app.post("/alerts/read", async (req, reply) => {
      const { by, ids } = parse(ReadAlertsBody, req.body);
      // Unknown ids select nothing; already read is a no-op. Not audit-logged: reading alerts changes no contract.
      return write(db, req, reply, async (tx) => {
        await tx
          .insert(alertReads)
          .select(tx.select({ alertId: alerts.id, person: sql<string>`${by}::text`.as("person") }).from(alerts).where(ids ? inArray(alerts.id, ids) : undefined))
          .onConflictDoNothing();
        return { unread: await unreadFor(by, tx) };
      });
    });
  };
