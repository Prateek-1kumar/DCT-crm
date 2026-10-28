import { Rulebook, upgradeRulebook } from "@dct/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { fromDrizzle, PgBoss } from "pg-boss";
import { config } from "./config.js";
import type { Db, Tx } from "./db/index.js";
import { documents, jobs, rulebookVersions, studies, studyDocuments } from "./db/schema.js";
import { appliesFromOf, audit, CARRIED, carryCorrections, carryGrid, correctionsOf, lockStudy, refreshStudyStatus } from "./domain.js";
import { getExtraction, type InputDoc } from "./extraction/port.js";
import { deleteExpiredKeys } from "./lib/idempotency.js";
import { reviewDraft } from "./review.js";

type IdentifyData = { jobId: string; studyId: string };
type ExtractData = { jobId: string; studyId: string; version: number };
type Kind = "identify" | "extract";
type JobCtx = { db: Db; log: FastifyBaseLogger };

/** A job pg-boss failed for good (its worker died, it ran out of time, its handler threw) lands here, and is failed here too. */
const STRANDED = "stranded";

/**
 * - identify is retried after a crash: it's cheap, and its handler writes once.
 * - extract is never retried, because each try pays for AI reads: a read whose server died is failed (`STRANDED`) and read
 *   again from the contract page, by a person who knows it costs. A read can take longer than pg-boss's default
 *   15 minutes, so it may run two hours.
 * - A worker heartbeats every 30 s; one that misses a minute of them is taken as dead, so its job is failed within a
 *   minute or two of a crash (pg-boss checks every minute) instead of sitting "running" until it expires.
 */
const QUEUES: Record<Kind, { retryLimit: number; retryDelay?: number; expireInSeconds: number }> = {
  identify: { retryLimit: 2, retryDelay: 5, expireInSeconds: 15 * 60 },
  extract: { retryLimit: 0, expireInSeconds: 2 * 60 * 60 },
};
const HEARTBEAT_SECONDS = 60;

export async function startBoss(ctx: JobCtx & { work: boolean; schemaBehind?: boolean }): Promise<PgBoss> {
  const { log } = ctx;
  const boss = new PgBoss({ connectionString: config.databaseUrl, useListenNotify: true, max: config.jobsDbMax, application_name: "dct-jobs" });
  boss.on("error", (err) => log.error({ err: err.message }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(STRANDED, { retryLimit: 5, retryDelay: 30 });
  for (const [name, opts] of Object.entries(QUEUES)) {
    const all = { ...opts, heartbeatSeconds: HEARTBEAT_SECONDS, deadLetter: STRANDED };
    await boss.createQueue(name, { notify: true, ...all });
    await boss.updateQueue(name, all); // createQueue leaves a queue that already exists as it was
  }
  await boss.createQueue("maintenance", { retryLimit: 0 });
  // No worker and no schedule on a database whose tables this build doesn't know yet: they would run jobs against them.
  // /readyz says the schema is behind; migrate, then restart.
  if (ctx.work && ctx.schemaBehind) ctx.log.error("jobs not started: the database is behind this build");
  if (ctx.work && !ctx.schemaBehind) {
    // jobs a crash left behind are failed before any job runs
    await maintain(ctx, boss);
    // A handler that throws gets a plain error (failure() logs the cause), never a database error's SQL and values: pg-boss
    // keeps what it threw, and it's copied into the stranded job.
    const run = <T>(fn: (data: T) => Promise<unknown>) => async ([job]: { data: T }[]) => {
      try {
        await fn(job!.data);
      } catch (err) {
        throw new Error(failure(err, log).detail ?? "job failed");
      }
    };
    // NOTIFY wakes a worker as soon as a job is sent, but it then takes one job per wake-up: without a short backstop
    // (pg-boss's default is 30 s) a backlog, as after a restart, would start a job every 30 seconds.
    const fast = { pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 1 };
    await boss.work<IdentifyData>("identify", fast, run((d) => runIdentify(ctx, d)));
    await boss.work<ExtractData>("extract", fast, run((d) => runExtract(ctx, d)));
    await boss.work(STRANDED, { ...fast, includeMetadata: true }, async ([job]) => recover(ctx, (job!.data as IdentifyData).jobId, job!.sourceOutput));
    await boss.work("maintenance", async () => maintain(ctx, boss));
    await boss.schedule("maintenance", "*/10 * * * *");
  }
  return boss;
}

/**
 * Our job row and its pg-boss job, in the caller's transaction: both commit or neither, so a job row is never left
 * "queued" with nothing to run it (as when the send came after the commit and the server stopped in between).
 */
export async function queueJob(tx: Tx, boss: PgBoss, kind: Kind, studyId: string, version: number | null) {
  const id = randomUUID();
  await tx.insert(jobs).values({ id, kind, studyId, version });
  await boss.send(kind, version === null ? { jobId: id, studyId } : { jobId: id, studyId, version }, { id, db: fromDrizzle(tx, sql) });
  return id;
}

/**
 * What made a reading weaker than usual, in plain words for the reviewer (the reading's own words go in the audit log for
 * the team). A failed or skipped re-read leaves a budget grid read once; a failed second reading leaves the first unchecked
 * by it; going over the cost limit is said too. Nothing is said for what's simply off by choice.
 */
export function plainWarnings(warnings: string[] = []): string[] {
  return [
    ...new Set(
      warnings.flatMap((w) => {
        const grid = /budget grid (\d+)/i.exec(w)?.[1];
        if (grid && /re-read .*failed|failed.*re-read|re-read was skipped/i.test(w))
          return [`Budget grid ${grid} was read only once: its second, closer reading ${/skipped/i.test(w) ? "was skipped to stay within the cost limit" : "failed"}. Check its numbers with extra care.`];
        if (/cross-read failed/i.test(w)) return ["The second, independent reading failed, so nothing compared the first reading against it."];
        if (/over the .* limit/i.test(w)) return ["This reading cost more than the usual limit. Tell the team."];
        return [];
      }),
    ),
  ];
}

/** What a failed job says on screen: its own message, never a database error's (the SQL and every value bound to it). */
const PLAIN = {
  database: "A database error stopped this. Try again; if it keeps happening, tell the team.",
  setup: "Reading isn't set up correctly on this computer. Tell the team; nothing was saved, so nothing is lost.",
  busy: "The reading service is busy right now. Wait a few minutes, then try again.",
  unreachable: "We couldn't reach the reading service. Check the internet connection, then try again.",
  incomplete: "The reading came back incomplete. Try again; if it fails again, type the contract in by hand.",
  pdf: "This PDF couldn't be read: it may be damaged, password-protected, or have a page that's too large. Upload a fresh copy, or type it in by hand.",
  other: "Something went wrong while reading. Try again; if it keeps happening, tell the team.",
};

/** A job that didn't finish because of the server, not the contract (recover). */
const STOPPED: Record<Kind, { stopped: string; timedOut: string }> = {
  extract: {
    stopped: "The server stopped while reading this contract, so the reading didn't finish. Read it again, or type it in by hand.",
    timedOut: "Reading this contract took more than two hours, so it was stopped. Read it again; if that happens again, type it in by hand.",
  },
  identify: {
    stopped: "The server stopped while reading the cover pages. Type the details in yourself.",
    timedOut: "Reading the cover pages took too long, so it was stopped. Type the details in yourself.",
  },
};

/**
 * Why a job failed: what a person reads (`error`: plain words, never SQL, values or internals) and the technical reason
 * for the team (`detail`). The reading's own limits are already written for people. A database error's message is the SQL
 * with every value bound to it, so the log gets the query and the detail only the error code.
 */
export function failure(err: unknown, log?: Pick<FastifyBaseLogger, "error">): { error: string; detail: string | null } {
  const e = (err instanceof Error ? err : new Error(String(err))) as Error & { query?: string; status?: unknown; cause?: { code?: string; message?: string } };
  if (e.query !== undefined) {
    log?.error({ code: e.cause?.code, cause: e.cause?.message ?? e.name, query: e.query }, "job failed");
    return { error: PLAIN.database, detail: `Database error${e.cause?.code ? ` ${e.cause.code}` : ""}` };
  }
  // by class name: the API reaches @dct/extraction only through the port, and the build doesn't minify
  const kind = e.constructor.name;
  if (kind === "ExtractionLimitError" || kind === "RenderTimeoutError") return { error: e.message.slice(0, 1000), detail: null };
  const status = typeof e.status === "number" ? e.status : null;
  const said = `${kind} ${e.name} ${e.message}`;
  const error =
    status === 401 || status === 403 || /api[_ ]key/i.test(said) ? PLAIN.setup
    : status === 429 || (status !== null && status >= 500) || /overloaded/i.test(said) ? PLAIN.busy
    : /connection|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(said) ? PLAIN.unreachable
    : /ZodError|LlmError|incomplete/i.test(said) ? PLAIN.incomplete
    : e instanceof RangeError || /cannot open|password|encrypt|damaged|corrupt|not a pdf|format error|pdf reader/i.test(said) ? PLAIN.pdf
    : PLAIN.other;
  return { error, detail: `${kind === "Error" ? "" : `${kind}: `}${e.message}`.slice(0, 1000) };
}

const LIVE = ["queued", "running"];
type JobRow = typeof jobs.$inferSelect;

/** The job's row, locked, while it's still queued or running; null once it has finished (or never existed). */
async function lockLive(tx: Tx, jobId: string): Promise<JobRow | null> {
  const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, jobId), inArray(jobs.state, LIVE))).for("update");
  return job ?? null;
}

const setJob = (tx: Tx, id: string, v: Partial<typeof jobs.$inferInsert>) => tx.update(jobs).set({ ...v, updatedAt: new Date() }).where(eq(jobs.id, id));

/**
 * Fails a job that's still live, and a read's version with it (its study status, the "couldn't read" alert and the audit
 * entry), all in one transaction. Locks study, then job, then version, as every write does. Does nothing to a job that
 * already finished: whichever of the job's own result and this commits first is the one that counts.
 */
async function failJob(db: Db, job: { id: string; kind: string; studyId: string | null; version: number | null }, error: string, detail: string | null) {
  await db.transaction(async (tx) => {
    if (job.studyId) await lockStudy(tx, job.studyId);
    if (!(await lockLive(tx, job.id))) return;
    await setJob(tx, job.id, { state: "failed", step: "failed", error, errorDetail: detail });
    if (job.kind === "extract" && job.studyId && job.version !== null) await failRead(tx, job.studyId, job.version, error, detail);
  });
}

/** A read's version that's still extracting → failed, with what it does to the study (the caller has locked the study). */
async function failRead(tx: Tx, studyId: string, version: number, error: string, detail: string | null) {
  const where = and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, version), eq(rulebookVersions.status, "extracting"));
  const failed = await tx.update(rulebookVersions).set({ status: "failed", error, updatedAt: new Date() }).where(where).returning({ id: rulebookVersions.id });
  if (!failed.length) return;
  await refreshStudyStatus(tx, studyId);
  await audit(tx, "system", studyId, "extraction.failed", { version, error, ...(detail ? { detail } : {}) });
}

async function studyInputDocs(db: Tx, studyId: string): Promise<InputDoc[]> {
  const rows = await db
    .select({ id: documents.id, filename: documents.filename, path: documents.storagePath, kind: documents.kind })
    .from(studyDocuments)
    .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
    .where(eq(studyDocuments.studyId, studyId))
    .orderBy(studyDocuments.addedAt, documents.filename);
  return rows.map((r) => ({ ...r, kind: r.kind as InputDoc["kind"] }));
}

export async function runIdentify({ db, log }: JobCtx, { jobId, studyId }: IdentifyData) {
  // Claimed again after a crash (still "running"): identify is cheap, and only one run writes (below).
  const claimed = await db
    .update(jobs)
    .set({ state: "running", progress: 10, step: "identifying documents", updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.state, LIVE)))
    .returning({ id: jobs.id });
  if (!claimed.length) return;
  try {
    const port = await getExtraction();
    const docs = await studyInputDocs(db, studyId);
    const { documentKinds, studyGuess } = await port.identifyDocuments(docs);
    await db.transaction(async (tx) => {
      // read under the study's lock, so details someone confirmed even a moment ago are never overwritten by a guess
      const s = await lockStudy(tx, studyId);
      if (!(await lockLive(tx, jobId))) return; // another run of this job got there first
      for (const d of docs) {
        const kind = documentKinds[d.id];
        if (kind) await tx.update(documents).set({ kind }).where(eq(documents.id, d.id));
      }
      await tx
        .update(studies)
        .set({
          sponsor: s.sponsor ?? studyGuess.sponsor,
          protocol: s.protocol ?? studyGuess.protocol,
          siteName: s.siteName ?? studyGuess.siteName,
          investigator: s.investigator ?? studyGuess.investigator,
          updatedAt: new Date(),
        })
        .where(eq(studies.id, studyId));
      await audit(tx, "system", studyId, "study.identified", { documentKinds, studyGuess });
      await setJob(tx, jobId, { state: "succeeded", progress: 100, step: "done" });
    });
  } catch (err) {
    const { error, detail } = failure(err, log);
    await failJob(db, { id: jobId, kind: "identify", studyId, version: null }, error, detail);
  }
}

export async function runExtract({ db, log }: JobCtx, { jobId, studyId, version }: ExtractData) {
  // Claimed once: a read never runs twice, since each run pays for AI calls. A job that isn't queued any more is already
  // running (a duplicate delivery), finished, or was stopped.
  const claimed = await db
    .update(jobs)
    .set({ state: "running", progress: 1, step: "starting", updatedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.state, "queued")))
    .returning({ id: jobs.id });
  if (!claimed.length) return;
  const job = { id: jobId, kind: "extract", studyId, version };
  const where = and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, version), eq(rulebookVersions.status, "extracting"));
  let progress: Promise<unknown> = Promise.resolve();
  try {
    const [v] = await db.select({ id: rulebookVersions.id }).from(rulebookVersions).where(where);
    if (!v) throw new Error(`version ${version} is no longer being read`);
    const port = await getExtraction();
    const docs = await studyInputDocs(db, studyId);
    const out = await port.extractStudy({
      documents: docs,
      onProgress: (pct, step) => {
        progress = progress
          .then(() => db.update(jobs).set({ progress: Math.max(1, Math.min(99, Math.round(pct))), step, updatedAt: new Date() }).where(and(eq(jobs.id, jobId), eq(jobs.state, "running"))))
          .catch(() => {});
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
      const liveRb = upgradeRulebook(live.rulebook);
      const values = carryCorrections(rulebook, await correctionsOf(db, live));
      const grids = carryGrid(values.rulebook, liveRb);
      rulebook = { ...values.rulebook, governingGridIds: grids };
      carriedDetail = { version, from: live.version, carried: values.carried, skipped: values.skipped, grid: { from: liveRb.governingGridIds.length ? liveRb.governingGridIds : [liveRb.governingGridId].filter(Boolean), to: grids } };
    }
    const anomalies = port.runContractChecks(rulebook, { crossRead, pages: out.pages, notes });
    // Every value checked against the PDF's own text, and what's left for a person (ADR-001). No AI.
    const textByDoc = await Promise.all(docs.map((d) => port.readTextLayer(d.path, d.id)));
    const { evidence, review, pdfCheck } = reviewDraft(port, rulebook, anomalies, textByDoc.flat(), docs);
    const sum = (k: "usd" | "inputTokens" | "outputTokens") => out.cost.reduce((n, c) => n + c[k], 0);
    // All or nothing: the version, the study's status and needs-you count, its alert, the audit entries and the job.
    await db.transaction(async (tx) => {
      await lockStudy(tx, studyId);
      if (!(await lockLive(tx, jobId))) return; // stopped meanwhile (recover): the read is dropped, the version stays failed
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
          warnings: plainWarnings(out.warnings),
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
      if (!filled.length) throw new Error(`version ${version} is no longer being read`);
      await refreshStudyStatus(tx, studyId);
      if (carriedDetail) await audit(tx, "system", studyId, CARRIED, carriedDetail);
      await audit(tx, "system", studyId, "extraction.completed", { version, anomalies: anomalies.length, questions: review.length, pdfCheck, costUsd: sum("usd"), ...(out.warnings?.length ? { warnings: out.warnings } : {}) });
      await setJob(tx, jobId, { state: "succeeded", progress: 100, step: "done", error: null, errorDetail: null });
    });
  } catch (err) {
    await progress;
    const { error, detail } = failure(err, log);
    await failJob(db, job, error, detail);
  }
}

/**
 * A job pg-boss failed without our handler finishing it (via the stranded queue, `output` its reason): marked failed with
 * plain words. pg-boss's own reasons ("job timed out", "job heartbeat timeout") or the handler's plain error go in the
 * detail; nothing else is copied from pg-boss.
 */
export async function recover({ db }: JobCtx, jobId: string, output?: object | null) {
  const [job] = await db.select().from(jobs).where(and(eq(jobs.id, jobId), inArray(jobs.state, LIVE)));
  if (!job) return;
  const o = output as { message?: unknown; value?: { message?: unknown } } | null | undefined;
  const said = String(o?.value?.message ?? o?.message ?? "the job stopped").slice(0, 300);
  const words = STOPPED[job.kind as Kind] ?? STOPPED.extract;
  await failJob(db, job, said === "job timed out" ? words.timedOut : words.stopped, `pg-boss: ${said}`);
}

/**
 * Nothing stays "running" for ever: every 10 minutes and at startup, a live job whose pg-boss job has ended or is gone is
 * failed (pg-boss fails a crashed or overdue one into the stranded queue, so this is the backstop: a stranded job that
 * couldn't be handled, or a job from before jobs were queued in one transaction), and so is a read left with no job at all.
 * Also deletes idempotency keys past their time.
 */
export async function maintain(ctx: JobCtx, boss: PgBoss) {
  const { db, log } = ctx;
  await deleteExpiredKeys(db);
  for (const job of await db.select().from(jobs).where(inArray(jobs.state, LIVE))) {
    const [queued] = await boss.findJobs(job.kind, { id: job.id });
    if (queued && ["created", "retry", "active"].includes(queued.state)) continue; // pg-boss runs it, or fails it into stranded
    log.warn({ job: job.kind }, "a job had ended without finishing; marked failed");
    await recover(ctx, job.id, { message: queued ? `job ${queued.state}` : "the queued job is missing" });
  }
  const orphans = await db.execute<{ studyId: string; version: number }>(sql`
    SELECT v.study_id AS "studyId", v.version FROM rulebook_versions v
    WHERE v.status = 'extracting' AND NOT EXISTS (
      SELECT 1 FROM jobs j WHERE j.study_id = v.study_id AND j.version = v.version AND j.kind = 'extract' AND j.state IN ('queued', 'running'))`);
  for (const { studyId, version } of orphans.rows) {
    log.warn("a read had no job; marked failed");
    await db.transaction(async (tx) => {
      await lockStudy(tx, studyId);
      await failRead(tx, studyId, version, STOPPED.extract.stopped, "no job was reading this version");
    });
  }
}
