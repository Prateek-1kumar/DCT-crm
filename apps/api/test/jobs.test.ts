import type { ReadWarning } from "@dct/extraction";
import type { AlertPage, AuditPage, DocumentDto, JobDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { maintain, plainWarnings, recover, runExtract, runIdentify } from "../src/jobs.js";
import { type Built, cause, makeTextPdf, resetDb, storedVersion, testApp, until, upload, waitJob } from "./helpers.js";

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
  fakeControls.warnings = [];
  fakeControls.signal = undefined;
  await resetDb(idle);
});

const STOPPED = "The server stopped while reading this contract, so the reading didn't finish. Read it again, or type it in by hand.";
const TIMED_OUT = "Reading this contract took more than two hours, so it was stopped. Read it again; if that happens again, type it in by hand.";
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
    expect(await cause(idle.ctx.db.execute(sql`INSERT INTO jobs (id, kind, study_id, version) VALUES (gen_random_uuid(), 'extract', ${studyId}, ${version})`))).toMatch(/jobs_one_live_read_idx/);
  });
});

describe("a job whose server died is failed in plain words", () => {
  it("a read stopped while it ran drops its result when it comes back: the version stays failed", async () => {
    const { studyId, jobId, version } = await queued();
    let go!: () => void;
    fakeControls.hold = new Promise((r) => (go = r));
    const running = runExtract(idle.ctx, { jobId, studyId, version });
    await until(async () => (await job(jobId)).state === "running", "the read to start");
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
      expect(await waitJob(live.app, jobId)).toMatchObject({ state: "failed", error: TIMED_OUT, detail: "pg-boss: job timed out" });
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

describe("a read pg-boss gave up on (past its time, its claim lost, a shutdown)", () => {
  it("never writes its result, and leaves the failing to the stranded queue, which says why in plain words", async () => {
    // the read comes back with its result, or throws (the real one does, at its next AI call: extract.ts `capped`)
    for (const throws of [false, true]) {
      const { studyId, jobId, version } = await queued();
      let go!: () => void;
      fakeControls.hold = new Promise((r) => (go = r));
      fakeControls.failNext = throws ? 1 : 0;
      const stop = new AbortController();
      const running = runExtract(idle.ctx, { jobId, studyId, version }, stop.signal);
      await until(async () => (await job(jobId)).state === "running", "the read to start");
      stop.abort();
      go();
      await running;
      expect(fakeControls.signal).toBe(stop.signal);
      // nothing written, and not failed as "something went wrong": pg-boss failed it into the stranded queue
      expect([(await job(jobId)).state, (await storedVersion(idle, studyId, version)).status]).toEqual(["running", "extracting"]);
      await recover(idle.ctx, jobId, { message: "handler execution exceeded 7200s" });
      expect(await job(jobId)).toMatchObject({ state: "failed", error: TIMED_OUT, detail: "pg-boss: handler execution exceeded 7200s" });
      expect((await storedVersion(idle, studyId, version)).status).toBe("failed");
      expect([await count("extraction.failed", studyId), await count("extraction.completed", studyId)]).toEqual([1, 0]);
    }
  });

  it("past its time, the worker running it aborts the read's signal, and the read is failed as too long", async () => {
    await withWorkers(async (live) => {
      await live.ctx.boss.updateQueue("extract", { expireInSeconds: 1 });
      let go!: () => void;
      try {
        const [doc] = (await upload(live.app, [{ name: "Work Order.pdf", data: await makeTextPdf("late") }])).json<DocumentDto[]>();
        const created = (await live.app.inject({ method: "POST", url: "/api/v1/studies", payload: { documentIds: [doc!.id] } })).json<{ studyId: string; jobId: string }>();
        await waitJob(live.app, created.jobId);
        fakeControls.hold = new Promise((r) => (go = r));
        const read = (await live.app.inject({ method: "POST", url: `/api/v1/studies/${created.studyId}/extract`, payload: {} })).json<{ jobId: string; version: number }>();
        expect(await waitJob(live.app, read.jobId)).toMatchObject({ state: "failed", error: TIMED_OUT, detail: "pg-boss: handler execution exceeded 1s" });
        expect(fakeControls.signal?.aborted).toBe(true);
        go();
        expect((await storedVersion(idle, created.studyId, read.version)).status).toBe("failed");
      } finally {
        go?.();
        await live.ctx.boss.updateQueue("extract", { expireInSeconds: 2 * 60 * 60 });
      }
    });
  });
});

describe("what pg-boss and the reading say", () => {
  it("a weaker reading is said by its kind in plain words with the version, and logged in the reading's own words", async () => {
    const said: ReadWarning[] = [
      { kind: "grid_reread_failed", grid: 2, text: "The re-read of budget grid 2 failed, so the first read was kept: timed out" },
      { kind: "grid_reread_skipped", grid: 3, text: "Budget grid 3: 2 total(s) don't add up; the re-read was skipped to stay within the $20.00 limit." },
      { kind: "cross_read_failed", text: "The cross-read failed: the answer for budget grid 1 was cut off" },
      { kind: "over_limit", text: "The read cost $20.40, over the $20.00 limit (estimated $12.00)." },
      // off by choice: nothing said
      { kind: "cross_read_off", text: "The cross-read is off (CROSS_READ=off, or no key)." },
      { kind: "fake", text: "EXTRACTION_FAKE=1: synthetic fixture, not read from the uploaded files" },
    ];
    expect(plainWarnings(said)).toEqual([
      "Budget grid 2 was read only once: its second, closer reading failed. Check its numbers with extra care.",
      "Budget grid 3 was read only once: its second, closer reading was skipped to stay within the cost limit. Check its numbers with extra care.",
      "The second, independent reading failed, so nothing compared the first reading against it.",
      "This reading cost more than the usual limit. Tell the team.",
    ]);
    fakeControls.warnings = said;
    const { studyId, jobId, version } = await queued();
    await runExtract(idle.ctx, { jobId, studyId, version });
    expect((await storedVersion(idle, studyId, version)).warnings).toEqual(plainWarnings(said));
    const log = (await idle.app.inject({ url: `/api/v1/audit?studyId=${studyId}` })).json<AuditPage>().items;
    expect(log.find((e) => e.action === "extraction.completed")!.detail.warnings).toEqual(said.map((w) => w.text));
  });

  it("pg-boss's warnings are logged in their own words, never with their data (a slow query's bound values)", () => {
    const warn = vi.spyOn(idle.ctx.log, "warn");
    try {
      const message = "Warning: slow query. Your queues and/or database server should be reviewed";
      idle.ctx.boss.emit("warning", { message, data: { elapsed: 31, sql: "SELECT …", values: [{ jobId: "job-data" }] } });
      expect(warn).toHaveBeenCalledWith({ warning: message }, "pg-boss warning");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("job-data");
    } finally {
      warn.mockRestore();
    }
  });
});
