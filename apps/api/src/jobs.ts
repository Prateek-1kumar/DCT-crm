import { Rulebook } from "@dct/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import type { Db, Tx } from "./db/index.js";
import { documents, jobs, rulebookVersions, studies, studyDocuments } from "./db/schema.js";
import { appliesFromOf, audit, CARRIED, carryCorrections, carryGrid, correctionsOf, refreshStudyStatus } from "./domain.js";
import { getExtraction, type InputDoc } from "./extraction/port.js";
import { reviewDraft } from "./review.js";

export type IdentifyData = { jobId: string; studyId: string };
export type ExtractData = { jobId: string; studyId: string; version: number };
const QUEUES = ["identify", "extract"] as const;

export async function startBoss(opts: { work: boolean; db: Db; databaseUrl?: string }): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: opts.databaseUrl ?? config.databaseUrl, useListenNotify: true });
  boss.on("error", (err) => console.error("pg-boss:", err.message));
  await boss.start();
  // identify: retried after a crash (handlers are idempotent; it's a cheap call). extract: never retried, because each
  // try pays for AI reads; a crashed one is read again from the contract page (POST /extract reuses its version).
  // A read can take longer than pg-boss's default 15 minutes, so it may run for two hours.
  await boss.createQueue("identify", { notify: true, retryLimit: 2 });
  const extract = { retryLimit: 0, expireInSeconds: 2 * 60 * 60 };
  await boss.createQueue("extract", { notify: true, ...extract });
  await boss.updateQueue("extract", extract); // createQueue leaves a queue that already exists as it was
  if (opts.work) {
    await boss.work<IdentifyData>("identify", { pollingIntervalSeconds: 0.5 }, async ([job]) => runIdentify(opts.db, job!.data));
    await boss.work<ExtractData>("extract", { pollingIntervalSeconds: 0.5 }, async ([job]) => runExtract(opts.db, job!.data));
  }
  return boss;
}

/** Insert our job row (inside the caller's transaction). Send to pg-boss after commit with `sendJob`. */
export async function createJob(tx: Tx, kind: (typeof QUEUES)[number], studyId: string, version: number | null) {
  const id = randomUUID();
  await tx.insert(jobs).values({ id, kind, studyId, version });
  return id;
}

/** Same id twice is a no-op in pg-boss, so re-sending is a safe repair. */
export async function sendJob(boss: PgBoss, kind: (typeof QUEUES)[number], data: IdentifyData | ExtractData) {
  await boss.send(kind, data, { id: data.jobId });
}

/** What a failed job says on screen: its own message, never a database error's (the SQL and every value bound to it). */
const failure = (err: unknown) => {
  const e = err as Error & { query?: string };
  if (e.query !== undefined) {
    console.error("job failed:", (e.cause as Error | undefined)?.message ?? e.name, "in:", e.query);
    return "A database error stopped this. Try again; if it keeps happening, tell the team.";
  }
  return (e.message ?? String(err)).slice(0, 1000);
};

const setJob = (db: Tx, id: string, v: Partial<typeof jobs.$inferInsert>) => db.update(jobs).set({ ...v, updatedAt: new Date() }).where(eq(jobs.id, id));

async function studyInputDocs(db: Tx, studyId: string): Promise<InputDoc[]> {
  const rows = await db
    .select({ id: documents.id, filename: documents.filename, path: documents.storagePath, kind: documents.kind })
    .from(studyDocuments)
    .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
    .where(eq(studyDocuments.studyId, studyId))
    .orderBy(studyDocuments.addedAt, documents.filename);
  return rows.map((r) => ({ ...r, kind: r.kind as InputDoc["kind"] }));
}

export async function runIdentify(db: Db, { jobId, studyId }: IdentifyData) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || job.state === "succeeded" || job.state === "failed") return;
  await setJob(db, jobId, { state: "running", progress: 10, step: "identifying documents" });
  try {
    const port = await getExtraction();
    const docs = await studyInputDocs(db, studyId);
    const { documentKinds, studyGuess } = await port.identifyDocuments(docs);
    await db.transaction(async (tx) => {
      for (const d of docs) {
        const kind = documentKinds[d.id];
        if (kind) await tx.update(documents).set({ kind }).where(eq(documents.id, d.id));
      }
      const [s] = await tx.select().from(studies).where(eq(studies.id, studyId));
      // a guess never overwrites details someone already confirmed
      await tx
        .update(studies)
        .set({
          sponsor: s?.sponsor ?? studyGuess.sponsor,
          protocol: s?.protocol ?? studyGuess.protocol,
          siteName: s?.siteName ?? studyGuess.siteName,
          investigator: s?.investigator ?? studyGuess.investigator,
          updatedAt: new Date(),
        })
        .where(eq(studies.id, studyId));
      await audit(tx, "system", studyId, "study.identified", { documentKinds, studyGuess });
      await setJob(tx, jobId, { state: "succeeded", progress: 100, step: "done" });
    });
  } catch (err) {
    await setJob(db, jobId, { state: "failed", step: "failed", error: failure(err) });
  }
}

export async function runExtract(db: Db, { jobId, studyId, version }: ExtractData) {
  const where = and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, version), eq(rulebookVersions.status, "extracting"));
  const [v] = await db.select().from(rulebookVersions).where(where);
  if (!v) return; // already filled or failed: redelivery is a no-op
  await setJob(db, jobId, { state: "running", progress: 1, step: "starting" });
  let progress: Promise<unknown> = Promise.resolve();
  try {
    const port = await getExtraction();
    const docs = await studyInputDocs(db, studyId);
    const out = await port.extractStudy({
      documents: docs,
      onProgress: (pct, step) => {
        progress = progress.then(() => setJob(db, jobId, { progress: Math.max(1, Math.min(99, Math.round(pct))), step })).catch(() => {});
      },
    });
    await progress;
    let rulebook = Rulebook.parse(out.rulebook);
    const crossRead = out.crossRead ? Rulebook.parse(out.crossRead) : null;
    const notes = out.notes ?? [];
    // amendment: the new read starts from the AI's values; carry the live version's corrections forward
    const [live] = await db.select().from(rulebookVersions).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.status, "signed")));
    let carriedDetail: Record<string, unknown> | null = null;
    if (live?.rulebook) {
      const values = carryCorrections(rulebook, await correctionsOf(db, live));
      const gridId = carryGrid(values.rulebook, live.rulebook);
      rulebook = gridId ? { ...values.rulebook, governingGridId: gridId } : values.rulebook;
      carriedDetail = { version, from: live.version, carried: values.carried, skipped: values.skipped, grid: { from: live.rulebook.governingGridId, to: gridId } };
    }
    const anomalies = port.runContractChecks(rulebook, { crossRead, pages: out.pages, notes });
    // Every value checked against the PDF's own text, and what's left for a person (ADR-001). No AI.
    const textByDoc = await Promise.all(docs.map((d) => port.readTextLayer(d.path, d.id)));
    const { evidence, review, pdfCheck } = reviewDraft(port, rulebook, anomalies, textByDoc.flat(), docs);
    const sum = (k: "usd" | "inputTokens" | "outputTokens") => out.cost.reduce((n, c) => n + c[k], 0);
    await db.transaction(async (tx) => {
      // all-or-nothing: the version is filled in one statement, only if still extracting
      const filled = await tx
        .update(rulebookVersions)
        .set({
          status: "draft",
          rulebook,
          crossRead,
          anomalies,
          evidence,
          review,
          pdfCheck,
          pages: out.pages,
          notes,
          cost: out.cost,
          costUsd: sum("usd"),
          inputTokens: sum("inputTokens"),
          outputTokens: sum("outputTokens"),
          appliesFrom: appliesFromOf(rulebook),
          error: null,
          updatedAt: new Date(),
        })
        .where(where)
        .returning({ id: rulebookVersions.id });
      if (!filled.length) return;
      await refreshStudyStatus(tx, studyId);
      if (carriedDetail) await audit(tx, "system", studyId, CARRIED, carriedDetail);
      await audit(tx, "system", studyId, "extraction.completed", { version, anomalies: anomalies.length, questions: review.length, pdfCheck, costUsd: sum("usd") });
      await setJob(tx, jobId, { state: "succeeded", progress: 100, step: "done", error: null });
    });
  } catch (err) {
    await progress;
    const error = failure(err);
    await db.transaction(async (tx) => {
      await tx.update(rulebookVersions).set({ status: "failed", error, updatedAt: new Date() }).where(where);
      await refreshStudyStatus(tx, studyId);
      await audit(tx, "system", studyId, "extraction.failed", { version, error });
      await setJob(tx, jobId, { state: "failed", step: "failed", error });
    });
  }
}
