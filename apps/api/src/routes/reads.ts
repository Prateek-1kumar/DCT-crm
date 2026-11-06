import { SCAN_PAGE_USD, untranscribed } from "@dct/harness";
import { asc, eq, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { config } from "../config.js";
import { documents, reads, studies, studyDocuments, versions } from "../db/schema.js";
import { markFailed, READ_JOB, READ_QUEUE } from "../jobs/read.js";
import { audit } from "../lib/audit.js";
import { By } from "../lib/by.js";
import { loadDocs } from "../lib/docs.js";
import { HttpError } from "../lib/http.js";
import { parse } from "../lib/parse.js";
import { scanStore } from "../lib/storage.js";

const StartBody = z.object({ by: By });
const NOT_STARTED = "The read couldn't be started. Try again; if it keeps happening, tell the team.";

export async function readsRoutes(api: FastifyInstance, { db, boss, log, models }: Ctx) {
  api.post<{ Params: { id: string } }>("/studies/:id/reads", async (req, reply) => {
    const { by } = parse(StartBody, req.body);
    const studyId = req.params.id;

    const [study] = await db.select({ id: studies.id }).from(studies).where(eq(studies.id, studyId));
    if (!study) throw new HttpError(404, "There is no such study.");
    const docs = await db
      .select({ id: documents.id })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .where(eq(studyDocuments.studyId, studyId))
      .orderBy(asc(studyDocuments.addedAt), asc(documents.name));
    if (!docs.length) throw new HttpError(409, "Upload the contract first.");
    const { openai } = models();
    const scans = await untranscribed(await loadDocs(db, docs.map((d) => d.id), openai), scanStore, openai);
    const budgetUsd = Math.min(Math.round((config.readBudgetUsd + SCAN_PAGE_USD * scans) * 100) / 100, config.readBudgetMaxUsd);

    const started = await db
      .transaction(async (tx) => {
        const [{ latest }] = await tx.select({ latest: max(versions.number) }).from(versions).where(eq(versions.studyId, studyId)) as [{ latest: number | null }];
        const [version] = await tx
          .insert(versions)
          .values({ studyId, number: (latest ?? 0) + 1, status: "reading", documentIds: docs.map((d) => d.id), createdBy: by })
          .returning();
        const [read] = await tx.insert(reads).values({ versionId: version!.id, budgetUsd }).returning();
        await audit(tx, { by, action: "read.started", entity: "read", entityId: read!.id, detail: { studyId, versionId: version!.id, number: version!.number, budgetUsd: read!.budgetUsd } });
        return { readId: read!.id, versionId: version!.id };
      })
      .catch((err: { cause?: { code?: string } }) => {
        if (err.cause?.code === "23505") throw new HttpError(409, "This contract is already being read.");
        throw err;
      });

    try {
      if (!(await boss.send(READ_QUEUE, { readId: started.readId }, READ_JOB))) throw new Error("the queue took no job");
    } catch (err) {
      log.error({ err: err instanceof Error ? err.name : "unknown" }, "couldn't queue a read");
      await markFailed(db, { id: started.readId, versionId: started.versionId }, NOT_STARTED);
      throw new HttpError(503, NOT_STARTED);
    }
    return reply.status(202).send(started);
  });

  api.get<{ Params: { id: string } }>("/reads/:id", async (req) => {
    const [read] = await db
      .select({
        id: reads.id,
        versionId: reads.versionId,
        status: reads.status,
        budgetUsd: reads.budgetUsd,
        spentUsd: reads.spentUsd,
        progress: reads.progress,
        error: reads.error,
        createdAt: reads.createdAt,
        startedAt: reads.startedAt,
        finishedAt: reads.finishedAt,
      })
      .from(reads)
      .where(eq(reads.id, req.params.id));
    if (!read) throw new HttpError(404, "There is no such read.");
    return read;
  });
}
