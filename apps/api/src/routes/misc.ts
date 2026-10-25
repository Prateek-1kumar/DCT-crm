import { type AuditEntryDto, PatchSettingsBody, type SettingsDto } from "@dct/shared";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { auditLog, settings } from "../db/schema.js";
import { audit } from "../domain.js";
import { parse } from "../lib/http.js";

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
      return rows.map((r) => ({ id: String(r.id), at: r.at.toISOString(), by: r.by, studyId: r.studyId, action: r.action, detail: r.detail }));
    });

    const read = async (): Promise<SettingsDto> => {
      const [row] = await db.select().from(settings).where(eq(settings.id, 1));
      return { makerChecker: row?.makerChecker ?? false, people: row?.people ?? [] };
    };

    app.get("/settings", read);

    app.patch("/settings", async (req) => {
      const { by, ...patch } = parse(PatchSettingsBody, req.body);
      const before = await read();
      await db.transaction(async (tx) => {
        await tx.insert(settings).values({ id: 1, ...before, ...patch }).onConflictDoUpdate({ target: settings.id, set: { ...before, ...patch } });
        await audit(tx, by ?? "system", null, "settings.updated", { before, after: { ...before, ...patch } });
      });
      return read();
    });
  };
