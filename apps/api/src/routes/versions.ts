import { ChooseGridBody, CorrectValueBody, ResolveAnomalyBody, Rulebook, SignOffBody } from "@dct/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { rulebookVersions, settings } from "../db/schema.js";
import { appliesFromOf, assertDraft, audit, loadVersion, recheck, refreshStudyStatus, versionDto } from "../domain.js";
import { getExtraction } from "../extraction/port.js";
import { diffRulebooks } from "../lib/diff.js";
import { HttpError, parse } from "../lib/http.js";
import { getAt, markManual, parsePointer, setAt } from "../lib/pointer.js";

type P = { Params: { id: string; v: string } };
const versionNo = (v: string) => {
  if (!/^\d+$/.test(v)) throw new HttpError(400, `Invalid version "${v}"`);
  return Number(v);
};

export const versionRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.get<P>("/studies/:id/versions/:v", async (req) => versionDto(await loadVersion(db, req.params.id, versionNo(req.params.v))));

    app.get<P & { Querystring: { against?: string } }>("/studies/:id/versions/:v/diff", async (req) => {
      const against = req.query.against;
      if (!against) throw new HttpError(400, "Query parameter `against` (version number) is required");
      const after = await loadVersion(db, req.params.id, versionNo(req.params.v));
      const before = await loadVersion(db, req.params.id, versionNo(against));
      if (!after.rulebook || !before.rulebook) throw new HttpError(409, "Both versions need an extracted rulebook to diff");
      return diffRulebooks(before.rulebook, after.rulebook);
    });

    app.patch<P>("/studies/:id/versions/:v/values", async (req) => {
      const body = parse(CorrectValueBody, req.body);
      const port = await getExtraction();
      return db.transaction(async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        assertDraft(row);
        const tokens = parsePointer(body.path);
        const rb = structuredClone(row.rulebook);
        const before = getAt(rb, tokens) ?? null;
        setAt(rb, tokens, body.value);
        markManual(rb, tokens);
        const checked = Rulebook.safeParse(rb);
        if (!checked.success) throw new HttpError(400, `Correction makes the rulebook invalid: ${z.prettifyError(checked.error)}`);
        const anomalies = recheck(port, checked.data, row.crossRead, row.anomalies);
        const editors = row.editors.includes(body.by) ? row.editors : [...row.editors, body.by];
        const [updated] = await tx
          .update(rulebookVersions)
          .set({ rulebook: checked.data, anomalies, editors, appliesFrom: appliesFromOf(checked.data), updatedAt: new Date() })
          .where(eq(rulebookVersions.id, row.id))
          .returning();
        await refreshStudyStatus(tx, row.studyId);
        await audit(tx, body.by, row.studyId, "value.corrected", { version: row.version, path: body.path, before, after: body.value, note: body.note });
        return versionDto(updated!);
      });
    });

    app.post<{ Params: { id: string; v: string; aid: string } }>("/studies/:id/versions/:v/anomalies/:aid/resolve", async (req) => {
      const body = parse(ResolveAnomalyBody, req.body);
      return db.transaction(async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        assertDraft(row);
        const target = row.anomalies.find((a) => a.id === req.params.aid);
        if (!target) throw new HttpError(404, `Anomaly ${req.params.aid} not found in version ${row.version}`);
        const resolution = { ...body, at: new Date().toISOString() };
        const anomalies = row.anomalies.map((a) => (a.id === target.id ? { ...a, resolution } : a));
        const [updated] = await tx.update(rulebookVersions).set({ anomalies, updatedAt: new Date() }).where(eq(rulebookVersions.id, row.id)).returning();
        await refreshStudyStatus(tx, row.studyId);
        await audit(tx, body.by, row.studyId, "anomaly.resolved", { version: row.version, anomalyId: target.id, code: target.code, kind: body.kind, note: body.note });
        return versionDto(updated!);
      });
    });

    app.post<P>("/studies/:id/versions/:v/grid-choice", async (req) => {
      const body = parse(ChooseGridBody, req.body);
      const port = await getExtraction();
      return db.transaction(async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        assertDraft(row);
        if (!row.rulebook.budgetGrids.some((g) => g.id === body.gridId)) throw new HttpError(400, `No budget grid with id "${body.gridId}"`);
        const rb = { ...structuredClone(row.rulebook), governingGridId: body.gridId };
        const at = new Date().toISOString();
        const anomalies = recheck(port, rb, row.crossRead, row.anomalies).map((a) =>
          a.code === "GRID_CONFLICT" && !a.resolution ? { ...a, resolution: { kind: "chosen" as const, note: body.note, by: body.by, at } } : a,
        );
        const [updated] = await tx.update(rulebookVersions).set({ rulebook: rb, anomalies, updatedAt: new Date() }).where(eq(rulebookVersions.id, row.id)).returning();
        await refreshStudyStatus(tx, row.studyId);
        await audit(tx, body.by, row.studyId, "grid.chosen", { version: row.version, gridId: body.gridId, from: row.rulebook.governingGridId, note: body.note });
        return versionDto(updated!);
      });
    });

    app.post<P>("/studies/:id/versions/:v/sign-off", async (req) => {
      const body = parse(SignOffBody, req.body);
      return db.transaction(async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        assertDraft(row);
        const open = row.anomalies.filter((a) => !a.resolution);
        if (open.length)
          throw new HttpError(409, `Cannot sign off: ${open.length} unresolved anomal${open.length === 1 ? "y" : "ies"} (${[...new Set(open.map((a) => a.code))].join(", ")})`);
        const [cfg] = await tx.select().from(settings).where(eq(settings.id, 1));
        if (cfg?.makerChecker && row.editors.includes(body.by))
          throw new HttpError(409, `Cannot sign off: maker-checker is on and ${body.by} corrected values in this version; someone else must sign`);
        // the previous live version stays live until this moment
        await tx
          .update(rulebookVersions)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(and(eq(rulebookVersions.studyId, row.studyId), eq(rulebookVersions.status, "signed")));
        const [updated] = await tx
          .update(rulebookVersions)
          .set({ status: "signed", signedBy: body.by, signedAt: new Date(), signNote: body.note ?? null, updatedAt: new Date() })
          .where(eq(rulebookVersions.id, row.id))
          .returning();
        await refreshStudyStatus(tx, row.studyId);
        await audit(tx, body.by, row.studyId, "version.signed", { version: row.version, note: body.note ?? null, appliesFrom: row.appliesFrom });
        return versionDto(updated!);
      });
    });
  };
