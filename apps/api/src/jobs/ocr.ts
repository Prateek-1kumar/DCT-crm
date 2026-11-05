import { ocrPages, pdfReader, withOcr } from "@dct/harness";
import { and, eq, inArray } from "drizzle-orm";
import type { Job } from "pg-boss";
import type { Ctx } from "../app.js";
import { documents } from "../db/schema.js";
import { forgetStored, pageInfos } from "../lib/docs.js";
import { pdfPath, readOcr, saveOcr } from "../lib/storage.js";

export type Ocr = typeof ocrPages;

export const OCR_QUEUE = "ocr";
const RETRIES = 2;
/** OCR is free, so the queue retries it. A dead worker's job is failed by its missed heartbeat and retried; the long expiry only bounds a hung page. */
const OCR_JOB = { retryLimit: RETRIES, heartbeatSeconds: 30, expireInSeconds: 4 * 3600 };

export const OCR_FAILED = "The scanned pages couldn't be read. Upload the file again to try once more, or upload a clearer scan.";

export async function queueOcr({ db, boss }: Ctx, documentId: string) {
  await db.update(documents).set({ ocrStatus: "queued", ocrPagesDone: 0, ocrError: null }).where(eq(documents.id, documentId));
  // the queue's "exclusive" policy keeps one job per document: sending again while one is queued or running does nothing
  await boss.send(OCR_QUEUE, { documentId }, { ...OCR_JOB, singletonKey: documentId });
}

async function runOcr({ db, log, ocr }: Ctx, job: Job<{ documentId: string }>) {
  const { documentId } = job.data;
  const [doc] = await db
    .update(documents)
    .set({ ocrStatus: "running", ocrPagesDone: 0, ocrError: null })
    .where(and(eq(documents.id, documentId), inArray(documents.ocrStatus, ["queued", "running"])))
    .returning();
  if (!doc) return;

  let saved = Promise.resolve();
  const onPage = (done: number) => {
    saved = saved.then(() => db.update(documents).set({ ocrPagesDone: done }).where(eq(documents.id, documentId))).then(
      () => undefined,
      (err: Error) => log.error({ err: err.name }, "couldn't save OCR progress"),
    );
  };

  try {
    // not loadStored: that would apply a saved result, and this run is making a new one
    const loaded = await pdfReader.load(pdfPath(doc.sha256));
    const pages = await ocr(loaded, { onPage });
    await saveOcr(doc.sha256, pages);
    await saved;
    await db.update(documents).set({ pages: pageInfos(withOcr(loaded, pages)), ocrStatus: "done", ocrPagesDone: pages.length }).where(eq(documents.id, documentId));
    forgetStored(doc.sha256);
  } catch (err) {
    await saved;
    // the name only: an error's message can carry contract text
    log.error({ err: err instanceof Error ? err.name : "unknown", attempt: job.retryCount + 1 }, "OCR failed");
    if (job.retryCount >= RETRIES) await db.update(documents).set({ ocrStatus: "failed", ocrError: OCR_FAILED }).where(eq(documents.id, documentId));
    throw err;
  }
}

/** A restart can lose a queued job, or leave a scan from before OCR existed, or one an older OCR made; queue them all again. */
async function recoverOcr(ctx: Ctx) {
  for (const d of await ctx.db.select({ id: documents.id, sha256: documents.sha256, status: documents.ocrStatus, pages: documents.pages }).from(documents)) {
    const lost = d.status === "queued" || d.status === "running";
    const unread = d.status === "none" && d.pages.some((p) => p.kind === "image");
    const outdated = d.status === "done" && d.pages.some((p) => p.kind === "ocr") && !(await readOcr(d.sha256));
    if (lost || unread || outdated) await queueOcr(ctx, d.id);
  }
}

export async function startOcrJob(ctx: Ctx) {
  await ctx.boss.createQueue(OCR_QUEUE, { policy: "exclusive" });
  await recoverOcr(ctx);
  await ctx.boss.work<{ documentId: string }>(OCR_QUEUE, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async ([job]) => runOcr(ctx, job!));
}
