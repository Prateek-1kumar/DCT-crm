import type { AlertPage, DocumentDto, JobDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { maintain, recover, runExtract, runIdentify } from "../src/jobs.js";
import { type Built, makeTextPdf, resetDb, storedVersion, testApp, upload, waitJob } from "./helpers.js";

// Jobs run twice write once, and a job whose server died is found and failed in plain words, never left "running".
// `idle` has no workers, so these tests run (or strand) its jobs themselves; `live` (started when a test needs it) runs
// them, as the server does.

let idle: Built;
beforeAll(async () => {
  idle = await testApp({ workers: false });
});
afterAll(() => idle.app.close());
async function withWorkers(fn: (live: Built) => Promise<void>) {
  const live = await testApp();
  try {
    await fn(live);
  } finally {
    await live.app.close();
  }
}
beforeEach(async () => {
  fakeControls.failNext = 0;
  fakeControls.hold = null;
  await resetDb(idle);
});

const STOPPED = "The server stopped while reading this contract, so the reading didn't finish. Read it again, or type it in by hand.";
const q = <T>(text: ReturnType<typeof sql>) => idle.ctx.db.execute<T & Record<string, unknown>>(text).then((r) => r.rows);
const count = async (action: string, studyId: string) => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action} AND study_id = ${studyId}`))[0]!.n;
const alertKinds = async (studyId: string) => (await idle.app.inject({ url: "/api/v1/alerts?for=Zed" })).json<AlertPage>().items.filter((a) => a.studyId === studyId).map((a) => a.kind);

/** A study created and a read started on `idle`: both jobs queued, neither run. */
async function queued() {
  const [doc] = (await upload(idle.app, [{ name: "Work Order.pdf", data: await makeTextPdf("jobs") }])).json<DocumentDto[]>();
  const created = (await idle.app.inject({ method: "POST", url: "/api/v1/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
  await runIdentify(idle.ctx, created);
  const read = (await idle.app.inject({ method: "POST", url: `/api/v1/studies/${created.studyId}/extract`, payload: {} })).json<{ jobId: string; version: number }>();
  return { studyId: created.studyId, identify: created.jobId, ...read };
}
/** pg-boss's supervisor checks a queue at most once a minute (a crash is found within a minute or two); a test asks now. */
async function superviseNow(live: Built) {
  await idle.ctx.db.execute(sql`UPDATE pgboss.queue SET monitor_on = NULL, monitor_claim_on = NULL WHERE name = 'extract'`);
  await live.ctx.boss.supervise("extract");
}
const job = async (id: string) => (await idle.app.inject({ url: `/api/v1/jobs/${id}` })).json<JobDto>();

describe("a job run twice writes once", () => {
  it("two deliveries of one read at once pay for one AI read; a third, after it finished, does nothing", async () => {
    const { studyId, jobId, version } = await queued();
    const calls = fakeControls.calls.extract;
    await Promise.all([runExtract(idle.ctx, { jobId, studyId, version }), runExtract(idle.ctx, { jobId, studyId, version })]);
    await runExtract(idle.ctx, { jobId, studyId, version });
    expect(fakeControls.calls.extract - calls).toBe(1);
    expect(await job(jobId)).toMatchObject({ state: "succeeded" });
    expect(await count("extraction.completed", studyId)).toBe(1);
    expect(await alertKinds(studyId)).toEqual(["questions_ready"]);
    expect((await storedVersion(idle, studyId, version)).status).toBe("draft");
  });

  it("two runs of one identify at once write once", async () => {
    const [doc] = (await upload(idle.app, [{ name: "a.pdf", data: await makeTextPdf("ident") }])).json<DocumentDto[]>();
    const data = (await idle.app.inject({ method: "POST", url: "/api/v1/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
    await Promise.all([runIdentify(idle.ctx, data), runIdentify(idle.ctx, data)]);
    expect(await count("study.identified", data.studyId)).toBe(1);
    expect(await job(data.jobId)).toMatchObject({ state: "succeeded" });
  });

  it("only one read of a version can be live, by the database's own rule", async () => {
    const { studyId, version } = await queued();
    await expect(idle.ctx.db.execute(sql`INSERT INTO jobs (id, kind, study_id, version) VALUES (gen_random_uuid(), 'extract', ${studyId}, ${version})`)).rejects.toThrow();
  });
});

describe("a job whose server died is failed in plain words", () => {
  it("a read stopped while it ran drops its result when it comes back: the version stays failed", async () => {
    const { studyId, jobId, version } = await queued();
    let go!: () => void;
    fakeControls.hold = new Promise((r) => (go = r));
    const running = runExtract(idle.ctx, { jobId, studyId, version });
    while ((await job(jobId)).state !== "running") await new Promise((r) => setTimeout(r, 20));
    await recover(idle.ctx, jobId, { value: { message: "job heartbeat timeout" } });
    go();
    await running;
    expect(await job(jobId)).toMatchObject({ state: "failed", error: STOPPED, detail: "pg-boss: job heartbeat timeout" });
    expect((await storedVersion(idle, studyId, version)).status).toBe("failed");
    expect([await count("extraction.failed", studyId), await count("extraction.completed", studyId)]).toEqual([1, 0]);
    expect(await alertKinds(studyId)).toEqual(["couldnt_read"]);
  });

  it("missed heartbeats: pg-boss fails the read into the stranded queue, and the worker that's alive marks it failed", async () => {
    const { studyId, jobId, version } = await queued();
    // the dead server had taken the job and started the read
    const [taken] = await idle.ctx.boss.fetch("extract");
    expect(taken!.id).toBe(jobId);
    await idle.ctx.db.execute(sql`UPDATE jobs SET state = 'running' WHERE id = ${jobId}`);
    await idle.ctx.db.execute(sql`UPDATE pgboss.job SET heartbeat_on = now() - interval '5 minutes' WHERE id = ${jobId}`);
    await withWorkers(async (live) => {
      await superviseNow(live);
      expect(await waitJob(live.app, jobId)).toMatchObject({ state: "failed", error: STOPPED, detail: "pg-boss: job heartbeat timeout" });
    });
    expect((await storedVersion(idle, studyId, version)).status).toBe("failed");
    expect((await idle.app.inject({ url: `/api/v1/studies/${studyId}` })).json().status).toBe("extraction_failed");
    expect(await alertKinds(studyId)).toEqual(["couldnt_read"]);
    expect(await count("extraction.failed", studyId)).toBe(1);
  });

  it("a read past its two hours: failed as too long", async () => {
    const { jobId } = await queued();
    await idle.ctx.boss.fetch("extract");
    await idle.ctx.db.execute(sql`UPDATE jobs SET state = 'running' WHERE id = ${jobId}`);
    await idle.ctx.db.execute(sql`UPDATE pgboss.job SET started_on = now() - interval '3 hours' WHERE id = ${jobId}`);
    await withWorkers(async (live) => {
      await superviseNow(live);
      expect(await waitJob(live.app, jobId)).toMatchObject({
        state: "failed",
        error: "Reading this contract took more than two hours, so it was stopped. Read it again; if that happens again, type it in by hand.",
        detail: "pg-boss: job timed out",
      });
    });
  });

  it("at startup, a job whose queued job is gone is failed, and so is a read with no job at all", async () => {
    const { studyId, jobId, version } = await queued();
    await idle.ctx.db.execute(sql`DELETE FROM pgboss.job WHERE id = ${jobId}`);
    const [other] = await q<{ id: string }>(sql`INSERT INTO studies (protocol) VALUES ('ORPHAN') RETURNING id`);
    await idle.ctx.db.execute(sql`INSERT INTO rulebook_versions (study_id, version, status) VALUES (${other!.id}, 1, 'extracting')`);
    await withWorkers(async () => {}); // a server starting runs maintenance before taking any job
    expect(await job(jobId)).toMatchObject({ state: "failed", error: STOPPED, detail: "pg-boss: the queued job is missing" });
    expect((await storedVersion(idle, studyId, version)).status).toBe("failed");
    expect((await storedVersion(idle, other!.id, 1)).status).toBe("failed");
    expect(await count("extraction.failed", other!.id)).toBe(1);
    await maintain(idle.ctx, idle.ctx.boss); // again: nothing left to do
    expect(await count("extraction.failed", studyId)).toBe(1);
  });

  it("queues: a read is never retried, both report to the stranded queue, and workers heartbeat", async () => {
    expect(await idle.ctx.boss.getQueue("extract")).toMatchObject({ retryLimit: 0, expireInSeconds: 7200, heartbeatSeconds: 60, deadLetter: "stranded" });
    expect(await idle.ctx.boss.getQueue("identify")).toMatchObject({ retryLimit: 2, heartbeatSeconds: 60, deadLetter: "stranded" });
  });
});
