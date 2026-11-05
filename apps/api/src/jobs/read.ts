import { ReadFailed, read } from "@dct/harness";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Ctx } from "../app.js";
import type { Db } from "../db/index.js";
import { reads, versions } from "../db/schema.js";
import { loadDocs } from "../lib/docs.js";
import { HttpError } from "../lib/http.js";
import { fillStudy } from "../lib/parties.js";

export const READ_QUEUE = "read";
/** A paid read is never retried by the queue, and may run far longer than pg-boss's 15 minute default before it counts as lost. */
export const READ_JOB = { retryLimit: 0, expireInSeconds: 4 * 3600 };

type ReadRef = { id: string; versionId: string };

const COMPILED = new Set(["done", "finishes_exhausted"]);
const usd = (n: number) => `$${n.toFixed(2)}`;
const whyStopped = (reason: string, budget: number) =>
  ({
    budget: `The read reached its spending limit of ${usd(budget)} before it finished, so nothing was kept. Start it again to try once more.`,
    max_turns: "The model went through too many steps without finishing, so nothing was kept. Start the read again.",
    refusal: "The model declined to read this contract, so nothing was kept.",
    max_tokens: "The model ran out of room before finishing this contract, so nothing was kept.",
    model_context_window_exceeded: "This contract is too long for the model to read in one go, so nothing was kept.",
    error: "The model stopped answering part way through, so nothing was kept. Start the read again.",
  })[reason] ?? "The read stopped before it finished, so nothing was kept. Start the read again.";

const GENERIC = "The read stopped because of a problem on the server. Start it again; if it keeps happening, tell the team.";
const SERVER_STOPPED = "The server stopped while this contract was being read. Start the read again.";
const NEVER_STARTED = "This read never got started. Start the read again.";


export async function markFailed(db: Db, { id, versionId }: ReadRef, error: string, extra: { spentUsd?: number; trace?: unknown } = {}) {
  await db.transaction(async (tx) => {
    await tx.update(reads).set({ status: "failed", error, finishedAt: new Date(), ...extra }).where(eq(reads.id, id));
    await tx.update(versions).set({ status: "failed" }).where(eq(versions.id, versionId));
  });
}

async function runRead({ db, log, models }: Ctx, readId: string) {
  const [row] = await db.update(reads).set({ status: "running", startedAt: new Date() }).where(and(eq(reads.id, readId), eq(reads.status, "queued"))).returning();
  if (!row) return;
  const ref = { id: row.id, versionId: row.versionId };

  // one append at a time, so lines land in the order they were said
  let appended = Promise.resolve();
  const say = (line: string) => {
    appended = appended
      .then(() => db.update(reads).set({ progress: sql`${reads.progress} || ${JSON.stringify([line])}::jsonb` }).where(eq(reads.id, readId)))
      .then(
        () => undefined,
        (err: Error) => log.error({ err: err.name }, "couldn't save a progress line"),
      );
  };

  try {
    const [version] = await db.select({ studyId: versions.studyId, documentIds: versions.documentIds }).from(versions).where(eq(versions.id, row.versionId));
    const docs = await loadDocs(db, version!.documentIds);
    const result = await read(docs, { ...models(), maxUsd: row.budgetUsd, onProgress: say });
    await appended;

    const trace = { compile: result.compiled?.trace ?? null, log: result.log };
    const stopped = result.compiled && !COMPILED.has(result.compiled.stopReason) ? result.compiled : undefined;
    if (stopped) {
      // the reason only: a provider's error text can echo what was sent; the detail stays in the read's trace
      log.warn({ reason: stopped.stopReason }, "a read stopped early");
      await markFailed(db, ref, whyStopped(stopped.stopReason, row.budgetUsd), { spentUsd: result.usd, trace });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.update(versions).set({ rulebook: result.rulebook, problems: result.report.problems, status: "draft" }).where(eq(versions.id, row.versionId));
      await fillStudy(tx, version!.studyId, result.rulebook.study);
      await tx.update(reads).set({ status: "done", spentUsd: result.usd, finishedAt: new Date(), trace }).where(eq(reads.id, readId));
    });
  } catch (err) {
    await appended;
    // never the cause's message in the log: a database or SDK error can carry contract text
    const cause = err instanceof ReadFailed ? err.cause : err;
    log.error({ err: cause instanceof Error ? cause.name : "unknown", code: (cause as { cause?: { code?: string } } | undefined)?.cause?.code }, "read failed");
    if (err instanceof ReadFailed) await markFailed(db, ref, err.message, { spentUsd: err.usd });
    else await markFailed(db, ref, err instanceof HttpError ? err.message : GENERIC);
  }
}

/** A read the dead process left running is over; a queued one whose job is gone would never start. */
async function recoverReads({ db, boss }: Ctx) {
  for (const r of await db.select({ id: reads.id, versionId: reads.versionId, status: reads.status }).from(reads).where(inArray(reads.status, ["queued", "running"]))) {
    if (r.status === "queued" && (await boss.findJobs(READ_QUEUE, { data: { readId: r.id }, queued: true })).length) continue;
    await markFailed(db, r, r.status === "running" ? SERVER_STOPPED : NEVER_STARTED);
  }
}

export async function startReadJob(ctx: Ctx) {
  await ctx.boss.createQueue(READ_QUEUE);
  await recoverReads(ctx);
  await ctx.boss.work<{ readId: string }>(READ_QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => runRead(ctx, job!.data.readId));
}
