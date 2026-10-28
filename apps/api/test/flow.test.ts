import type { AuditPage, DiffEntry, DocumentDto, RulebookVersionDto, StudyDetailDto, StudyPage } from "@dct/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { at } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, storedVersion, testApp, upload } from "./helpers.js";

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

const get = async <T>(url: string) => (await app.inject({ url })).json<T>();
const study = (id: string) => get<StudyDetailDto>(`/api/v1/studies/${id}`);
const version = (id: string, v: number) => get<RulebookVersionDto>(`/api/v1/studies/${id}/versions/${v}`);
const auditOf = async (studyId: string) => (await get<AuditPage>(`/api/v1/audit?studyId=${studyId}&limit=100`)).items;
const auditActions = async (studyId: string) => (await auditOf(studyId)).map((a) => a.action);
const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url, payload });
const answer = (studyId: string, v: number, item: string, body: object) => post(`/api/v1/studies/${studyId}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });

describe("bring a study on board", () => {
  it("creates a study, identifies documents in the background, then confirms details", async () => {
    const { studyId, doc } = await newStudy(app, "s");
    const s = await study(studyId);
    expect(s).toMatchObject({ status: "setting_up", sponsor: "Synthetic Pharma", protocol: "SYN-001", liveVersion: null });
    expect(s.documents).toEqual([expect.objectContaining({ id: doc.id, kind: "work_order", text: "text" })]);

    const res = await patch(`/api/v1/studies/${studyId}`, { sponsor: "Synthetic Pharma Inc", protocol: "SYN-001", siteName: "Site A", investigator: "Dr. Test", by: "Asha" });
    expect(res.json<StudyDetailDto>().sponsor).toBe("Synthetic Pharma Inc");
    expect(await auditActions(studyId)).toEqual(["study.confirmed", "study.identified", "study.created"]);
  });

  it("a double-submitted create (same files) makes one study, not two", async () => {
    const docs = (await upload(app, [{ name: "a.pdf", data: await makePdf("dbl-a") }, { name: "b.pdf", data: await makePdf("dbl-b") }])).json<DocumentDto[]>();
    const ids = docs.map((d) => d.id);
    const [r1, r2] = await Promise.all([post("/api/v1/studies", { documentIds: ids }), post("/api/v1/studies", { documentIds: [...ids].reverse() })]);
    expect(r1.json()).toEqual(r2.json());
    expect((await get<StudyPage>("/api/v1/studies")).total).toBe(1);
    // a different file set is a different study
    expect((await post("/api/v1/studies", { documentIds: [ids[0]] })).json().studyId).not.toBe(r1.json().studyId);
  });

  it("rejects unknown documents and bad bodies", async () => {
    expect((await post("/api/v1/studies", { documentIds: [] })).statusCode).toBe(400);
    expect((await post("/api/v1/studies", { documentIds: ["00000000-0000-0000-0000-000000000000"] })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/studies/00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
  });

  it("serves nothing on the old /api path", async () => {
    expect((await app.inject({ url: "/api/settings" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/v1/settings" })).statusCode).toBe(200);
  });
});

describe("extraction", () => {
  it("fills a draft version with evidence, questions and cost; the checks' findings are kept", async () => {
    const { studyId } = await newStudy(app, "s");
    const { job, v } = await extract(app, studyId);
    expect(job).toMatchObject({ state: "succeeded", progress: 100 });
    expect(v).toBe(1);
    const ver = await version(studyId, 1);
    expect(ver.status).toBe("draft");
    expect(ver.rulebook?.study.sponsor.value).toBe("Synthetic Pharma");
    expect(ver.cost).toEqual({ usd: expect.closeTo(0.07, 6), inputTokens: 1800, outputTokens: 350 });
    expect(ver.review).toHaveLength(8);
    expect((await storedVersion(built, studyId, 1)).anomalies.map((a) => a.code).sort()).toEqual(["AI_DISAGREEMENT", "GRID_CONFLICT", "MISSING_REFERENCED_DOC", "VISIT_TOTAL_MISMATCH"]);
    const [summary] = (await get<StudyPage>("/api/v1/studies")).items;
    expect(summary).toMatchObject({ status: "needs_review", needsYou: 8, openAnomalies: 8, liveVersion: null });
    expect((await auditOf(studyId))[0]).toMatchObject({ action: "extraction.completed", detail: { questions: 8, pdfCheck: { values: 36, matched: 32 } } });
    // a draft is under review: no second extraction on top of it
    expect((await post(`/api/v1/studies/${studyId}/extract`, {})).statusCode).toBe(409);
  });

  it("marks a failed extraction, and a retry reuses the same version", async () => {
    const { studyId } = await newStudy(app, "s");
    fakeControls.failNext = 1;
    const first = await extract(app, studyId);
    // plain words for people; the reader's own reason kept for the team
    expect(first.job).toMatchObject({ state: "failed", error: "Something went wrong while reading. Try again; if it keeps happening, tell the team.", detail: "fake extraction failure" });
    expect((await get<AuditPage>(`/api/v1/audit?studyId=${studyId}`)).items[0]).toMatchObject({ action: "extraction.failed", detail: { error: first.job.error, detail: "fake extraction failure" } });
    expect((await study(studyId)).status).toBe("extraction_failed");
    expect((await version(studyId, 1)).status).toBe("failed");

    const retry = await extract(app, studyId);
    expect(retry).toMatchObject({ v: 1, job: { state: "succeeded" } });
    const s = await study(studyId);
    expect(s.status).toBe("needs_review");
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([[1, "draft"]]);
  });

  it("re-running a delivered job is a no-op", async () => {
    const { studyId } = await newStudy(app, "s");
    const { v } = await extract(app, studyId);
    const { runExtract } = await import("../src/jobs.js");
    const before = await version(studyId, v);
    await runExtract(built.ctx.db, { jobId: "00000000-0000-0000-0000-000000000000", studyId, version: v });
    expect(await version(studyId, v)).toEqual(before);
  });
});

describe("sign-off", () => {
  it("signed versions are immutable (API 409, and the database refuses too); proofread marks are the exception", async () => {
    const { studyId } = await liveStudy(built);
    const base = `/api/v1/studies/${studyId}/versions/1`;
    const item = (await version(studyId, 1)).review[0]!.id;
    const writes = [
      await patch(`${base}/values`, { path: "/payment/netDays/value", value: 30, note: "x", by: "Asha" }),
      await answer(studyId, 1, item, { value: 1 }),
      await post(`${base}/send-back`, { itemIds: [item], note: "x", by: "Ben" }),
      await post(`${base}/by-hand/done`, { by: "Asha" }),
      await post(`${base}/sign-off`, { by: "Ben" }),
    ];
    for (const w of writes) expect(w.statusCode, w.body).toBe(409);
    expect(writes.at(-1)!.json().message).toMatch(/immutable/);
    for (const col of ["rulebook", "review", "evidence"])
      await expect(built.ctx.db.execute(sql.raw(`UPDATE rulebook_versions SET ${col} = '[]' WHERE status = 'signed'`))).rejects.toThrow();
    await built.ctx.db.execute(sql`UPDATE rulebook_versions SET proofread = '[]' WHERE status = 'signed'`);
  });
});

describe("amendment", () => {
  it("creates v2 while v1 stays live; diff shows the change; signing v2 supersedes v1", async () => {
    const { studyId } = await liveStudy(built);
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    const { job, v } = await extract(app, studyId, { documentIds: [amend!.id], by: "Asha" });
    expect(job.state).toBe("succeeded");
    expect(v).toBe(2);

    let s = await study(studyId);
    expect(s).toMatchObject({ status: "amendment_in_review", liveVersion: 1 });
    expect(s.documents.map((d) => [d.id, d.text])).toContainEqual([amend!.id, "scan"]);
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([
      [2, "draft"],
      [1, "signed"],
    ]);

    await settleAll(built, studyId, 2);
    const diff = await get<DiffEntry[]>(`/api/v1/studies/${studyId}/versions/2/diff?against=1`);
    expect(diff).toContainEqual({
      path: "/invoiceables/0/amountWithOverheadCents",
      change: "changed",
      before: 80000,
      after: 90000,
      label: "Invoiceable › Unscheduled visit › Amount with overhead",
    });
    expect(diff).toContainEqual(expect.objectContaining({ path: "/appliesFrom/value", before: null, after: "2026-01-01" }));
    expect((await app.inject({ url: `/api/v1/studies/${studyId}/versions/2/diff` })).statusCode).toBe(400);
    expect((await version(studyId, 2)).appliesFrom).toBe("2026-01-01");

    expect((await post(`/api/v1/studies/${studyId}/versions/2/sign-off`, { by: "Ben" })).statusCode).toBe(200);
    s = await study(studyId);
    expect(s).toMatchObject({ status: "live", liveVersion: 2 });
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([
      [2, "signed"],
      [1, "superseded"],
    ]);
  });
});

describe("amendment carries the live version's corrections", () => {
  const g2Total = "/budgetGrids/1/visits/1/totalCents";
  const netDays = "/payment/netDays/value";

  it("replays the values answers wrote and the grid choice; the new read is still checked against the PDF", async () => {
    const { studyId } = await newStudy(app, "s");
    await extract(app, studyId);
    expect((await answer(studyId, 1, `confirm:${g2Total}`, { value: 848900 })).statusCode).toBe(200); // the page prints 8,489.00
    await answer(studyId, 1, `confirm:${netDays}`, { value: 30 }); // differs from the read 45…
    await answer(studyId, 1, `confirm:${netDays}`, { value: 30, note: "§4.2 on page 1" }); // …and kept: no PDF text, so the note says where
    await answer(studyId, 1, "anomaly:GRID_CONFLICT:/budgetGrids/0", { optionId: "g2" });
    await settleAll(built, studyId, 1);
    expect((await post(`/api/v1/studies/${studyId}/versions/1/sign-off`, { by: "Ben" })).statusCode).toBe(200);

    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    expect((await extract(app, studyId, { documentIds: [amend!.id], by: "Asha" })).job.state).toBe("succeeded");
    const v2 = await storedVersion(built, studyId, 2);
    // the read has 8,488.00 again: carried, marked manual, and now confirmed by the page, so nobody types it again
    // (that the printed total doesn't add up is asked once, as a problem in the contract)
    expect(v2.rulebook!.budgetGrids[1]!.visits[1]).toMatchObject({ totalCents: 848900, prov: { method: "manual" } });
    expect(v2.evidence.find((e) => e.path === g2Total)).toMatchObject({ status: "confirmed" });
    expect(v2.review.filter((i) => i.path === g2Total).map((i) => i.reason)).toEqual(["VISIT_TOTAL_MISMATCH"]);
    // carried too, but nothing on the page backs it: asked again
    expect([at(v2.rulebook, netDays), v2.review.find((i) => i.path === netDays)?.reason]).toEqual([30, "UNGROUNDED_VALUE"]);
    expect(v2.rulebook!.governingGridId).toBe("g2");
    expect(v2.review.map((i) => i.reason)).not.toContain("GRID_CONFLICT");
    expect(v2.editors).toEqual([]);

    const carried = async () => (await auditOf(studyId)).find((e) => e.action === "version.corrections_carried")!.detail;
    // both paths have an open question on v2, so the log withholds their values for now
    expect((await carried()).carried).toEqual([expect.not.objectContaining({ after: expect.anything() }), expect.not.objectContaining({ after: expect.anything() })]);
    await settleAll(built, studyId, 2);
    expect(await carried()).toMatchObject({
      version: 2,
      from: 1,
      carried: [expect.objectContaining({ path: g2Total, before: 848800, after: 848900, by: "Sam", items: ["g2", "V2"] }), expect.objectContaining({ path: netDays, before: 45, after: 30 })],
      grid: { from: "g2", to: "g2" },
    });

    // transitively: v3 gets v1's carried corrections and v2's own
    expect((await post(`/api/v1/studies/${studyId}/versions/2/sign-off`, { by: "Ben" })).statusCode).toBe(200);
    await extract(app, studyId);
    const v3 = await storedVersion(built, studyId, 3);
    expect([at(v3.rulebook, g2Total), at(v3.rulebook, netDays)]).toEqual([848900, 30]);
    await settleAll(built, studyId, 3);
    expect(await get<DiffEntry[]>(`/api/v1/studies/${studyId}/versions/3/diff?against=2`)).toEqual([]);
  });

  it("a first extraction carries nothing", async () => {
    const { studyId } = await newStudy(app, "s");
    await extract(app, studyId);
    expect(await auditActions(studyId)).not.toContain("version.corrections_carried");
  });
});

describe("audit log", () => {
  it("is append-only", async () => {
    const { studyId } = await newStudy(app, "s");
    const entries = await auditOf(studyId);
    expect(entries.length).toBeGreaterThan(0);
    await expect(built.ctx.db.execute(sql`UPDATE audit_log SET by = 'mallory'`)).rejects.toThrow();
    await expect(built.ctx.db.execute(sql`DELETE FROM audit_log`)).rejects.toThrow();
    expect(await auditOf(studyId)).toEqual(entries);
  });
});
