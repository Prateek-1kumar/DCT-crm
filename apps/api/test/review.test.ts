import { type AlertPage, type AuditPage, type DiffEntry, type MasterSearch, type RulebookVersionDto, type StudyDetailDto, type StudyPage } from "@dct/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeControls } from "../src/extraction/fake.js";
import { at } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makeBudgetXlsx, makePdf, multipart, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload } from "./helpers.js";

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
const auditOf = async (id: string, q = "") => (await get<AuditPage>(`/audit?studyId=${id}&limit=100${q && `&q=${encodeURIComponent(q)}`}`)).items;
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
/**
 * What every read of the fake work order asks a person to pick (ADR-001 §6), in the order it asks. Not rounding: the work
 * order never mentions it, so it's a notice (owner, 2026-11-02).
 */
const INTERPRETED = ["/overhead/appliesTo/value", "/payment/visitPayment/value", "/screenFail/basis", "/screenFail/cap/kind", "/screenFail/paidVia"];
/** The screen-fail basis, cap and how it's paid quote one sentence: one card in needs you (cards). */
const ONE_CARD = 2;

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
    // 36 values: the amounts, and the effective date, the fee's due days, the screen-fail cap and each grid's overhead %
    expect(v.pdfCheck).toEqual({ values: 36, matched: 32 });
    expect(v.evidence.filter((e) => e.status !== "confirmed").map((e) => [e.path, e.status])).toEqual([[G2_TOTAL, "conflict"], ...UNGROUNDED.map((p) => [p, "ungrounded"])]);
    expect(v.evidence.find((e) => e.path === "/siteFees/0/amountCents")).toMatchObject({ status: "confirmed", printed: "$12,000.00", where: [{ documentId: doc.id, page: 1 }] });
    expect(v.review.map((i) => [i.reason, i.kind, i.blocking])).toEqual([
      ["VALUE_CONFLICT", "confirm_value", true],
      ...UNGROUNDED.map(() => ["UNGROUNDED_VALUE", "confirm_value", true]),
      ["UNACCOUNTED_TERM", "unaccounted", true], // parking at $12.00
      ["VISIT_TOTAL_MISMATCH", "contract_problem", false], // the printed totals don't add up: the contract itself is off (a Review question)
      ["MISSING_REFERENCED_DOC", "contract_problem", false],
      ["GRID_CONFLICT", "contract_problem", true],
      ...INTERPRETED.map(() => ["INTERPRETATION", "interpretation", true]),
    ]); // the second read's disagreement is not evidence, so it asks nothing
    expect(v.review.filter((i) => i.kind === "interpretation").map((i) => i.path)).toEqual(INTERPRETED);
    expect(v.review.find((i) => i.reason === "GRID_CONFLICT")).toMatchObject({ path: null, options: [{ id: "g1", label: "Exhibit A" }, { id: "g2", label: "Exhibit A (revised)" }] });
    // which number governs, and a note for the sponsor query (ADR-001 §6)
    expect(v.review.find((i) => i.reason === "VISIT_TOTAL_MISMATCH")!.options).toEqual([
      { id: "printed", label: "The visit total as printed", note: "What should we ask the sponsor?" },
      { id: "sum", label: "Its subtotal, overhead and non-procedure amounts added up", note: "What should we ask the sponsor?" },
    ]);
    expect(await summary(studyId)).toMatchObject({ status: "needs_review", needsYou: 8 + INTERPRETED.length - ONE_CARD });
    expect((await get<StudyDetailDto>(`/studies/${studyId}`)).documents[0]!.text).toBe("text");
  });

  it("a scan: nothing is checked against text, so every number the contract's own sums don't prove is typed and every page attested", async () => {
    const { studyId, doc } = await newStudy(app, "scan", { scan: true });
    expect(doc.text).toBe("scan");
    await extract(app, studyId);
    const v = await version(studyId);
    expect(v.pdfCheck).toBeNull();
    // ADR-002 PR 2: the solver proves a grid value (strict, the default: a cell needs a row and a column) or an invoiceable's price and price with overhead that take part in an identity that balances; a rule, cap, date, site fee or deadline is never proved by arithmetic
    const math = v.evidence.filter((e) => e.status === "confirmed_by_math");
    expect(math.length).toBeGreaterThan(0);
    expect(math.every((e) => /^\/budgetGrids\/|^\/invoiceables\/\d+\/amount(WithOverhead)?Cents$/.test(e.path))).toBe(true);
    expect(v.evidence.filter((e) => e.status !== "confirmed_by_math").every((e) => e.status === "ungrounded")).toBe(true);
    const reasons = v.review.map((i) => i.reason);
    // every number it didn't prove but the screen-fail cap's limit, which waits for its kind to be picked (its question would name it)
    expect(v.review.filter((i) => i.reason === "SCAN_VALUE").map((i) => i.path)).toEqual(v.evidence.filter((e) => e.status === "ungrounded").map((e) => e.path).filter((p) => p !== "/screenFail/cap/n"));
    expect(reasons).not.toContain("SAMPLE"); // no blind sample (ADR-003)
    expect(v.review.filter((i) => i.reason === "SCAN_PAGE").map((i) => [i.kind, i.blocking, i.where[0]!.page, i.options.map((o) => o.id)])).toEqual([
      ["unaccounted", true, 1, ["none", "bill_by_hand"]],
      ["unaccounted", true, 2, ["none", "bill_by_hand"]],
    ]);
    expect(reasons).not.toContain("VISIT_TOTAL_MISMATCH"); // explained by the numbers being typed
  });
});

describe("nothing withheld (ADR-003)", () => {
  it("a value with an open question is in the version, with its printed text and the checks' findings, and search finds it", async () => {
    const { studyId } = await draft();
    const v = await version(studyId);
    expect(v.review.some((i) => i.path === G2_TOTAL && i.outcome === null)).toBe(true);
    expect(at(v.rulebook, G2_TOTAL)).toBe(848800);
    expect(v.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "conflict", printed: expect.stringContaining("8,489.00") });
    expect(v.anomalies.length).toBeGreaterThan(0);
    const search = async (q: string) => (await get<MasterSearch>(`/studies/${studyId}/versions/1/search?q=${encodeURIComponent(q)}`)).hits.map((h) => h.path);
    expect(await search("8,488.00")).toContain("/budgetGrids/1/visits/1");
  });
});


describe("answering", () => {
  it("matches, differs, then settles (a note only to keep your own value over the PDF text); answers can change; options are chosen", async () => {
    const { studyId } = await draft();
    // The PDF prints 8,489.00 where the read has 8,488.00: typing what the page says matches its text.
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 848900 })).toMatchObject({ outcome: "matched", compare: null, answer: { by: "Sam" } });
    let stored = await storedVersion(built, studyId, 1);
    expect(at(stored.rulebook, G2_TOTAL)).toBe(848900);
    expect(stored.review.find((i) => i.id === `confirm:${G2_TOTAL}`)!.answer).toMatchObject({ value: 848900 });
    expect(stored.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "attested", note: "Typed by Sam" });

    // Changing it: checked again, now against the PDF text; keeping your own over it needs a note.
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 849000 })).toMatchObject({ outcome: "differs", compare: { typed: 849000, read: 848900, printed: "8,489.00" } });
    const noNote = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, { value: 849000, by: "Sam" });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().message).toBe("Add a short note saying why the PDF text is wrong here.");
    expect(await answer(studyId, `confirm:${G2_TOTAL}`, { value: 849000, note: "Exhibit prints a correction in ink" })).toMatchObject({ outcome: "chosen", compare: null });

    // Nothing printed to check against: compared with the value read; settling with either value needs a note saying
    // where the page prints it, and the answer is marked for the approver.
    expect(await answer(studyId, `confirm:${NET_DAYS}`, { value: 30 })).toMatchObject({ outcome: "differs", compare: { typed: 30, read: 45, printed: null } });
    for (const value of [30, 45]) {
      const noNote = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${NET_DAYS}`)}`, { value, note: " ", by: "Sam" });
      expect(noNote.statusCode).toBe(400);
      expect(noNote.json().message).toBe("Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note.");
    }
    expect(await answer(studyId, `confirm:${NET_DAYS}`, { value: 30, note: "§4.2, page 1, second line" })).toMatchObject({
      outcome: "chosen",
      answer: { value: 30, note: "§4.2, page 1, second line", noPdfText: true, by: "Sam" },
    });
    // where the PDF text decided it, or nothing differed, the answer isn't marked
    expect((await version(studyId)).review.find((i) => i.id === `confirm:${G2_TOTAL}`)!.answer).not.toHaveProperty("noPdfText");
    expect(await answer(studyId, "confirm:/overhead/pct/value", { value: 40 })).toMatchObject({ outcome: "matched" });

    // Options: picked, and the pick is applied.
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent("anomaly:GRID_CONFLICT:/budgetGrids/0")}`, { optionId: "nope", by: "Sam" })).statusCode).toBe(400);
    expect(await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { optionId: "g2" })).toMatchObject({ outcome: "chosen" });
    expect(await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { cantTell: true, note: "ask legal" })).toMatchObject({ outcome: "cant_tell" });
    stored = await storedVersion(built, studyId, 1);
    expect([stored.rulebook!.governingGridIds, at(stored.rulebook, NET_DAYS)]).toEqual([["g2"], 30]);
    expect(stored.editors).toEqual(["Sam"]);
    const log = (await auditOf(studyId)).filter((e) => e.action.startsWith("review."));
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

  it("a total that stops adding up once the page's numbers are typed is asked, and holds approval until it's settled", async () => {
    const { studyId } = await draft();
    // Exhibit A (revised) reads its Week 0 total as 8,488.00, which its parts add up to; the page prints 8,489.00.
    await settleAll(built, studyId, 1);
    expect((await version(studyId)).review.map((i) => i.id)).not.toContain(`anomaly:VISIT_TOTAL_MISMATCH:${G2_TOTAL}`);
    await answer(studyId, `confirm:${G2_TOTAL}`, { value: 848900 });
    const v = await version(studyId);
    expect(v.review.find((i) => i.id === `anomaly:VISIT_TOTAL_MISMATCH:${G2_TOTAL}`)).toMatchObject({ kind: "contract_problem", blocking: false, outcome: null, options: [{ id: "printed" }, { id: "sum" }] });
    expect(await summary(studyId)).toMatchObject({ needsYou: 1 });
    // not needed to approve is still needed: approval takes every question settled (ADR-001 §6)
    expect((await signOff(app, studyId, 1, { by: "Ben" })).json().message).toBe("1 question still needs an answer before this can be approved.");
    await answer(studyId, `anomaly:VISIT_TOTAL_MISMATCH:${G2_TOTAL}`, { optionId: "printed", note: "Query the total" });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("a typed date is checked against the date the PDF prints, however it's written", async () => {
    const { studyId } = await draft();
    const path = "/study/effectiveDate/value";
    expect((await storedVersion(built, studyId, 1)).evidence.find((e) => e.path === path)).toMatchObject({ status: "confirmed", printed: "August 22, 2025" });
    // "This looks wrong" on it asks it blind
    expect((await post(`/studies/${studyId}/versions/1/report`, { path, note: "check the date", by: "Ben" })).statusCode).toBe(200);
    const id = (await version(studyId)).review.find((i) => i.reason === "reported" && i.path === path)!.id;
    expect((await version(studyId)).review.find((i) => i.id === id)!.input).toBe("date");
    // a day off: the PDF's text says otherwise, so keeping it needs a reason, and it isn't marked as missing from the text
    expect(await answer(studyId, id, { value: "2025-08-23" })).toMatchObject({ outcome: "differs", compare: { typed: "2025-08-23", read: "2025-08-22", printed: "August 22, 2025" } });
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(id)}`, { value: "2025-08-23", by: "Sam" })).json().message).toBe("Add a short note saying why the PDF text is wrong here.");
    const settledDate = await answer(studyId, id, { value: "2025-08-22" });
    expect(settledDate).toMatchObject({ outcome: "chosen" });
    expect(settledDate.answer).not.toHaveProperty("noPdfText");
    // the same answer again from the same person changes nothing; from someone else it's checked: the PDF's own text, typed
    expect(await answer(studyId, id, { value: "2025-08-22" })).toMatchObject({ outcome: "chosen" });
    expect(await answer(studyId, id, { value: "2025-08-22", by: "Ben" })).toMatchObject({ outcome: "matched" });
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

  it("refuses approval while any question is unsettled, then applies maker-checker", async () => {
    const { studyId } = await draft();
    const approve = (by: string) => signOff(app, studyId, 1, { by });
    const blocked = await approve("Morgan");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toBe(`${8 + INTERPRETED.length} questions still need an answer before this can be approved.`);
    // A "can't tell" holds approval up, a blocking one and one that's not needed to approve alike, and both count as
    // needing you: the contract isn't waiting for approval while one is open.
    await settleAll(built, studyId, 1, "Sam");
    await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { cantTell: true });
    expect((await approve("Morgan")).json().message).toBe("1 question still needs an answer before this can be approved.");
    await answer(studyId, "anomaly:GRID_CONFLICT:/budgetGrids/0", { optionId: "g1" });
    await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { cantTell: true });
    expect(await summary(studyId)).toMatchObject({ needsYou: 1 });
    expect((await approve("Morgan")).json().message).toBe("1 question still needs an answer before this can be approved.");
    await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { optionId: "later" });

    await patch("/settings", { makerChecker: true, by: "Morgan" });
    expect((await approve("Sam")).json().message).toBe("Maker-checker is on: Sam answered questions on this contract, so someone else has to approve it.");
    // the same person however the name is typed
    for (const by of [" Sam ", "sam", "SAM"]) expect((await approve(by)).statusCode, by).toBe(409);
    expect((await approve("Morgan")).statusCode).toBe(200);
    expect(await get<StudyDetailDto>(`/studies/${studyId}`)).toMatchObject({ status: "live", liveVersion: 1, needsYou: 0 });
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(`confirm:${G2_TOTAL}`)}`, { value: 1, by: "Sam" })).json().message).toBe(
      "Version 1 is signed; only a draft takes answers.",
    );
  });
});

describe("“This looks wrong”", () => {
  it("on a draft adds a blocking question and sends an approval-ready study back to Needs you", async () => {
    const { studyId } = await draft();
    await settleAll(built, studyId, 1);
    expect(await summary(studyId)).toMatchObject({ needsYou: 0 });
    const url = `/studies/${studyId}/versions/1/report`;
    const res = await post(url, { path: NET_DAYS, note: "Sponsor pays in 45 days", by: "Sam" });
    expect(res.statusCode).toBe(200);
    const v = res.json<RulebookVersionDto>();
    expect(v.review.at(-1)).toMatchObject({ kind: "confirm_value", reason: "reported", blocking: true, input: "number", path: NET_DAYS, answer: null, compare: null, question: "What value is printed for Payment › Net days?" });
    expect(at(v.rulebook, NET_DAYS)).toBe(45); // shown with its question (ADR-003)
    expect(await summary(studyId)).toMatchObject({ needsYou: 1 });
    expect((await post(url, { path: NET_DAYS, note: "again", by: "Sam" })).statusCode).toBe(409);
    expect((await post(url, { path: "/budgetGrids/0", note: "whole grid", by: "Sam" })).statusCode).toBe(400);
    // what's missing, named: the note here, not who is reporting
    expect((await post(url, { path: NET_DAYS, by: "Sam" })).json().message).toBe("Add a short note saying what looks wrong.");
  });

  it("on the live version opens a correction draft; the live version stays live until it's approved", async () => {
    const { studyId } = await liveStudy(built);
    const cell = "/budgetGrids/0/procedures/0/cells/V2";
    const res = await post(`/studies/${studyId}/versions/1/report`, { path: cell, note: "Should be $56", by: "Sam" });
    const v2 = res.json<RulebookVersionDto>();
    expect(v2).toMatchObject({ version: 2, status: "draft", byHand: false, editors: [] });
    expect(v2.review).toHaveLength(1);
    expect(v2.review[0]!.question).toMatch(/^What amount is printed for /);
    expect(at(v2.rulebook, cell)).toBe(5500);
    expect(at((await version(studyId, 1)).rulebook, cell)).toBe(5500);
    expect(await get<StudyDetailDto>(`/studies/${studyId}`)).toMatchObject({ status: "amendment_in_review", liveVersion: 1, needsYou: 1 });
    // the note names the value being typed blind on v2: its numbers are blanked until that's answered
    expect((await auditOf(studyId))[0]).toMatchObject({ action: "number.reported", by: "Sam", detail: { version: 2, note: "Should be $56" } });
    // Only the newest version can be reported on now.
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: NET_DAYS, note: "x", by: "Sam" })).json().message).toBe("Version 2 is already in progress. Report it there.");

    // Matches the PDF text, approved: v2 is live with the same numbers.
    expect(await answer(studyId, v2.review[0]!.id, { value: 5500 }, 2)).toMatchObject({ outcome: "matched" });
    expect((await signOff(app, studyId, 2, { by: "Ben" })).statusCode).toBe(200);
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
    await signOff(app, studyId, 2, { by: "Ben" });
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { paths, by: "Avery" })).json().message).toBe("Version 1 can't be proofread.");
  });
});

describe("send back", () => {
  it("reopens answers with the note, turns their evidence back to conflict, and raises sent_back alone", async () => {
    const { studyId } = await draft();
    await settleAll(built, studyId, 1);
    const alerts = async () => (await get<AlertPage>("/alerts?for=Avery&limit=50")).items;
    const seen = (await alerts()).length;
    const ids = [`confirm:${G2_TOTAL}`, "anomaly:GRID_CONFLICT:/budgetGrids/0"];
    const res = await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ids, note: "Check page 2", by: "Morgan" });
    expect(res.statusCode).toBe(200);
    const v = res.json<RulebookVersionDto>();
    for (const id of ids) expect(v.review.find((i) => i.id === id)).toMatchObject({ outcome: null, answer: null, compare: null, sentBack: { by: "Morgan", note: "Check page 2" } });
    expect(v.evidence.find((e) => e.path === G2_TOTAL)).toMatchObject({ status: "conflict", note: "Sent back by Morgan" });
    expect(at(v.rulebook, G2_TOTAL)).not.toBeNull();
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

  it("types a contract in by hand; the typist can't approve it", async () => {
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
    expect((await signOff(app, studyId, 1, { by: "Ben" })).json().message).toMatch(/^Typing isn't marked done yet/);

    // Nothing typed is re-typed (ADR-003). The visit total nobody typed holds the blank form's 0, and the form's choices
    // nobody made their defaults (how the visit is paid, the row's kind and overhead, the terms "not stated"): asked as missing.
    v = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).json<RulebookVersionDto>();
    expect(v.review.map((i) => i.reason).sort()).toEqual(Array(8).fill("REQUIRED_MISSING"));
    expect(v.review.find((i) => i.path === "/budgetGrids/0/visits/0/totalCents")).toMatchObject({ reason: "REQUIRED_MISSING", blocking: true, input: "money" });
    expect(v.review.every((i) => i.blocking && i.answer === null)).toBe(true);
    expect((await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Avery" })).statusCode).toBe(409);
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: NET_DAYS, value: 30, note: "x", by: "Avery" })).json().message).toBe("Typing is marked done. Use “This looks wrong” to change a value.");
    expect(v.review.some((i) => i.path === NET_DAYS)).toBe(false);
    // the missing total is typed by the typist; nobody can approve $0 that wasn't typed
    expect(await answer(studyId, "missing:/budgetGrids/0/visits/0/totalCents", { value: 18500, by: "Avery" })).toMatchObject({ outcome: "chosen" });
    expect((await storedVersion(built, studyId, 1)).evidence.find((e) => e.path === "/budgetGrids/0/visits/0/totalCents")).toMatchObject({ status: "attested" });
    // the form's defaults nobody picked are picked now, by the typist: decisions, not re-types
    const held = await storedVersion(built, studyId, 1);
    for (const i of held.review.filter((x) => x.reason === "REQUIRED_MISSING" && x.outcome === null)) await answer(studyId, i.id, { optionId: String(at(held.rulebook, i.path!)), by: "Avery" });
    await settleAll(built, studyId, 1, "Sam");
    // With maker-checker on, the typist may not approve; someone who only answered nothing may.
    await patch("/settings", { makerChecker: true, by: "Morgan" });
    expect((await signOff(app, studyId, 1, { by: "Avery" })).statusCode).toBe(409);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("re-types nothing however many values were typed", async () => {
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
    expect(v.review.filter((i) => i.reason === "spot_check")).toHaveLength(0);
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

describe("the sponsor's budget spreadsheet, checked against the signed contract (ADR-003 P2)", () => {
  const check = async (studyId: string, data: Buffer, name = "Ex A-1 Final.xlsx", v = 1) => {
    const { payload, headers } = await multipart([{ name, data }], { by: "Sam" });
    return app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/versions/${v}/budget-check`, payload, headers });
  };
  const notice = (v: RulebookVersionDto) => v.warnings.filter((w) => w.startsWith("The sponsor's budget spreadsheet"));

  it("a matching spreadsheet is said as a notice; one that differs says where; nothing in the master changes; the same again logs nothing", async () => {
    const { studyId } = await draft();
    const before = await storedVersion(built, studyId, 1);
    const ok = await check(studyId, await makeBudgetXlsx());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(notice(ok.json<RulebookVersionDto>())).toEqual(["The sponsor's budget spreadsheet “Ex A-1 Final.xlsx” matches the signed contract: 5 prices compared (unit prices, every visit, the visit totals)."]);
    expect((await storedVersion(built, studyId, 1)).rulebook).toEqual(before.rulebook);
    expect((await auditOf(studyId)).filter((e) => e.action === "budget.checked")).toEqual([expect.objectContaining({ by: "Sam", detail: expect.objectContaining({ version: 1, file: "Ex A-1 Final.xlsx", compared: 5, differences: 0 }) })]);
    // the same file again changes nothing and logs nothing; a different one replaces the notice
    expect((await check(studyId, await makeBudgetXlsx())).statusCode).toBe(200);
    expect((await auditOf(studyId)).filter((e) => e.action === "budget.checked")).toHaveLength(1);
    const differs = (await check(studyId, await makeBudgetXlsx(8500))).json<RulebookVersionDto>();
    expect(notice(differs)).toEqual([expect.stringMatching(/differs from the signed contract in 1 place \(5 prices compared\)\. The signed contract is what's billed; ask the sponsor which is right: V2 visit total: contract \$8,489, spreadsheet \$8,500\.$/)]);
  });

  it("refuses what it can't check, in plain words", async () => {
    const { studyId } = await draft();
    expect((await check(studyId, Buffer.from("%PDF-1.7"), "contract.pdf")).json()).toMatchObject({ statusCode: 415, message: "contract.pdf isn't an Excel spreadsheet (.xlsx)." });
    expect((await check(studyId, Buffer.from("PK\u0003\u0004 broken"))).json()).toMatchObject({ statusCode: 422, message: "Ex A-1 Final.xlsx couldn't be read as a spreadsheet. Save it again from Excel as .xlsx and try once more." });
    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Other").addRow(["Code", "Budget", "Week 1", "Week 2"]);
    expect((await check(studyId, Buffer.from(await wb.xlsx.writeBuffer()), "other.xlsx")).json()).toMatchObject({ statusCode: 422, message: "other.xlsx has no sheet with this contract's visits in a header row, so it can't be checked against it. Is it this contract's budget?" });
    const { studyId: live } = await liveStudy(built, "budget-live");
    expect((await check(live, await makeBudgetXlsx())).json()).toMatchObject({ statusCode: 409, message: "Version 1 is signed; a spreadsheet is checked against a draft." });
  });
});
