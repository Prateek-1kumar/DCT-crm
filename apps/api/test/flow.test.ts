import type { AuditEntryDto, DiffEntry, DocumentDto, RulebookVersionDto, StudyDetailDto, StudySummaryDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { type App, type Built, makePdf, resetDb, testApp, upload, waitJob } from "./helpers.js";

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
const study = (id: string) => get<StudyDetailDto>(`/api/studies/${id}`);
const version = (id: string, v: number) => get<RulebookVersionDto>(`/api/studies/${id}/versions/${v}`);
const auditActions = async (studyId: string) => (await get<AuditEntryDto[]>(`/api/audit?studyId=${studyId}`)).map((a) => a.action);

async function newStudy(seed = "s") {
  const [doc] = (await upload(app, [{ name: "Work Order.pdf", data: await makePdf(seed) }])).json<DocumentDto[]>();
  const res = await app.inject({ method: "POST", url: "/api/studies", payload: { documentIds: [doc!.id] } });
  expect(res.statusCode).toBe(201);
  const { studyId, jobId } = res.json<{ studyId: string; jobId: string }>();
  expect((await waitJob(app, jobId)).state).toBe("succeeded");
  return { studyId, doc: doc! };
}

async function extract(studyId: string, body: object = {}) {
  const res = await app.inject({ method: "POST", url: `/api/studies/${studyId}/extract`, payload: body });
  expect(res.statusCode).toBe(202);
  const { jobId, version: v } = res.json<{ jobId: string; version: number }>();
  return { job: await waitJob(app, jobId), v };
}

const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url, payload });
const resolve = (studyId: string, v: number, aid: string, by = "Asha") =>
  post(`/api/studies/${studyId}/versions/${v}/anomalies/${encodeURIComponent(aid)}/resolve`, { kind: "accepted_with_note", note: "checked", by });

async function resolveAll(studyId: string, v: number) {
  for (const a of (await version(studyId, v)).anomalies.filter((x) => !x.resolution)) expect((await resolve(studyId, v, a.id)).statusCode).toBe(200);
}

async function liveStudy() {
  const { studyId, doc } = await newStudy();
  await extract(studyId);
  await resolveAll(studyId, 1);
  expect((await post(`/api/studies/${studyId}/versions/1/sign-off`, { by: "Ben" })).statusCode).toBe(200);
  return { studyId, doc };
}

describe("bring a study on board", () => {
  it("creates a study, identifies documents in the background, then confirms details", async () => {
    const { studyId, doc } = await newStudy();
    const s = await study(studyId);
    expect(s).toMatchObject({ status: "setting_up", sponsor: "Synthetic Pharma", protocol: "SYN-001", liveVersion: null });
    expect(s.documents).toEqual([expect.objectContaining({ id: doc.id, kind: "work_order" })]);

    const res = await patch(`/api/studies/${studyId}`, { sponsor: "Synthetic Pharma Inc", protocol: "SYN-001", siteName: "Site A", investigator: "Dr. Test", by: "Asha" });
    expect(res.json<StudyDetailDto>().sponsor).toBe("Synthetic Pharma Inc");
    expect(await auditActions(studyId)).toEqual(["study.created", "study.identified", "study.confirmed"]);
  });

  it("rejects unknown documents and bad bodies", async () => {
    expect((await post("/api/studies", { documentIds: [] })).statusCode).toBe(400);
    expect((await post("/api/studies", { documentIds: ["00000000-0000-0000-0000-000000000000"] })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/studies/00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
  });
});

describe("extraction", () => {
  it("fills a draft version with anomalies and cost", async () => {
    const { studyId } = await newStudy();
    const { job, v } = await extract(studyId);
    expect(job).toMatchObject({ state: "succeeded", progress: 100 });
    expect(v).toBe(1);
    const ver = await version(studyId, 1);
    expect(ver.status).toBe("draft");
    expect(ver.rulebook?.study.sponsor.value).toBe("Synthetic Pharma");
    expect(ver.anomalies.map((a) => a.code).sort()).toEqual(["AI_DISAGREEMENT", "GRID_CONFLICT", "MISSING_REFERENCED_DOC", "VISIT_TOTAL_MISMATCH"]);
    expect(ver.cost).toEqual({ usd: expect.closeTo(0.07, 6), inputTokens: 1800, outputTokens: 350 });
    const [summary] = await get<StudySummaryDto[]>("/api/studies");
    expect(summary).toMatchObject({ status: "needs_review", openAnomalies: 4, liveVersion: null });
    // a draft is under review: no second extraction on top of it
    expect((await post(`/api/studies/${studyId}/extract`, {})).statusCode).toBe(409);
  });

  it("marks a failed extraction, and a retry reuses the same version", async () => {
    const { studyId } = await newStudy();
    fakeControls.failNext = 1;
    const first = await extract(studyId);
    expect(first.job).toMatchObject({ state: "failed", error: "fake extraction failure" });
    expect((await study(studyId)).status).toBe("extraction_failed");
    expect((await version(studyId, 1)).status).toBe("failed");

    const retry = await extract(studyId);
    expect(retry).toMatchObject({ v: 1, job: { state: "succeeded" } });
    const s = await study(studyId);
    expect(s.status).toBe("needs_review");
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([[1, "draft"]]);
  });

  it("re-running a delivered job is a no-op", async () => {
    const { studyId } = await newStudy();
    const { v } = await extract(studyId);
    const { runExtract } = await import("../src/jobs.js");
    const before = await version(studyId, v);
    await runExtract(built.ctx.db, { jobId: "00000000-0000-0000-0000-000000000000", studyId, version: v });
    expect(await version(studyId, v)).toEqual(before);
  });
});

describe("review", () => {
  it("corrects a value: validated, marked manual, logged and re-checked (resolutions kept)", async () => {
    const { studyId } = await newStudy();
    await extract(studyId);
    expect((await resolve(studyId, 1, "MISSING_REFERENCED_DOC:/referencedDocuments/0")).statusCode).toBe(200);

    const url = `/api/studies/${studyId}/versions/1/values`;
    expect((await patch(url, { path: "/budgetGrids/0/visits/1/totalCents", value: 848800.5, note: "x", by: "Asha" })).statusCode).toBe(400);
    expect((await patch(url, { path: "/nope/0", value: 1, note: "x", by: "Asha" })).statusCode).toBe(400);

    const res = await patch(url, { path: "/budgetGrids/0/visits/1/totalCents", value: 848800, note: "printed total is a typo", by: "Asha" });
    expect(res.statusCode).toBe(200);
    const ver = res.json<RulebookVersionDto>();
    expect(ver.rulebook!.budgetGrids[0]!.visits[1]).toMatchObject({ totalCents: 848800, prov: { method: "manual" } });
    expect(ver.anomalies.map((a) => a.code)).not.toContain("VISIT_TOTAL_MISMATCH");
    expect(ver.anomalies.find((a) => a.code === "MISSING_REFERENCED_DOC")?.resolution).toMatchObject({ by: "Asha", kind: "accepted_with_note" });
    expect(ver.editors).toEqual(["Asha"]);

    const entries = await get<AuditEntryDto[]>(`/api/audit?studyId=${studyId}`);
    expect(entries.at(-1)).toMatchObject({
      by: "Asha",
      action: "value.corrected",
      detail: { version: 1, path: "/budgetGrids/0/visits/1/totalCents", before: 848900, after: 848800, note: "printed total is a typo" },
    });
  });

  it("resolves an anomaly", async () => {
    const { studyId } = await newStudy();
    await extract(studyId);
    const res = await resolve(studyId, 1, "AI_DISAGREEMENT:/invoiceables/0/amountWithOverheadCents");
    expect(res.json<RulebookVersionDto>().anomalies.find((a) => a.code === "AI_DISAGREEMENT")?.resolution).toMatchObject({
      kind: "accepted_with_note",
      note: "checked",
      by: "Asha",
    });
    expect((await resolve(studyId, 1, "NOPE")).statusCode).toBe(404);
    expect((await post(`/api/studies/${studyId}/versions/1/anomalies/x/resolve`, { kind: "fixed", note: "", by: "A" })).statusCode).toBe(400);
    expect((await get<StudySummaryDto[]>("/api/studies"))[0]!.openAnomalies).toBe(3);
  });

  it("chooses the governing grid, which settles GRID_CONFLICT", async () => {
    const { studyId } = await newStudy();
    await extract(studyId);
    const url = `/api/studies/${studyId}/versions/1/grid-choice`;
    expect((await post(url, { gridId: "missing", note: "n", by: "Asha" })).statusCode).toBe(400);
    const ver = (await post(url, { gridId: "g2", note: "revised grid governs per sponsor email", by: "Asha" })).json<RulebookVersionDto>();
    expect(ver.rulebook!.governingGridId).toBe("g2");
    expect(ver.anomalies.find((a) => a.code === "GRID_CONFLICT")?.resolution).toMatchObject({ kind: "chosen", by: "Asha" });
    expect(await auditActions(studyId)).toContain("grid.chosen");
  });
});

describe("sign-off", () => {
  it("is blocked until every anomaly is settled, then makes the version live", async () => {
    const { studyId } = await newStudy();
    await extract(studyId);
    const url = `/api/studies/${studyId}/versions/1/sign-off`;
    const blocked = await post(url, { by: "Ben" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/4 unresolved anomalies/);

    await resolveAll(studyId, 1);
    const ok = await post(url, { by: "Ben", note: "all checked" });
    expect(ok.json<RulebookVersionDto>()).toMatchObject({ status: "signed", signedBy: "Ben" });
    expect(await study(studyId)).toMatchObject({ status: "live", liveVersion: 1, openAnomalies: 0 });
    expect(await auditActions(studyId)).toContain("version.signed");
  });

  it("maker-checker: whoever corrected values cannot sign", async () => {
    expect(await get("/api/settings")).toEqual({ makerChecker: false, people: [] });
    const s = (await patch("/api/settings", { makerChecker: true, people: ["Asha", "Ben"], by: "Ben" })).json();
    expect(s).toEqual({ makerChecker: true, people: ["Asha", "Ben"] });

    const { studyId } = await newStudy();
    await extract(studyId);
    await patch(`/api/studies/${studyId}/versions/1/values`, { path: "/budgetGrids/0/visits/1/totalCents", value: 848800, note: "typo", by: "Asha" });
    await resolveAll(studyId, 1);
    const blocked = await post(`/api/studies/${studyId}/versions/1/sign-off`, { by: "Asha" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/maker-checker/);
    expect((await post(`/api/studies/${studyId}/versions/1/sign-off`, { by: "Ben" })).statusCode).toBe(200);
  });

  it("maker-checker off (default): the editor may sign", async () => {
    const { studyId } = await newStudy();
    await extract(studyId);
    await patch(`/api/studies/${studyId}/versions/1/values`, { path: "/budgetGrids/0/visits/1/totalCents", value: 848800, note: "typo", by: "Asha" });
    await resolveAll(studyId, 1);
    expect((await post(`/api/studies/${studyId}/versions/1/sign-off`, { by: "Asha" })).statusCode).toBe(200);
  });

  it("signed versions are immutable (API 409, and the database refuses too)", async () => {
    const { studyId } = await liveStudy();
    const base = `/api/studies/${studyId}/versions/1`;
    const writes = [
      await patch(`${base}/values`, { path: "/payment/netDays/value", value: 30, note: "x", by: "Asha" }),
      await resolve(studyId, 1, "GRID_CONFLICT:/governingGridId"),
      await post(`${base}/grid-choice`, { gridId: "g1", note: "x", by: "Asha" }),
      await post(`${base}/sign-off`, { by: "Ben" }),
    ];
    for (const w of writes) {
      expect(w.statusCode).toBe(409);
      expect(w.json().message).toMatch(/immutable/);
    }
    await expect(built.ctx.db.execute(sql`UPDATE rulebook_versions SET rulebook = '{}' WHERE status = 'signed'`)).rejects.toThrow();
  });
});

describe("amendment", () => {
  it("creates v2 while v1 stays live; diff shows the change; signing v2 supersedes v1", async () => {
    const { studyId } = await liveStudy();
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    const { job, v } = await extract(studyId, { documentIds: [amend!.id], by: "Asha" });
    expect(job.state).toBe("succeeded");
    expect(v).toBe(2);

    let s = await study(studyId);
    expect(s).toMatchObject({ status: "amendment_in_review", liveVersion: 1 });
    expect(s.documents.map((d) => d.id)).toContain(amend!.id);
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([
      [2, "draft"],
      [1, "signed"],
    ]);

    const diff = await get<DiffEntry[]>(`/api/studies/${studyId}/versions/2/diff?against=1`);
    expect(diff).toContainEqual({
      path: "/invoiceables/0/amountWithOverheadCents",
      change: "changed",
      before: 80000,
      after: 90000,
      label: "Invoiceable › Unscheduled visit › Amount with overhead",
    });
    expect(diff).toContainEqual(expect.objectContaining({ path: "/appliesFrom/value", before: null, after: "2026-01-01" }));
    expect((await app.inject({ url: `/api/studies/${studyId}/versions/2/diff` })).statusCode).toBe(400);
    expect((await version(studyId, 2)).appliesFrom).toBe("2026-01-01");

    await resolveAll(studyId, 2);
    expect((await post(`/api/studies/${studyId}/versions/2/sign-off`, { by: "Ben" })).statusCode).toBe(200);
    s = await study(studyId);
    expect(s).toMatchObject({ status: "live", liveVersion: 2 });
    expect(s.versions.map((x) => [x.version, x.status])).toEqual([
      [2, "signed"],
      [1, "superseded"],
    ]);
  });
});

describe("audit log", () => {
  it("is append-only", async () => {
    const { studyId } = await newStudy();
    const entries = await get<AuditEntryDto[]>(`/api/audit?studyId=${studyId}`);
    expect(entries.length).toBeGreaterThan(0);
    await expect(built.ctx.db.execute(sql`UPDATE audit_log SET by = 'mallory'`)).rejects.toThrow();
    await expect(built.ctx.db.execute(sql`DELETE FROM audit_log`)).rejects.toThrow();
    expect(await get<AuditEntryDto[]>(`/api/audit?studyId=${studyId}`)).toEqual(entries);
  });
});
