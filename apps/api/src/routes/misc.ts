import { ACTION_LABELS, type AuditEntryDto, AuditListQuery, type AuditPage, auditMatches, blankNumbers, PatchSettingsBody, type ReviewItem, type SettingsDto } from "@dct/shared";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { auditLog, rulebookVersions, settings, studies } from "../db/schema.js";
import { audit } from "../domain.js";
import { HttpError, isObj, like, parse, wordsOf } from "../lib/http.js";
import { blindItem, hiddenPaths } from "../review.js";

/** Keyset cursor: the last entry's id, base64url JSON (ids only grow, so newest first is id order). */
const Cursor = z.tuple([z.number().int().positive()]);
const encodeCursor = (id: number) => Buffer.from(JSON.stringify([id])).toString("base64url");
function decodeCursor(c: string) {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(c, "base64url").toString()))[0];
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

/** Every text and number in the details, keys left out (as @dct/shared detailText reads them). */
const detailText = sql`(SELECT string_agg(x #>> '{}', ' ') FROM jsonb_path_query(${auditLog.detail}, 'strict $.** ? (@.type() == "string" || @.type() == "number")') x)`;
/** One word of `q`: in the person, the action's code or what it's called, or the details. */
const matchesWord = (w: string) => {
  const named = Object.keys(ACTION_LABELS).filter((a) => ACTION_LABELS[a]!.toLowerCase().includes(w.toLowerCase()));
  return or(ilike(auditLog.by, like(w)), ilike(auditLog.action, like(w)), named.length ? inArray(auditLog.action, named) : undefined, sql`${detailText} ILIKE ${like(w)}`);
};

type Open = { hidden: Set<string>; review: ReviewItem[] };

/**
 * Blind entry in the log: while a value's question is open on its draft, an entry about it (its path, or the question it
 * answered or sent back) shows no earlier answer, typed or carried value (`before` / `after`), and its note, and a
 * contract problem's wording, have their numbers blanked. A send-back logged before it named its questions is blanked
 * while anything on its draft is open.
 */
function blindDetail(action: string, d: Record<string, unknown>, open: Open | undefined): Record<string, unknown> {
  if (!open?.hidden.size) return d;
  const h = open.hidden;
  const about = (x: Record<string, unknown>) => typeof x.path === "string" && h.has(x.path);
  const strip = ({ before: _b, after: _a, ...x }: Record<string, unknown>) => (typeof x.note === "string" ? { ...x, note: blankNumbers(x.note) } : x);
  const ids = [d.itemId, ...(Array.isArray(d.itemIds) ? d.itemIds : [])];
  const blind = about(d) || open.review.some((i) => ids.includes(i.id) && blindItem(i, h)) || (action === "review.sent_back" && !Array.isArray(d.itemIds));
  const out = blind ? strip(d) : { ...d };
  for (const k of ["carried", "skipped"]) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map((x) => (isObj(x) && about(x) ? strip(x) : x));
  if (blind && typeof out.question === "string" && typeof out.itemId === "string" && out.itemId.startsWith("anomaly:")) out.question = blankNumbers(out.question);
  return out;
}

export const miscRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    /**
     * One page of the log, newest first. `q` is matched in SQL; an entry is returned only if what's shown matches too, so
     * a withheld value or a blanked number never finds one. Pages can then hold fewer than `limit` entries.
     */
    app.get("/audit", async (req): Promise<AuditPage> => {
      const { studyId, q, cursor, limit } = parse(AuditListQuery, req.query);
      const words = wordsOf(q);
      const where = and(studyId ? eq(auditLog.studyId, studyId) : undefined, ...words.map(matchesWord));
      const drafts = new Map<string, Open>();
      const looked = new Set<string>();
      const items: AuditEntryDto[] = [];
      let after = cursor ? decodeCursor(cursor) : null;
      for (;;) {
        const rows = await db
          .select({ e: auditLog, protocol: studies.protocol, sponsor: studies.sponsor })
          .from(auditLog)
          .leftJoin(studies, eq(studies.id, auditLog.studyId))
          .where(and(where, after !== null ? lt(auditLog.id, after) : undefined))
          .orderBy(desc(auditLog.id))
          .limit(limit + 1);
        const unseen = [...new Set(rows.flatMap((r) => (r.e.studyId && !looked.has(r.e.studyId) ? [r.e.studyId] : [])))];
        if (unseen.length) {
          for (const s of unseen) looked.add(s);
          const found = await db
            .select({ studyId: rulebookVersions.studyId, version: rulebookVersions.version, status: rulebookVersions.status, review: rulebookVersions.review })
            .from(rulebookVersions)
            .where(and(eq(rulebookVersions.status, "draft"), inArray(rulebookVersions.studyId, unseen)));
          for (const v of found) drafts.set(`${v.studyId}/${v.version}`, { hidden: new Set(hiddenPaths(v)), review: v.review });
        }
        for (const { e, protocol, sponsor } of rows) {
          const detail = blindDetail(e.action, e.detail, drafts.get(`${e.studyId}/${e.detail.version}`));
          const entry: AuditEntryDto = { id: String(e.id), at: e.at.toISOString(), by: e.by, studyId: e.studyId, protocol, sponsor, action: e.action, detail };
          if (!words.length || auditMatches(entry, q!)) items.push(entry);
          if (items.length > limit) break;
        }
        if (items.length > limit || rows.length <= limit) break;
        after = rows.at(-1)!.e.id;
      }
      const page = items.slice(0, limit);
      return { items: page, nextCursor: items.length > limit ? encodeCursor(Number(page.at(-1)!.id)) : null };
    });

    const read = async (): Promise<SettingsDto> => {
      const [row] = await db.select().from(settings).where(eq(settings.id, 1));
      return { makerChecker: row?.makerChecker ?? false, people: row?.people ?? [] };
    };

    app.get("/settings", read);

    /** PATCH accepts any subset of SettingsDto, plus who changed it. */
    app.patch("/settings", async (req) => {
      const { by, ...patch } = parse(PatchSettingsBody, req.body);
      await db.transaction(async (tx) => {
        // read under the row lock: two edits at once each see the other's
        const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("update");
        const before: SettingsDto = { makerChecker: row?.makerChecker ?? false, people: row?.people ?? [] };
        await tx.insert(settings).values({ id: 1, ...before, ...patch }).onConflictDoUpdate({ target: settings.id, set: { ...before, ...patch } });
        await audit(tx, by ?? "system", null, "settings.updated", { before, after: { ...before, ...patch } });
      });
      return read();
    });
  };
