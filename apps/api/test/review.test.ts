import type { AlertPage, AuditEntryDto, DiffEntry, MasterSearch, RulebookVersionDto, StudyDetailDto, StudyPage } from "@dct/shared";
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

const get = async <T>(url: string) => (await app.inject({ url: `/api/v1${url}` })).json<T>();
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url: `/api/v1${url}`, payload });
const version = (id: string, v = 1) => get<RulebookVersionDto>(`/studies/${id}/versions/${v}`);
const summary = async (id: string) => (await get<StudyPage>("/studies?limit=100")).items.find((s) => s.id === id)!;
const answer = async (id: string, item: string, body: object, v = 1) => {
  const res = await post(`/studies/${id}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RulebookVersionDto>().review.find((i) => i.id === item)!;
};

// The fake read on the text PDF (test/helpers.ts makeTextPdf): what the page doesn't print, and what has no quote to check.
const G2_TOTAL = "/budgetGrids/1/visits/1/totalCents"; // read 8,488.00, printed 8,489.00
const NET_DAYS = "/payment/netDays/value"; // read 45, no quote
const UNGROUNDED = ["/overhead/pct/value", NET_DAYS, "/deadlines/0/value"];

async function draft(seed = "s") {
  const { studyId, doc } = await newStudy(app, seed);
  expect((await extract(app, studyId)).job.state).toBe("succeeded");
  return { studyId, doc };
}

describe("reading checks every number against the PDF's own text", () => {
  it("a text PDF: evidence per value, the PDF check, and questions only for what didn't check out", async () => {
    const { studyId, doc } = await draft();
    expect(doc.text).toBe("text");
    const v = await version(studyId);
    expect(v.pdfCheck).toEqual({ values: 31, matched: 27 });
    expect(v.evidence.filter((e) => e.status !== "confirmed").map((e) => [e.path, e.status])).toEqual([[G2_TOTAL, "conflict"], ...UNGROUNDED.map((p) => [p, "ungrounded"])]);
    expect(v.evidence.find((e) => e.path === "/siteFees/0/amountCents")).toMatchObject({ status: "confirmed", printed: "$12,000.00", where: [{ documentId: doc.id, page: 1 }] });
    expect(v.review.map((i) => [i.reason, i.kind, i.blocking])).toEqual([
      ["VALUE_CONFLICT", "confirm_value", true],
      ...UNGROUNDED.map(() => ["UNGROUNDED_VALUE", "confirm_value", true]),
      ["UNACCOUNTED_TERM", "unaccounted", true], // parking at $12.00
      ["VISIT_TOTAL_MISMATCH", "contract_problem", true], // the printed totals don't add up: the contract itself is off
      ["MISSING_REFERENCED_DOC", "contract_problem", false],
      ["GRID_CONFLICT", "contract_problem", true],
    ]); // the second read's disagreement is not evidence, so it asks nothing
    expect(v.review.find((i) => i.reason === "GRID_CONFLICT")).toMatchObject({ path: "/governingGridId", options: [{ id: "g1", label: "Exhibit A" }, { id: "g2", label: "Exhibit A (revised)" }] });
    expect(await summary(studyId)).toMatchObject({ status: "needs_review", needsYou: 8 });
    expect((await get<StudyDetailDto>(`/studies/${studyId}`)).documents[0]!.text).toBe("text");
  });

  it("a scan: nothing is checked against text, so every number is typed and every page attested", async () => {
    const { studyId, doc } = await newStudy(app, "scan", { scan: true });
    expect(doc.text).toBe("scan");
    await extract(app, studyId);
    const v = await version(studyId);
    expect(v.pdfCheck).toBeNull();
    expect(v.evidence.every((e) => e.status === "ungrounded")).toBe(true); // this grid's totals don't add up to the cent
    const reasons = v.review.map((i) => i.reason);
    expect(reasons.filter((r) => r === "SCAN_VALUE")).toHaveLength(v.evidence.length);
    expect(v.review.filter((i) => i.reason === "SCAN_PAGE").map((i) => [i.kind, i.blocking, i.where[0]!.page, i.options.map((o) => o.id)])).toEqual([
      ["unaccounted", true, 1, ["none", "bill_by_hand"]],
      ["unaccounted", true, 2, ["none", "bill_by_hand"]],
    ]);
    expect(reasons).not.toContain("VISIT_TOTAL_MISMATCH"); // explained by the numbers being typed
  });
});

describe("blind entry", () => {
  it("the version never sends a hidden value, its printed text or quote, the checks' findings, or a comparison before an answer", async () => {
    const { studyId } = await draft();
    const stored = await storedVersion(built, studyId, 1);
    expect([at(stored.rulebook, G2_TOTAL), at(stored.rulebook, NET_DAYS)]).toEqual([848800, 45]);
    const raw = (await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body;
    const v = JSON.parse(raw) as RulebookVersionDto;
    for (const p of [G2_TOTAL, ...UNGROUNDED]) expect(at(v.rulebook, p), p).toBeNull();
    expect(at(v.rulebook, "/budgetGrids/0/visits/0/totalCents")).toBe(745500); // no open question: sent as is
    expect(v.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "conflict", printed: null });
    expect(v.anomalies).toEqual([]);
    expect(v.review.every((i) => i.compare === null && i.answer === null)).toBe(true);
    expect(raw).not.toMatch(/truth|secret|"apply"/);

    // Answered: the value is back. A differs answer shows the comparison, to that item only.
    await answer(studyId, `confirm:${G2_TOTAL}`, { value: 848900 });
    expect(at((await version(studyId)).rulebook, G2_TOTAL)).toBe(848900);
    const differs = await answer(studyId, `confirm:${NET_DAYS}`, { value: 30 });
    expect(differs.compare).toEqual({ typed: 30, read: 45, printed: null });
    expect(at((await version(studyId)).rulebook, NET_DAYS)).toBeNull(); // still open
  });

  it("searching a draft never finds a hidden value by amount or by a term's words; names still match", async () => {
    const { studyId } = await draft();
    const search = async (q: string) => (await get<MasterSearch>(`/studies/${studyId}/versions/1/search?q=${encodeURIComponent(q)}`)).hits.map((h) => h.path);
    expect(await search("8,488.00")).not.toContain("/budgetGrids/1/visits/1");
    expect(await search("payment")).not.toContain("/payment");
    expect(await search("blood")).toEqual(["/budgetGrids/0/procedures/0", "/budgetGrids/1/procedures/0"]);
    await settleAll(built, studyId, 1);
    expect(await search("payment")).toContain("/payment");
  });

  it("an amendment's diff and the audit log don't show it either", async () => {
    const { studyId } = await liveStudy(built);
    // The amendment reads the unscheduled visit with overhead as $900.00; the page prints $800.00.
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<{ id: string }[]>();
    await extract(app, studyId, { documentIds: [amend!.id] });
    const unsched = "/invoiceables/0/amountWithOverheadCents";
    expect((await version(studyId, 2)).review.map((i) => i.path)).toContain(unsched);
    const diff = async () => (await get<DiffEntry[]>(`/studies/${studyId}/versions/2/diff?against=1`)).map((e) => e.path);
    expect(await diff()).not.toContain(unsched);
    expect(await diff()).toContain("/appliesFrom/value");

    // Answered, sent back: the earlier answer stays out of the log while the question is open again.
    const item = `confirm:${unsched}`;
    await answer(studyId, item, { value: 80000 }, 2);
    const logged = async () => (await get<AuditEntryDto[]>(`/audit?studyId=${studyId}`)).find((e) => e.action === "review.answered" && e.detail.path === unsched)!.detail;
    expect(await logged()).toMatchObject({ before: 90000, after: 80000 });
    expect((await post(`/studies/${studyId}/versions/2/send-back`, { itemIds: [item], note: "look again", by: "Morgan" })).statusCode).toBe(200);
    expect(await logged()).not.toHaveProperty("before");
    expect(await logged()).not.toHaveProperty("after");
    expect(await diff()).not.toContain(unsched);
  });
});

describe("answering", () => {
  it("matches, differs, then settles (a note only to keep your own value over the PDF text); answers can change; options are chosen", async () => {
    const { studyId } = await draft();
    // The PDF prints 8,489.00 where the read has 8,488.00: typing what the page says matches its text.
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 848900 })).toMatchObject({ outcome: "matched", compare: null, answer: { value: 848900, by: "Sam" } });
    let stored = await storedVersion(built, studyId, 1);
    expect(at(stored.rulebook, G2_TOTAL)).toBe(848900);
    expect(stored.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "attested", note: "Typed by Sam" });

    // Changing it: checked again, now against the PDF text; keeping your own over it needs a note.
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 849000 })).toMatchObject({ outcome: "differs", compare: { typed: 849000, read: 848900, printed: "8,489.00" } });
    const noNote = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, { value: 849000, by: "Sam" });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().message).toBe("Add a short note saying why the PDF text is wrong here.");
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 849000, note: "Exhibit prints a correction in ink" })).toMatchObject({ outcome: "chosen", compare: null });

    // Nothing printed to check against: compared with the value read, and settling needs no note.
    expect(await answer(studyId, `confirm:${NET_DAYS}`, { value: 30 })).toMatchObject({ outcome: "differs", compare: { typed: 30, read: 45, printed: null } });
    expect(await answer(studyId, `confirm:${NET_DAYS}`, { value: 30 })).toMatchObject({ outcome: "chosen" });
    expect(await answer(studyId, "confirm:/overhead/pct/value", { value: 40 })).toMatchObject({ outcome: "matched" });

    // Options: picked, and the pick is applied.
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent("anomaly:GRID_CONFLICT:/budgetGrids/0")}`, { optionId: "nope", by: "Sam" })).statusCode).toBe(400);
    expect(await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { optionId: "g2" })).toMatchObject({ outcome: "chosen" });
    expect(await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { cantTell: true, note: "ask legal" })).toMatchObject({ outcome: "cant_tell" });
    stored = await storedVersion(built, studyId, 1);
    expect([stored.rulebook!.governingGridId, at(stored.rulebook, NET_DAYS)]).toEqual(["g2", 30]);
    expect(stored.editors).toEqual(["Sam"]);
    const log = (await get<AuditEntryDto[]>(`/audit?studyId=${studyId}`)).filter((e) => e.action.startsWith("review."));
    // newest first; settling a "differs" is the first settled answer, not a change
    expect(log.map((e) => [e.action, e.detail.outcome])).toEqual([
      ["review.answered", "cant tell"],
      ["review.answered", "chosen"],
      ["review.answered", "matched"],
      ["review.answered", "chosen"],
      ["review.answered", "differs"],
      ["review.answered", "chosen"],
      ["review.changed", "differs"],
      ["review.answered", "matched"],
    ]);
    expect(log[1]!.detail).toMatchObject({ gridId: "g2" });
  });

  it("refuses what isn't an answer", async () => {
    const { studyId } = await draft();
    const url = (item: string) => `/studies/${studyId}/versions/1/review/${encodeURIComponent(item)}`;
    expect((await post(url("nope"), { value: 1, by: "Sam" })).statusCode).toBe(404);
    expect((await post(url(`confirm:${G2_TOTAL}`), { value: 1 })).json().message).toBe("Say who is answering.");
    expect((await post(url(`confirm:${G2_TOTAL}`), { by: "Sam" })).json().message).toBe("Type a value, or say you can't tell.");
    expect((await post(url(`confirm:${G2_TOTAL}`), { value: "abc", by: "Sam" })).statusCode).toBe(400); // not cents
    expect((await post(url(`confirm:${G2_TOTAL}`), { value: 12.5, by: "Sam" })).statusCode).toBe(400);
    expect((await storedVersion(built, studyId, 1)).review.every((i) => i.outcome === null)).toBe(true);
  });

  it("refuses approval while blocking questions are unsettled, then applies maker-checker", async () => {
    const { studyId } = await draft();
    const signOff = (by: string) => post(`/studies/${studyId}/versions/1/sign-off`, { by });
    const blocked = await signOff("Morgan");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toBe("7 questions still need an answer before this can be approved.");
    // A non-blocking question left for the approver doesn't hold approval up; a blocking "can't tell" does.
    await settleAll(built, studyId, 1, "Sam");
    await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { cantTell: true });
    expect((await signOff("Morgan")).json().message).toBe("1 question still needs an answer before this can be approved.");
    await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { optionId: "g1" });
    await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { cantTell: true });
    expect(await summary(studyId)).toMatchObject({ needsYou: 0 });

    await patch("/settings", { makerChecker: true, by: "Morgan" });
    expect((await signOff("Sam")).json().message).toBe("Maker-checker is on: Sam answered questions on this contract, so someone else has to approve it.");
    expect((await signOff("Morgan")).statusCode).toBe(200);
    expect(await get<StudyDetailDto>(`/studies/${studyId}`)).toMatchObject({ status: "live", liveVersion: 1, needsYou: 0 });
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, { value: 1, by: "Sam" })).json().message).toBe(
      "Version 1 is signed; only a draft takes answers.",
    );
  });
});

describe("“This looks wrong”", () => {
  it("on a draft adds a blocking blind question and sends an approval-ready study back to Needs you", async () => {
    const { studyId } = await draft();
    await settleAll(built, studyId, 1);
    expect(await summary(studyId)).toMatchObject({ needsYou: 0 });
    const url = `/studies/${studyId}/versions/1/report`;
    const res = await post(url, { path: NET_DAYS, note: "Sponsor pays in 45 days", by: "Sam" });
    expect(res.statusCode).toBe(200);
    const v = res.json<RulebookVersionDto>();
    expect(v.review.at(-1)).toMatchObject({ kind: "confirm_value", reason: "reported", blocking: true, input: "number", path: NET_DAYS, answer: null, compare: null, question: "What value is printed for Payment › Net days?" });
    expect(at(v.rulebook, NET_DAYS)).toBeNull();
    expect(await summary(studyId)).toMatchObject({ needsYou: 1 });
    expect((await post(url, { path: NET_DAYS, note: "again", by: "Sam" })).statusCode).toBe(409);
    expect((await post(url, { path: "/budgetGrids/0", note: "whole grid", by: "Sam" })).statusCode).toBe(400);
    expect((await post(url, { path: NET_DAYS, by: "Sam" })).json().message).toBe("Add a short note and say who is reporting.");
  });

  it("on the live version opens a correction draft; the live version stays live until it's approved", async () => {
    const { studyId } = await liveStudy(built);
    const cell = "/budgetGrids/0/procedures/0/cells/V2";
    const res = await post(`/studies/${studyId}/versions/1/report`, { path: cell, note: "Should be $56", by: "Sam" });
    const v2 = res.json<RulebookVersionDto>();
    expect(v2).toMatchObject({ version: 2, status: "draft", byHand: false, editors: [] });
    expect(v2.review).toHaveLength(1);
    expect(v2.review[0]!.question).toMatch(/^What amount is printed for /);
    expect(at(v2.rulebook, cell)).toBeNull();
    expect(at((await version(studyId, 1)).rulebook, cell)).toBe(5500); // the live version is never withheld
    expect(await get<StudyDetailDto>(`/studies/${studyId}`)).toMatchObject({ status: "amendment_in_review", liveVersion: 1, needsYou: 1 });
    const audit = await get<AuditEntryDto[]>(`/audit?studyId=${studyId}`);
    expect(audit[0]).toMatchObject({ action: "number.reported", by: "Sam", detail: { version: 2, note: "Should be $56" } });
    // Only the newest version can be reported on now.
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: NET_DAYS, note: "x", by: "Sam" })).json().message).toBe("Version 2 is already in progress. Report it there.");

    // Matches the PDF text, approved: v2 is live with the same numbers.
    expect(await answer(studyId, v2.review[0]!.id, { value: 5500 }, 2)).toMatchObject({ outcome: "matched" });
    expect((await post(`/studies/${studyId}/versions/2/sign-off`, { by: "Ben" })).statusCode).toBe(200);
    expect((await get<StudyDetailDto>(`/studies/${studyId}`)).versions.map((x) => [x.version, x.status])).toEqual([[2, "signed"], [1, "superseded"]]);
  });
});

describe("proofreading", () => {
  it("marks values on a live version without changing its numbers; never on a superseded one", async () => {
    const { studyId } = await liveStudy(built);
    const before = await version(studyId);
    const paths = ["/budgetGrids/0/procedures/0/cells/V1", "/siteFees/0/amountCents"];
    const res = await post(`/studies/${studyId}/versions/1/proofread`, { paths, by: "Avery" });
    expect(res.statusCode).toBe(200);
    const after = res.json<RulebookVersionDto>();
    expect(after.proofread.map((m) => [m.path, m.by])).toEqual(paths.map((p) => [p, "Avery"]));
    expect(after.rulebook).toEqual(before.rulebook);
    // marking again keeps one mark per value, the latest
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { paths: [paths[0]], by: "Sam" })).json<RulebookVersionDto>().proofread.map((m) => [m.path, m.by])).toEqual([
      [paths[0], "Sam"],
      [paths[1], "Avery"],
    ]);
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { paths: ["/nope"], by: "Avery" })).statusCode).toBe(400);
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { paths: [], by: "Avery" })).statusCode).toBe(400);

    const v2 = (await post(`/studies/${studyId}/versions/1/report`, { path: paths[1], note: "x", by: "Sam" })).json<RulebookVersionDto>();
    await answer(studyId, v2.review[0]!.id, { value: 1200000 }, 2);
    await post(`/studies/${studyId}/versions/2/sign-off`, { by: "Ben" });
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { paths, by: "Avery" })).json().message).toBe("Version 1 can't be proofread.");
  });
});

describe("send back", () => {
  it("reopens answers blind with the note, turns their evidence back to conflict, and raises sent_back alone", async () => {
    const { studyId } = await draft();
    await settleAll(built, studyId, 1);
    const alerts = async () => (await get<AlertPage>("/alerts?for=Avery&limit=50")).items;
    const seen = (await alerts()).length;
    const ids = [`confirm:${G2_TOTAL}`, "anomaly:GRID_CONFLICT:/budgetGrids/0"];
    const res = await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ids, note: "Check page 2", by: "Morgan" });
    expect(res.statusCode).toBe(200);
    const v = res.json<RulebookVersionDto>();
    for (const id of ids) expect(v.review.find((i) => i.id === id)).toMatchObject({ outcome: null, answer: null, compare: null, sentBack: { by: "Morgan", note: "Check page 2" } });
    expect(v.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "conflict", note: "Sent back by Morgan", printed: null });
    expect(at(v.rulebook, G2_TOTAL)).toBeNull();
    expect(await summary(studyId)).toMatchObject({ needsYou: 2 });
    const raised = (await alerts()).slice(0, (await alerts()).length - seen);
    expect(raised).toEqual([expect.objectContaining({ kind: "sent_back", count: 2, note: "Check page 2", by: "Morgan" })]);
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ids, note: "again", by: "Morgan" })).json().message).toBe("Only answered questions can be sent back.");
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ids, by: "Morgan" })).statusCode).toBe(400);
    // Answered again, blind, it settles and the note is cleared.
    expect(await answer(studyId, ids[0]!, { value: 848900 })).toMatchObject({ outcome: "matched", sentBack: null });
  });
});

describe("typing in by hand", () => {
  async function failed() {
    const { studyId } = await newStudy(app, "solace", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    return studyId;
  }

  it("types a contract in by hand, then someone else re-types a blind sample", async () => {
    const studyId = await failed();
    const start = await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" });
    expect(start.statusCode).toBe(201);
    const v0 = start.json<RulebookVersionDto>();
    expect(v0).toMatchObject({ version: 1, status: "draft", byHand: true, evidence: [], review: [], cost: { usd: 0 } }); // replaces the failed read
    expect(await summary(studyId)).toMatchObject({ status: "needs_review", needsYou: 1 });
    expect((await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" })).statusCode).toBe(409);

    const type = async (path: string, value: unknown) => {
      const r = await patch(`/studies/${studyId}/versions/1/values`, { path, value, note: "Typed by hand", by: "Avery" });
      expect(r.statusCode, `${path}: ${r.body}`).toBe(200);
      return r.json<RulebookVersionDto>();
    };
    const row = v0.rulebook!.budgetGrids[0]!.procedures[0]!;
    await type(NET_DAYS, 45);
    await type("/budgetGrids/0/procedures", [row, row]);
    await type("/budgetGrids/0/procedures/0/name", "Blood draw");
    await type("/budgetGrids/0/procedures/1/name", "ECG");
    let v = await type("/budgetGrids/0/procedures/1/cells/V1", 7600);
    expect(v.evidence.find((e) => e.path === "/budgetGrids/0/procedures/1/cells/V1")).toMatchObject({ status: "attested", note: "Typed by hand by Avery" });
    // Removing row 0 moves row 1's typed values up.
    v = await type("/budgetGrids/0/procedures", [v.rulebook!.budgetGrids[0]!.procedures[1]!]);
    expect(v.evidence.map((e) => e.path).sort()).toEqual(["/budgetGrids/0/procedures/0/cells/V1", "/budgetGrids/0/procedures/0/name", NET_DAYS]);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/budgetGrids/0/visits/0/totalCents", value: null, note: "x", by: "Avery" })).statusCode).toBe(400);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/nope", value: 1, note: "x", by: "Avery" })).statusCode).toBe(400);
    expect(v.editors).toEqual(["Avery"]);
    expect((await post(`/studies/${studyId}/versions/1/sign-off`, { by: "Ben" })).json().message).toMatch(/^Typing isn't marked done yet/);

    // 3 typed values → all 3 are re-typed.
    v = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).json<RulebookVersionDto>();
    expect(v.review).toHaveLength(3);
    expect(v.review.every((i) => i.reason === "spot_check" && i.blocking && i.answer === null)).toBe(true);
    expect(v.review.every((i) => i.path && at(v.rulebook, i.path) === null)).toBe(true); // blind
    expect((await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).statusCode).toBe(409);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: NET_DAYS, value: 30, note: "x", by: "Avery" })).json().message).toBe("Typing is marked done. Use “This looks wrong” to change a value.");
    const days = v.review.find((i) => i.path === NET_DAYS)!;
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(days.id)}`, { value: 45, by: "Avery" })).json().message).toBe("Avery typed these values, so someone else has to re-type them.");
    expect(await answer(studyId, days.id, { value: 40 })).toMatchObject({ outcome: "differs", compare: { typed: 40, read: 45, printed: null } });
    expect(await answer(studyId, days.id, { value: 45 })).toMatchObject({ outcome: "chosen" });
    await settleAll(built, studyId, 1, "Sam");
    // Re-typing isn't editing: with maker-checker on, the re-typer may approve and the typist may not.
    await patch("/settings", { makerChecker: true, by: "Morgan" });
    expect((await post(`/studies/${studyId}/versions/1/sign-off`, { by: "Avery" })).statusCode).toBe(409);
    expect((await post(`/studies/${studyId}/versions/1/sign-off`, { by: "Sam" })).statusCode).toBe(200);
  });

  it("re-types at most 10 hand-typed values", async () => {
    const studyId = await failed();
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Avery" });
    const type = async (path: string, value: unknown) => (await patch(`/studies/${studyId}/versions/1/values`, { path, value, note: "x", by: "Avery" })).json<RulebookVersionDto>();
    const blank = { code: null, name: "", amountCents: null, amountWithOverheadCents: null, basis: "fixed", frequency: "", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov: { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } };
    for (let i = 0; i < 4; i++) {
      const rb = (await type(NET_DAYS, null)).rulebook!;
      await type("/invoiceables", [...rb.invoiceables, blank]);
      for (const k of ["name", "amountCents", "amountWithOverheadCents"]) await type(`/invoiceables/${i}/${k}`, k === "name" ? `Item ${i}` : 1000 * (i + 1));
    }
    const v = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).json<RulebookVersionDto>();
    expect(v.evidence).toHaveLength(12);
    expect(v.review).toHaveLength(10);
  });

  it("refuses typing on a draft that isn't typed by hand, and a blank start while one is in progress", async () => {
    const { studyId } = await draft();
    const res = await patch(`/studies/${studyId}/versions/1/values`, { path: NET_DAYS, value: 30, note: "x", by: "Sam" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("Values can only be typed on a contract being typed in by hand. Use “This looks wrong” instead.");
    expect((await post(`/studies/${studyId}/versions/by-hand`, { by: "Sam" })).json().message).toBe("Version 1 is already in progress.");
    expect((await post(`/studies/${studyId}/versions/by-hand`, {})).statusCode).toBe(400);
  });
});
