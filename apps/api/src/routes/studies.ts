import { ConfirmStudyBody, CreateStudyBody, ExtractBody, type JobDto, type StudyDetailDto } from "@dct/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { documents, jobs, rulebookVersions, studies, studyDocuments } from "../db/schema.js";
import { audit, documentDto, refreshStudyStatus, studySummaryDto, versionSummaryDto } from "../domain.js";
import { createJob, sendJob } from "../jobs.js";
import { HttpError, notFound, parse } from "../lib/http.js";

/**
 * Not in @dct/shared yet (proposed as `ExtractBody`): an amendment adds documents to an existing
 * study, and `by` names who started it. Both optional, so an empty body still works.
 */

export const studyRoutes =
  ({ db, boss }: Ctx): FastifyPluginAsync =>
  async (app) => {
    async function assertDocsExist(ids: string[]) {
      const found = await db.select({ id: documents.id }).from(documents).where(inArray(documents.id, ids));
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new HttpError(400, `Unknown document ids: ${missing.join(", ")}`);
    }

    app.post("/studies", async (req, reply) => {
      const body = parse(CreateStudyBody, req.body);
      const ids = [...new Set(body.documentIds)];
      await assertDocsExist(ids);
      const { studyId, jobId } = await db.transaction(async (tx) => {
        const [study] = await tx.insert(studies).values({}).returning();
        await tx.insert(studyDocuments).values(ids.map((documentId) => ({ studyId: study!.id, documentId })));
        await audit(tx, body.by ?? "system", study!.id, "study.created", { documentIds: ids });
        return { studyId: study!.id, jobId: await createJob(tx, "identify", study!.id, null) };
      });
      await sendJob(boss, "identify", { jobId, studyId });
      return reply.status(201).send({ studyId, jobId });
    });

    app.get("/studies", async () => {
      const all = await db.select().from(studies).orderBy(asc(studies.createdAt));
      const versions = await db.select().from(rulebookVersions).orderBy(desc(rulebookVersions.version));
      return all.map((s) => studySummaryDto(s, versions.filter((v) => v.studyId === s.id)));
    });

    async function detail(id: string): Promise<StudyDetailDto> {
      const [s] = await db.select().from(studies).where(eq(studies.id, id));
      if (!s) throw notFound("Study");
      const versions = await db.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, id)).orderBy(desc(rulebookVersions.version));
      const docs = await db
        .select({ d: documents })
        .from(studyDocuments)
        .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
        .where(eq(studyDocuments.studyId, id))
        .orderBy(studyDocuments.addedAt, documents.filename);
      return { ...studySummaryDto(s, versions), documents: docs.map((r) => documentDto(r.d)), versions: versions.map(versionSummaryDto) };
    }

    app.get<{ Params: { id: string } }>("/studies/:id", async (req) => detail(req.params.id));

    app.patch<{ Params: { id: string } }>("/studies/:id", async (req) => {
      const { by, ...fields } = parse(ConfirmStudyBody, req.body);
      await db.transaction(async (tx) => {
        const [s] = await tx.select().from(studies).where(eq(studies.id, req.params.id)).for("update");
        if (!s) throw notFound("Study");
        await tx.update(studies).set({ ...fields, updatedAt: new Date() }).where(eq(studies.id, s.id));
        const before = { sponsor: s.sponsor, protocol: s.protocol, siteName: s.siteName, investigator: s.investigator };
        await audit(tx, by, s.id, "study.confirmed", { before, after: fields });
      });
      return detail(req.params.id);
    });

    app.post<{ Params: { id: string } }>("/studies/:id/extract", async (req, reply) => {
      const body = parse(ExtractBody, req.body ?? {});
      const studyId = req.params.id;
      const newDocs = [...new Set(body.documentIds ?? [])];
      if (newDocs.length) await assertDocsExist(newDocs);
      const res = await db.transaction(async (tx) => {
        const [s] = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update"); // serialises version creation
        if (!s) throw notFound("Study");
        if (newDocs.length) await tx.insert(studyDocuments).values(newDocs.map((documentId) => ({ studyId, documentId }))).onConflictDoNothing();
        const [latest] = await tx.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, studyId)).orderBy(desc(rulebookVersions.version)).limit(1);

        if (latest?.status === "extracting") {
          // already running: idempotent, hand back the same job
          const [job] = await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.studyId, studyId), eq(jobs.version, latest.version), eq(jobs.kind, "extract")))
            .orderBy(desc(jobs.createdAt))
            .limit(1);
          if (job) return { jobId: job.id, version: latest.version };
        }
        if (latest?.status === "draft") throw new HttpError(409, `Version ${latest.version} is a draft under review; sign it off before extracting again`);

        let version: number;
        if (latest && (latest.status === "failed" || latest.status === "extracting")) {
          // retry reuses the same version row: never a duplicate version
          version = latest.version;
          await tx.update(rulebookVersions).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(rulebookVersions.id, latest.id));
        } else {
          version = (latest?.version ?? 0) + 1;
          await tx.insert(rulebookVersions).values({ studyId, version, status: "extracting" });
        }
        await refreshStudyStatus(tx, studyId);
        const jobId = await createJob(tx, "extract", studyId, version);
        await audit(tx, body.by ?? "system", studyId, "extraction.queued", { version, jobId, addedDocumentIds: newDocs });
        return { jobId, version };
      });
      await sendJob(boss, "extract", { jobId: res.jobId, studyId, version: res.version });
      return reply.status(202).send({ jobId: res.jobId, version: res.version });
    });

    app.get<{ Params: { id: string } }>("/jobs/:id", async (req): Promise<JobDto> => {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, req.params.id));
      if (!job) throw notFound("Job");
      return { id: job.id, state: job.state as JobDto["state"], progress: job.progress, step: job.step, error: job.error };
    });
  };
