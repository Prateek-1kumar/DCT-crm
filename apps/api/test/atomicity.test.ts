import { RenderTimeoutError } from "@dct/extraction";
import type { AlertPage, DocumentDto, RulebookVersionDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { fakeControls } from "../src/extraction/fake.js";
import { getExtraction } from "../src/extraction/port.js";
import { type App, type Built, extract, liveStudy, makeTextPdf, multipart, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload, waitJob } from "./helpers.js";

// A failure injected into the last insert of a write (a trigger that raises): nothing of the write is left behind. No
// status change without its audit entry, no alert without its transition, no job without its row, no orphan file.

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());
beforeEach(async () => {
  fakeControls.failNext = 0;
  await resetDb(built);
});
afterEach(async () => {
  for (const t of ["audit_log", "alerts", "idempotency_keys"]) await built.ctx.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_fail ON ${t}`));
});

/** The next insert into `table` whose `column` is `value` raises, as a failing constraint would. */
async function failInsert(table: "audit_log" | "alerts" | "idempotency_keys", column: string, value: string) {
  await built.ctx.db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF to_jsonb(NEW)->>TG_ARGV[0] = TG_ARGV[1] THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`),
  );
  await built.ctx.db.execute(sql.raw(`CREATE TRIGGER test_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail('${column}', '${value}')`));
}

/** What a write could change: every version, study, document, job, alert (and who read it), audit entry and setting. */
async function state() {
  const { rows } = await built.ctx.db.execute(sql`SELECT
    (SELECT coalesce(json_agg(v ORDER BY study_id, version), '[]') FROM (SELECT study_id, version, status, by_hand, rulebook, review, evidence, anomalies, editors, proofread, applies_from, signed_by, updated_at FROM rulebook_versions) v)::text AS versions,
    (SELECT coalesce(json_agg(s ORDER BY id), '[]') FROM (SELECT id, status, needs_you, stage, sponsor, protocol, site_name, investigator, updated_at FROM studies) s)::text AS studies,
    (SELECT coalesce(json_agg(d ORDER BY id), '[]') FROM (SELECT id, kind FROM documents) d)::text AS kinds,
    (SELECT coalesce(json_agg(j ORDER BY id), '[]') FROM (SELECT id, state, error FROM jobs) j)::text AS jobs,
    (SELECT coalesce(json_agg(c), '[]') FROM (SELECT people, maker_checker FROM settings) c)::text AS settings,
    (SELECT count(*) FROM pgboss.job WHERE name IN ('identify', 'extract'))::int AS queued,
    (SELECT count(*) FROM alerts)::int AS alerts, (SELECT count(*) FROM alert_reads)::int AS reads, (SELECT count(*) FROM audit_log)::int AS audit,
    (SELECT count(*) FROM study_documents)::int AS links, (SELECT count(*) FROM documents)::int AS documents,
    (SELECT count(*) FROM idempotency_keys)::int AS keys`);
  return rows[0]!;
}

const send = (method: "POST" | "PATCH", url: string, payload: object, key?: string) =>
  app.inject({ method, url: `/api/v1${url}`, payload, headers: key ? { "idempotency-key": key } : {} });
const post = (url: string, payload: object, key?: string) => send("POST", url, payload, key);

/** The write fails with a 500 and leaves everything as it was; then, the failure gone, the same key applies it once. */
async function noTrace(fail: () => Promise<void>, url: string, payload: object, method: "POST" | "PATCH" = "POST") {
  const before = await state();
  await fail();
  const key = randomUUID();
  const res = await send(method, url, payload, key);
  expect(res.statusCode, res.body).toBe(500);
  expect(await state()).toEqual(before);
  for (const t of ["audit_log", "alerts", "idempotency_keys"]) await built.ctx.db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_fail ON ${t}`));
  const ok = await send(method, url, payload, key);
  expect(ok.statusCode, ok.body).toBeLessThan(300);
  expect(await state()).not.toEqual(before);
  return ok;
}

describe("a write that fails at its last insert leaves nothing half-saved", () => {
  it("approval: still a draft, the study not live, no alert; and the saved response fails with it", async () => {
    const { studyId } = await newStudy(app, "sign");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    const asOf = async (id: string) => (await app.inject({ url: `/api/v1/studies/${id}/versions/1` })).json<RulebookVersionDto>().updatedAt;
    await noTrace(() => failInsert("audit_log", "action", "version.signed"), `/studies/${studyId}/versions/1/sign-off`, { by: "Ben", asOf: await asOf(studyId) });
    // the response's key is the very last insert: failing it rolls the approval back too
    const { studyId: other } = await newStudy(app, "sign2");
    await extract(app, other);
    await settleAll(built, other, 1);
    await noTrace(() => failInsert("idempotency_keys", "status", "200"), `/studies/${other}/versions/1/sign-off`, { by: "Ben", asOf: await asOf(other) });
  });

  it("send back: answers still answered, evidence as it was, no sent_back alert, no log entry", async () => {
    const { studyId } = await newStudy(app, "back");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    await noTrace(() => failInsert("alerts", "kind", "sent_back"), `/studies/${studyId}/versions/1/send-back`, { itemIds: ["confirm:/budgetGrids/1/visits/1/totalCents"], note: "again", by: "Morgan" });
  });

  it("the last answer: no value written, no 'ready for approval' alert, still needs you", async () => {
    const { studyId } = await newStudy(app, "last");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    const grid = "anomaly:GRID_CONFLICT:/budgetGrids/0";
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: [grid], note: "which grid?", by: "Morgan" })).statusCode).toBe(200);
    await noTrace(() => failInsert("alerts", "kind", "ready_for_approval"), `/studies/${studyId}/versions/1/review/${encodeURIComponent(grid)}`, { optionId: "g2", by: "Sam" });
  });

  it("a bill-by-hand answer: the term not listed on the master, the question still open", async () => {
    const { studyId } = await newStudy(app, "bill");
    await extract(app, studyId);
    const term = (await storedVersion(built, studyId, 1)).review.find((i) => i.reason === "UNACCOUNTED_TERM")!.id;
    await noTrace(() => failInsert("audit_log", "action", "review.answered"), `/studies/${studyId}/versions/1/review/${encodeURIComponent(term)}`, { optionId: "bill_by_hand", by: "Sam" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toHaveLength(1);
  });

  it("a random spot check that misses: not settled, not missed, without its incident or its alert", async () => {
    for (const [seed, fail] of [
      ["miss", () => failInsert("audit_log", "action", "sample.missed")],
      ["miss-alert", () => failInsert("alerts", "kind", "sample_missed")],
    ] as const) {
      const { studyId } = await newStudy(app, seed);
      await extract(app, studyId);
      const url = `/studies/${studyId}/versions/1/review/${encodeURIComponent("sample:/budgetGrids/0/procedures/0/cells/V1")}`;
      expect((await post(url, { value: 5600, by: "Sam" })).statusCode).toBe(200);
      await noTrace(fail, url, { value: 5600, note: "the page prints $56.00", by: "Sam" });
      expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === "sample:/budgetGrids/0/procedures/0/cells/V1")!.missed).toBe(true);
    }
  });

  it("'This looks wrong' on the live version: no correction draft, the study still live", async () => {
    const { studyId } = await liveStudy(built, "report");
    await noTrace(() => failInsert("audit_log", "action", "number.reported"), `/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Sam" });
    expect((await storedVersion(built, studyId, 2)).status).toBe("draft");
  });

  it("typing done: no values picked to re-type", async () => {
    const { studyId } = await newStudy(app, "hand", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" });
    await app.inject({ method: "PATCH", url: `/api/v1/studies/${studyId}/versions/1/values`, payload: { path: "/payment/netDays/value", value: 45, note: "x", by: "Avery" } });
    await noTrace(() => failInsert("audit_log", "action", "byhand.done"), `/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" });
  });

  it("a file's kind on a file two studies share: logged on each, or changed on neither (the last study's entry fails)", async () => {
    const { studyId: one, doc } = await newStudy(app, "kind");
    const [other] = (await upload(app, [{ name: "b.pdf", data: await makeTextPdf("kind-b") }])).json<DocumentDto[]>();
    const two = (await post("/studies", { documentIds: [doc.id, other!.id] })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, two.jobId);
    // the route logs one entry per study, in study id order: the first is written before the last one fails
    const last = [one, two.studyId].sort().at(-1)!;
    await noTrace(() => failInsert("audit_log", "study_id", last), `/documents/${doc.id}`, { kind: "master_agreement", by: "Asha" }, "PATCH");
    const kinds = (await built.ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.kind_set'`)).rows[0]!.n;
    expect(kinds).toBe(2);
  });

  it("confirming a study's details: the details as they were", async () => {
    const { studyId } = await newStudy(app, "confirm");
    await noTrace(() => failInsert("audit_log", "action", "study.confirmed"), `/studies/${studyId}`, { sponsor: "Other Pharma", protocol: "OTH-1", siteName: "Site B", investigator: "Dr. Other", by: "Asha" }, "PATCH");
  });

  it("starting to type by hand, typing a value, typing done: no blank draft, no value, no re-type questions", async () => {
    const { studyId } = await newStudy(app, "hand-all", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await noTrace(() => failInsert("audit_log", "action", "version.manual_created"), `/studies/${studyId}/versions/by-hand`, { by: "Avery" });
    expect((await storedVersion(built, studyId, 1)).byHand).toBe(true);
    await noTrace(() => failInsert("audit_log", "action", "value.typed"), `/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 45, note: "x", by: "Avery" }, "PATCH");
  });

  it("proofreading: no marks", async () => {
    const { studyId } = await newStudy(app, "proof");
    await extract(app, studyId);
    await noTrace(() => failInsert("audit_log", "action", "values.proofread"), `/studies/${studyId}/versions/1/proofread`, { paths: ["/siteFees/0/amountCents"], by: "Sam" });
  });

  it("'This looks wrong' on a draft: no question added, the study's count as it was", async () => {
    const { studyId } = await newStudy(app, "report-draft");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    await noTrace(() => failInsert("audit_log", "action", "number.reported"), `/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Sam" });
    expect((await storedVersion(built, studyId, 1)).review.at(-1)!.reason).toBe("reported");
  });

  it("an answer that asks a settled total again: neither the answer nor the total reopened without its log entry", async () => {
    const { studyId } = await newStudy(app, "reopen");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    const part = "/budgetGrids/0/visits/1/overheadCents"; // printed 2,425.00; its visit's total was settled as printed
    const item = (await post(`/studies/${studyId}/versions/1/report`, { path: part, note: "check", by: "Sam" })).json<RulebookVersionDto>().review.at(-1)!.id;
    const url = `/studies/${studyId}/versions/1/review/${encodeURIComponent(item)}`;
    expect((await post(url, { value: 242700, by: "Sam" })).statusCode).toBe(200);
    await noTrace(() => failInsert("audit_log", "action", "review.reopened"), url, { value: 242700, note: "corrected in ink", by: "Sam" });
    expect((await storedVersion(built, studyId, 1)).review.find((i) => i.id === "anomaly:VISIT_TOTAL_MISMATCH:/budgetGrids/0/visits/1/totalCents")!.outcome).toBeNull();
  });

  it("alerts marked read: none marked", async () => {
    const { studyId } = await newStudy(app, "alerts");
    await extract(app, studyId); // questions are ready: an alert
    // reading alerts logs nothing, so the response's saved key is the last insert
    await noTrace(() => failInsert("idempotency_keys", "status", "200"), "/alerts/read", { by: "Ben" });
  });

  it("settings: as they were", async () => {
    await noTrace(() => failInsert("audit_log", "action", "settings.updated"), "/settings", { people: ["Asha", "Ben"], makerChecker: true, by: "Asha" }, "PATCH");
  });

  it("creating a study and starting a read: no study, version or job row, and no queued job, without the other", async () => {
    const [doc] = (await upload(app, [{ name: "a.pdf", data: await makeTextPdf("create") }])).json<DocumentDto[]>();
    const created = await noTrace(() => failInsert("audit_log", "action", "study.created"), "/studies", { documentIds: [doc!.id] });
    const { studyId, jobId } = created.json<{ studyId: string; jobId: string }>();
    await waitJob(app, jobId);
    const read = await noTrace(() => failInsert("audit_log", "action", "extraction.queued"), `/studies/${studyId}/extract`, {});
    await waitJob(app, read.json<{ jobId: string }>().jobId);
  });
});

describe("two writes to one study at once", () => {
  it("queue up instead of deadlocking (a report locked the version and then the study, a read the other way round)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { studyId } = await newStudy(app, `lock${i}`, { scan: true });
      fakeControls.failNext = 1;
      await extract(app, studyId);
      ids.push(studyId);
    }
    fakeControls.failNext = 100;
    const res = await Promise.all(ids.flatMap((id) => [post(`/studies/${id}/versions/1/report`, { path: "/payment/netDays/value", note: "x", by: "Sam" }), post(`/studies/${id}/extract`, {})]));
    // 400: the failed read has nothing to report on; 202: read again. Never a deadlock (409) or a 500.
    expect(new Set(res.map((r) => r.statusCode))).toEqual(new Set([400, 202]));
    for (const r of res) if (r.statusCode === 202) await waitJob(app, r.json<{ jobId: string }>().jobId);
  });
});

describe("a job's result is all or nothing", () => {
  it("a read whose completion fails ends failed, with its log entry and alert, never a draft without them", async () => {
    const { studyId } = await newStudy(app, "job");
    await failInsert("audit_log", "action", "extraction.completed");
    const { job } = await extract(app, studyId);
    expect(job).toMatchObject({ state: "failed", error: "A database error stopped this. Try again; if it keeps happening, tell the team." });
    const v = await storedVersion(built, studyId, 1);
    expect([v.status, v.review]).toEqual(["failed", []]);
    const actions = (await built.ctx.db.execute<{ action: string }>(sql`SELECT action FROM audit_log WHERE study_id = ${studyId} ORDER BY id`)).rows.map((r) => r.action);
    expect(actions).toContain("extraction.failed");
    expect(actions).not.toContain("extraction.completed");
    const alerts = (await app.inject({ url: "/api/v1/alerts?for=Asha" })).json<AlertPage>().items.map((a) => a.kind);
    expect(alerts).toEqual(["couldnt_read"]); // not questions_ready: that transition was rolled back
    expect((await app.inject({ url: `/api/v1/studies/${studyId}` })).json().status).toBe("extraction_failed");
  });
});

describe("an upload's files and rows", () => {
  beforeEach(() => {
    if (config.uploadDir.includes("dct-api-test")) rmSync(config.uploadDir, { recursive: true, force: true });
    mkdirSync(config.uploadDir, { recursive: true });
  });
  const files = () => (existsSync(config.uploadDir) ? readdirSync(config.uploadDir).filter((f) => f.endsWith(".pdf") || f.endsWith(".tmp")) : []);

  it("a failed insert leaves no file, not even a temporary one; the same key then stores it once", async () => {
    const pdf = await makeTextPdf("orphan");
    const sha = createHash("sha256").update(pdf).digest("hex");
    const { payload, headers } = await multipart([{ name: "a.pdf", data: pdf }]);
    const key = randomUUID();
    for (const [table, column, value] of [["audit_log", "action", "document.uploaded"], ["idempotency_keys", "status", "201"]] as const) {
      await failInsert(table, column, value);
      const res = await app.inject({ method: "POST", url: "/api/v1/uploads", payload, headers: { ...headers, "idempotency-key": key } });
      expect(res.statusCode).toBe(500);
      expect(files()).toEqual([]);
      expect((await state()).documents).toBe(0);
      await built.ctx.db.execute(sql.raw(`DROP TRIGGER test_fail ON ${table}`));
    }
    const ok = await app.inject({ method: "POST", url: "/api/v1/uploads", payload, headers: { ...headers, "idempotency-key": key } });
    expect(ok.statusCode).toBe(201);
    expect(files()).toEqual([`${sha}.pdf`]);
  });

  it("a file left with no row (a crash between moving it and the commit) is taken over by the next upload of it", async () => {
    const pdf = await makeTextPdf("crash");
    const sha = createHash("sha256").update(pdf).digest("hex");
    writeFileSync(path.join(config.uploadDir, `${sha}.pdf`), pdf);
    const [doc] = (await upload(app, [{ name: "a.pdf", data: pdf }])).json<DocumentDto[]>();
    expect(doc).toMatchObject({ sha256: sha, duplicateOf: null, text: "text" });
    expect(files().filter((f) => f.startsWith(sha))).toEqual([`${sha}.pdf`]);
    expect((await app.inject({ url: `/api/v1/documents/${doc!.id}/pages/1.png` })).statusCode).toBe(200);
  });

  it("a file the PDF reader can't open in time: refused in words, and nothing of the upload is left", async () => {
    const port = await getExtraction();
    const real = port.pageCount;
    const asked: string[] = [];
    port.pageCount = async (file) => (asked.push(file), asked.length === 2 ? Promise.reject(new RenderTimeoutError("took too long")) : real(file));
    try {
      const res = await upload(app, [{ name: "a.pdf", data: await makeTextPdf("slow-a") }, { name: "slow.pdf", data: await makeTextPdf("slow-b") }]);
      expect([res.statusCode, res.json().message]).toEqual([422, "slow.pdf took too long to open, so it wasn't uploaded. It may be damaged or unusually complex: save it again as a PDF, or upload a fresh copy."]);
    } finally {
      port.pageCount = real;
    }
    // each counted from its staged file, in the reader's worker (where a crafted file costs a timeout, not the event loop)
    expect(asked.map((f) => f.startsWith(config.uploadDir) && f.endsWith(".tmp"))).toEqual([true, true]);
    expect([files(), (await state()).documents]).toEqual([[], 0]);
  });

  it("several files in one upload: all or none", async () => {
    const { payload, headers } = await multipart([
      { name: "a.pdf", data: await makeTextPdf("many-a") },
      { name: "b.pdf", data: await makeTextPdf("many-b") },
    ]);
    await failInsert("audit_log", "action", "document.uploaded");
    expect((await app.inject({ method: "POST", url: "/api/v1/uploads", payload, headers })).statusCode).toBe(500);
    expect([files(), (await state()).documents]).toEqual([[], 0]);
  });
});
