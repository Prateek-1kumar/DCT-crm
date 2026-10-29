import { ACTION_LABELS, type AuditEntryDto, AuditListQuery, type AuditPage, auditMatches, blindDetail, PatchSettingsBody, type SettingsDto } from "@dct/shared";
import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Ctx } from "../app.js";
import type { Tx } from "../db/index.js";
import { auditLog, rulebookVersions, settings, studies } from "../db/schema.js";
import { audit } from "../domain.js";
import { HttpError, like, parse, wordsOf } from "../lib/http.js";
import { write } from "../lib/idempotency.js";
import { hiddenPaths } from "../review.js";

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

/** Batches of `limit + 1` entries one request reads at most while `q` matches only what's blanked (GET /audit). */
const SCAN_ROUNDS = 10;

/** Every text and number in the details, keys left out (as @dct/shared detailText reads them). */
const detailText = sql`(SELECT string_agg(x #>> '{}', ' ') FROM jsonb_path_query(${auditLog.detail}, 'strict $.** ? (@.type() == "string" || @.type() == "number")') x)`;
/** One word of `q`: in the person, the action's code or what it's called, or the details. */
const matchesWord = (w: string) => {
  const named = Object.keys(ACTION_LABELS).filter((a) => ACTION_LABELS[a]!.toLowerCase().includes(w.toLowerCase()));
  return or(ilike(auditLog.by, like(w)), ilike(auditLog.action, like(w)), named.length ? inArray(auditLog.action, named) : undefined, sql`${detailText} ILIKE ${like(w)}`);
};

export const miscRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    /**
     * One page of the log, newest first. `q` is matched in SQL; an entry is returned only if what's shown matches too, so
     * a withheld value or a blanked number never finds one. Pages can then hold fewer than `limit` entries: at most
     * SCAN_ROUNDS batches are read per request, and the cursor goes on from the last entry read, so a `q` that only
     * blanked entries match can't keep one request reading the whole log.
     */
    app.get("/audit", async (req): Promise<AuditPage> => {
      const { studyId, q, cursor, limit } = parse(AuditListQuery, req.query);
      const words = wordsOf(q);
      const where = and(studyId ? eq(auditLog.studyId, studyId) : undefined, ...words.map(matchesWord));
      // blind entry in the log (@dct/shared blindDetail): each open draft's withheld paths, questions and evidence
      const drafts = new Map<string, Parameters<typeof blindDetail>[2]>();
      const looked = new Set<string>();
      const items: AuditEntryDto[] = [];
      let after = cursor ? decodeCursor(cursor) : null;
      let more = false;
      for (let round = 0; ; round++) {
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
            .select({ studyId: rulebookVersions.studyId, version: rulebookVersions.version, status: rulebookVersions.status, review: rulebookVersions.review, evidence: rulebookVersions.evidence, rulebook: rulebookVersions.rulebook })
            .from(rulebookVersions)
            .where(and(eq(rulebookVersions.status, "draft"), inArray(rulebookVersions.studyId, unseen)));
          for (const v of found) drafts.set(`${v.studyId}/${v.version}`, { hidden: new Set(hiddenPaths(v)), review: v.review, evidence: v.evidence });
        }
        for (const { e, protocol, sponsor } of rows) {
          const detail = blindDetail(e.action, e.detail, drafts.get(`${e.studyId}/${e.detail.version}`));
          const entry: AuditEntryDto = { id: String(e.id), at: e.at.toISOString(), by: e.by, studyId: e.studyId, protocol, sponsor, action: e.action, detail };
          if (!words.length || auditMatches(entry, q!)) items.push(entry);
          if (items.length > limit) break;
        }
        if (items.length > limit || rows.length <= limit) break;
        after = rows.at(-1)!.e.id;
        if (round + 1 >= SCAN_ROUNDS) {
          more = true;
          break;
        }
      }
      const page = items.slice(0, limit);
      return { items: page, nextCursor: items.length > limit ? encodeCursor(Number(page.at(-1)!.id)) : more ? encodeCursor(after!) : null };
    });

    // maker-checker is on unless someone turned it off (ADR-001 §10)
    const read = async (tx: Tx = db): Promise<SettingsDto> => {
      const [row] = await tx.select().from(settings).where(eq(settings.id, 1));
      return { makerChecker: row?.makerChecker ?? true, people: row?.people ?? [] };
    };

    app.get("/settings", () => read());

    /** PATCH accepts any subset of SettingsDto, plus who changed it. */
    app.patch("/settings", async (req, reply) => {
      const { by, ...patch } = parse(PatchSettingsBody, req.body);
      return write(db, req, reply, async (tx) => {
        // read under the row lock: two edits at once each see the other's
        const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for("no key update");
        const before: SettingsDto = { makerChecker: row?.makerChecker ?? true, people: row?.people ?? [] };
        const after = { ...before, ...patch };
        // the same settings again change nothing, so they log nothing
        if (isDeepStrictEqual(before, after)) return before;
        await tx.insert(settings).values({ id: 1, ...after }).onConflictDoUpdate({ target: settings.id, set: after });
        await audit(tx, by ?? "system", null, "settings.updated", { before, after });
        return read(tx);
      });
    });
  };
