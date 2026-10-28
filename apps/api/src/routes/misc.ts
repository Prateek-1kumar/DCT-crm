import { type AuditEntryDto, PatchSettingsBody, type SettingsDto } from "@dct/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Ctx } from "../app.js";
import { auditLog, rulebookVersions, settings } from "../db/schema.js";
import { audit } from "../domain.js";
import { isObj, parse } from "../lib/http.js";
import { blindQuestion, hiddenPaths } from "../review.js";

/** PATCH accepts any subset of SettingsDto, plus who changed it. */

export const miscRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { studyId?: string } }>("/audit", async (req): Promise<AuditEntryDto[]> => {
      const rows = await db
        .select()
        .from(auditLog)
        .where(req.query.studyId ? eq(auditLog.studyId, req.query.studyId) : undefined)
        .orderBy(desc(auditLog.id)); // newest first
      // Blind entry holds here too: while a value's question is open, an earlier answer, typed or carried value isn't shown.
      const drafts = await db
        .select({ studyId: rulebookVersions.studyId, version: rulebookVersions.version, status: rulebookVersions.status, review: rulebookVersions.review })
        .from(rulebookVersions)
        .where(and(eq(rulebookVersions.status, "draft"), req.query.studyId ? eq(rulebookVersions.studyId, req.query.studyId) : undefined));
      const hidden = new Map(drafts.map((d) => [`${d.studyId}/${d.version}`, new Set(hiddenPaths(d))]));
      const blind = (studyId: string | null, d: Record<string, unknown>) => {
        const h = hidden.get(`${studyId}/${d.version}`);
        if (!h?.size) return d;
        const strip = (x: unknown) => (isObj(x) && typeof x.path === "string" && h.has(x.path) ? Object.fromEntries(Object.entries(x).filter(([k]) => !["before", "after"].includes(k))) : x);
        const out = strip(d) as Record<string, unknown>;
        for (const k of ["carried", "skipped"]) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(strip);
        // a contract problem's question quotes the read numbers (see blindReview)
        if (typeof out.question === "string" && typeof out.itemId === "string" && out.itemId.startsWith("anomaly:")) out.question = blindQuestion(out.itemId, out.question, h);
        return out;
      };
      return rows.map((r) => ({ id: String(r.id), at: r.at.toISOString(), by: r.by, studyId: r.studyId, action: r.action, detail: blind(r.studyId, r.detail) }));
    });

    const read = async (): Promise<SettingsDto> => {
      const [row] = await db.select().from(settings).where(eq(settings.id, 1));
      return { makerChecker: row?.makerChecker ?? false, people: row?.people ?? [] };
    };

    app.get("/settings", read);

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
