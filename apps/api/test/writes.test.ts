import { type AuditPage, type DocumentDto, type RulebookVersionDto, type StudyDetailDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockStudy } from "../src/domain.js";
import { fakeControls } from "../src/extraction/fake.js";
import { type App, type Built, extract, makeBudgetXlsx, makeTextPdf, multipart, newStudy, resetDb, signOff, storedVersion, testApp, until, upload, waitJob } from "./helpers.js";

// Write routes from the audit of 2026-11-01: nothing left out silently, nothing logged that didn't change, every 400 in
// words. Each `it` failed before its fix.

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());
beforeEach(async () => {
  fakeControls.failNext = 0;
  fakeControls.hold = null;
  await resetDb(built);
});

const get = async <T>(url: string) => (await app.inject({ url: `/api/v1${url}` })).json<T>();
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url: `/api/v1${url}`, payload });
const auditOf = async (studyId: string) => (await get<AuditPage>(`/audit?studyId=${studyId}&limit=100`)).items;
const count = async (action: string) => (await built.ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`)).rows[0]!.n;
const G2_TOTAL = "/budgetGrids/1/visits/1/totalCents"; // read 8,488.00, printed 8,489.00 (test/helpers.ts makeTextPdf)
const budgetCheck = async (studyId: string, data: Buffer, by = "Sam") => {
  const { payload, headers } = await multipart([{ name: "Ex A-1.xlsx", data }], { by });
  return app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/versions/1/budget-check`, payload, headers });
};

describe("a file added while the contract is being read", () => {
  it("is refused before it's linked, so it isn't left out of the read silently; asking again without it returns the running read", async () => {
    const { studyId, doc } = await newStudy(app, "running");
    let go!: () => void;
    fakeControls.hold = new Promise((r) => (go = r));
    const first = (await post(`/studies/${studyId}/extract`, {})).json<{ jobId: string; version: number }>();
    await until(async () => (await get<{ state: string }>(`/jobs/${first.jobId}`)).state === "running", "the read to start");
    const [late] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makeTextPdf("late") }])).json<DocumentDto[]>();

    const added = await post(`/studies/${studyId}/extract`, { documentIds: [late!.id], by: "Asha" });
    expect(added.json()).toMatchObject({
      statusCode: 409,
      message: "This contract is being read right now, so a file added now would be left out of that read. Wait until the read finishes, then add the file.",
    });
    expect((await get<StudyDetailDto>(`/studies/${studyId}`)).documents.map((d) => d.id)).toEqual([doc.id]);
    // nothing new: the same read, nothing logged
    for (const body of [{}, { documentIds: [doc.id] }]) expect((await post(`/studies/${studyId}/extract`, body)).json()).toEqual(first);
    expect(await count("extraction.queued")).toBe(1);
    go();
    await waitJob(app, first.jobId);
  });
});

describe("the budget spreadsheet check", () => {
  it("a check made before an answer changed a price says to check again, never that it matched", async () => {
    const { studyId } = await newStudy(app, "stale");
    await extract(app, studyId);
    expect((await budgetCheck(studyId, await makeBudgetXlsx())).json<RulebookVersionDto>().warnings.filter((w) => w.includes("matches"))).toHaveLength(1);
    const res = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, { value: 848900, note: "as printed", by: "Sam" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<RulebookVersionDto>().warnings.filter((w) => w.startsWith("The sponsor's budget spreadsheet"))).toEqual([
      "The sponsor's budget spreadsheet was checked before the invoicing master changed, so that check no longer holds: check the spreadsheet again.",
    ]);
  });

  it("refuses a nameless check, and a spreadsheet that unpacks past the limit, in words", async () => {
    const { studyId } = await newStudy(app, "big");
    await extract(app, studyId);
    expect((await budgetCheck(studyId, await makeBudgetXlsx(), "   ")).json()).toMatchObject({ statusCode: 400, message: "Say who is checking." });
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("USA").getCell("A1").value = "x".repeat(26 * 1024 * 1024);
    expect((await budgetCheck(studyId, Buffer.from(await wb.xlsx.writeBuffer()))).json()).toMatchObject({
      statusCode: 413,
      message: "Ex A-1.xlsx is too big to check: it unpacks to more than 25 MB. Save a copy with only the budget sheet and check that.",
    });
  });
});

describe("typing by hand", () => {
  it("keeps the typed value's note in its log entry, and a name typed differently is one editor", async () => {
    const { studyId } = await newStudy(app, "hand", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    expect((await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" })).statusCode).toBe(201);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 45, note: "§4.2 says 45 days", by: "Avery" })).statusCode).toBe(200);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 30, note: "amended", by: " avery " })).statusCode).toBe(200);
    expect((await storedVersion(built, studyId, 1)).editors).toEqual(["Avery"]);
    expect((await auditOf(studyId)).filter((e) => e.action === "value.typed").map((e) => e.detail.note)).toEqual(["amended", "§4.2 says 45 days"]);
  });
});

describe("repeats that change nothing", () => {
  it("confirming a study's details again as they are writes and logs nothing; confirming the read's guess is logged once", async () => {
    const { studyId } = await newStudy(app, "confirm");
    // the identify guess, confirmed as it is: a person vouched for it
    const details = { sponsor: "Synthetic Pharma", protocol: "SYN-001", siteName: "Site A", investigator: "Dr. Test", by: "Asha" };
    const first = (await patch(`/studies/${studyId}`, details)).json<StudyDetailDto>();
    expect(await count("study.confirmed")).toBe(1);
    const again = await patch(`/studies/${studyId}`, { ...details, by: "Ben" });
    expect(again.statusCode).toBe(200);
    expect(again.json<StudyDetailDto>().updatedAt).toBe(first.updatedAt);
    expect(await count("study.confirmed")).toBe(1);
  });
});

describe("who changed it", () => {
  it("settings can't be changed without a name, so turning maker-checker off is never logged as the system", async () => {
    expect((await patch("/settings", { makerChecker: false })).json()).toMatchObject({ statusCode: 400, message: "Say who is changing the settings." });
    expect((await patch("/settings", { makerChecker: false, by: " " })).statusCode).toBe(400);
    expect(await count("settings.updated")).toBe(0);
  });

  it("every 400 names the problem in words", async () => {
    const { studyId, doc } = await newStudy(app, "words");
    const words = async (url: string, body: object, method: "POST" | "PATCH" = "POST") => (await app.inject({ method, url: `/api/v1${url}`, payload: body })).json<{ message: string }>().message;
    expect(await words("/studies", { documentIds: [] })).toBe("Pick the contract's files (up to 50).");
    expect(await words(`/studies/${studyId}`, { sponsor: "S", protocol: "P", siteName: "A", investigator: "I" }, "PATCH")).toBe("Say who is confirming the details.");
    expect(await words(`/studies/${studyId}/extract`, { documentIds: "x" })).toBe("Pick the files to add (up to 50).");
    expect(await words(`/documents/${doc.id}`, { kind: "letter", by: "Asha" }, "PATCH")).toBe("Pick what kind of document this is.");
    expect(await words("/alerts/read", {})).toBe("Say who is reading the alerts.");
    expect((await signOff(app, studyId, 1, { by: "", asOf: "x" })).json().message).toBe("Say who is approving.");
    expect(await words(`/studies/${studyId}/versions/1/sign-off`, { by: "Ben" })).toBe("Reload the page and approve again: it didn't say which version you saw.");
  });
});

describe("files", () => {
  it("identify never overwrites a kind a person set, on a file another study shares", async () => {
    const [master] = (await upload(app, [{ name: "Master agreement.pdf", data: await makeTextPdf("msa") }])).json<DocumentDto[]>();
    const one = (await post("/studies", { documentIds: [master!.id] })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, one.jobId);
    expect((await patch(`/documents/${master!.id}`, { kind: "other", by: "Asha" })).statusCode).toBe(200);
    // a second study sharing it: the read's guess (a master agreement, by its name) doesn't replace the person's "other"
    const [wo] = (await upload(app, [{ name: "Work Order.pdf", data: await makeTextPdf("wo") }])).json<DocumentDto[]>();
    const two = (await post("/studies", { documentIds: [wo!.id, master!.id] })).json<{ studyId: string; jobId: string }>();
    expect((await waitJob(app, two.jobId)).state).toBe("succeeded");
    expect((await get<StudyDetailDto>(`/studies/${two.studyId}`)).documents.find((d) => d.id === master!.id)!.kind).toBe("other");
  });

  it("a shared file's kind waits for each study's lock before it logs on that study", async () => {
    const { studyId, doc } = await newStudy(app, "locked");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = built.ctx.db.transaction(async (tx) => {
      await lockStudy(tx, studyId);
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const res = patch(`/documents/${doc.id}`, { kind: "amendment", by: "Asha" }).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await res).statusCode).toBe(200);
    expect(await count("document.kind_set")).toBe(1);
  });
});
