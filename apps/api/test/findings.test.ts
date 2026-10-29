import { type AlertPage, type AuditPage, billedGrids, type DocumentDto, type ReviewItem, type RulebookVersionDto, SAMPLE, settled, type StudyPage } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { audit } from "../src/domain.js";
import { rulebookVersions } from "../src/db/schema.js";
import { fakeControls } from "../src/extraction/fake.js";
import { at } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload, waitJob } from "./helpers.js";

// Regressions for the review findings of 2026-10-29, through the API: each `it` failed before its fix. The rules
// themselves are in @dct/shared (packages/shared/test/findings.test.ts).

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
  vi.useRealTimers();
  await built.ctx.db.execute(sql.raw("DROP TRIGGER IF EXISTS test_fail ON audit_log"));
});

const get = async <T>(url: string) => (await app.inject({ url: `/api/v1${url}` })).json<T>();
const post = (url: string, payload: object, key?: string) => app.inject({ method: "POST", url: `/api/v1${url}`, payload, headers: key ? { "idempotency-key": key } : {} });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url: `/api/v1${url}`, payload });
const version = (studyId: string, v = 1) => get<RulebookVersionDto>(`/studies/${studyId}/versions/${v}`);
const answer = async (studyId: string, item: string, body: object, v = 1) => {
  const res = await post(`/studies/${studyId}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RulebookVersionDto>().review.find((i) => i.id === item)!;
};
const setRulebook = async (studyId: string, change: (rb: NonNullable<RulebookVersionDto["rulebook"]>) => void, v = 1) => {
  const rb = structuredClone((await storedVersion(built, studyId, v)).rulebook!);
  change(rb);
  await built.ctx.db.update(rulebookVersions).set({ rulebook: rb }).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, v)));
};
/** The stored questions (and the read's findings), changed as a version stored before a fix would hold them. */
const setStored = async (studyId: string, change: (row: { review: ReviewItem[]; anomalies: RulebookVersionDto["anomalies"] }) => object, v = 1) => {
  const row = await storedVersion(built, studyId, v);
  await built.ctx.db.update(rulebookVersions).set(change({ review: structuredClone(row.review), anomalies: structuredClone(row.anomalies) })).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, v)));
};
/** Re-types the blind sample's values in `grid` as the master holds them, so nothing in it is open any more. */
const retypeSample = async (studyId: string, grid: string) => {
  const row = await storedVersion(built, studyId, 1);
  for (const i of row.review.filter((x) => x.reason === SAMPLE && x.path!.startsWith(grid) && !settled(x))) await answer(studyId, i.id, { value: at(row.rulebook, i.path!) });
};

const G1_V2 = "/budgetGrids/0/visits/1"; // prints 8,489.00, its parts add up to 8,488.00 (VISIT_TOTAL_MISMATCH)
const ARITH = `anomaly:VISIT_TOTAL_MISMATCH:${G1_V2}/totalCents`;

/** A text work order with these lines on page 1, in 8 pt type (`y` from the top), and a page 2 for the grids. */
async function textPdf(seed: string, lines: [number, string][]) {
  const doc = await PDFDocument.create();
  doc.setTitle(seed);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  for (const [y, text] of [...lines, [700, "This page continues the agreement between the parties and the site, as set out above in full detail."]] as [number, string][]) p.drawText(text, { x: 40, y: 792 - y, size: 8, font });
  doc.addPage([612, 792]).drawText("Exhibit A", { x: 40, y: 712, size: 8, font });
  const [d] = (await upload(app, [{ name: "Work Order.pdf", data: Buffer.from(await doc.save()) }])).json<DocumentDto[]>();
  const created = (await post("/studies", { documentIds: [d!.id] })).json<{ studyId: string; jobId: string }>();
  await waitJob(app, created.jobId);
  await extract(app, created.studyId);
  return created.studyId;
}

describe("1. 'the total as printed' after 'the sum'", () => {
  it("puts the printed total back, and that is what's approved", async () => {
    const { studyId } = await newStudy(app, "printed");
    await extract(app, studyId);
    await answer(studyId, ARITH, { optionId: "sum", note: "Which total is right?" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.budgetGrids[0]!.visits[1]!.totalCents).toBe(848800);
    await answer(studyId, ARITH, { optionId: "printed", note: "The sponsor says the printed total governs" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.budgetGrids[0]!.visits[1]!.totalCents).toBe(848900);
    await settleAll(built, studyId, 1);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
    expect((await storedVersion(built, studyId, 1)).rulebook!.budgetGrids[0]!.visits[1]!.totalCents).toBe(848900);
  });
});

describe("2. a money term whose sentence runs over two lines", () => {
  it("never shows a withheld value printed on its other line: question, term, notes", async () => {
    const studyId = await textPdf("two-lines", [
      [60, "UNSCH Unscheduled visit $572.00 $800.00 per occurrence"],
      // one sentence, 12 pt apart: the fee's due days on the first line, an interest term the read doesn't hold on the second
      [80, "SC003 Administrative fee $12,000.00 due within 45 days of study initiation, and late"],
      [92, "payments by the Sponsor accrue interest at 1.5% per month until they are paid."],
      [140, "This Work Order is effective as of August 22, 2025."],
    ]);
    const DAYS = "/siteFees/0/dueDays";
    if (!(await version(studyId)).review.some((i) => i.path === DAYS && !settled(i)))
      expect((await post(`/studies/${studyId}/versions/1/report`, { path: DAYS, note: "check the days", by: "Sam" })).statusCode).toBe(200);
    const v = await version(studyId);
    expect(at(v.rulebook, DAYS)).toBeNull();
    const term = v.review.find((i) => i.reason === "UNACCOUNTED_TERM" && /interest/.test(i.question))!;
    expect(term.quoted!.length).toBe(2); // both lines of its sentence
    const leaks = /\b45\b|12,000|1\.5/;
    expect(JSON.stringify([term.question, term.term])).not.toMatch(leaks);
    // listed to bill by hand, with a note: blanked on the master and in the log too
    await answer(studyId, term.id, { optionId: "bill_by_hand", note: "Interest of 1.5% on payments later than 45 days" });
    const shown = await version(studyId);
    const listed = shown.rulebook!.unclassified[0]!;
    const asked = shown.review.find((i) => i.id === term.id)!;
    expect(JSON.stringify([listed.label, listed.quote, listed.note, listed.amounts, listed.pct, asked.question, asked.term, asked.answer!.note])).not.toMatch(leaks);
    const log = (await get<AuditPage>(`/audit?studyId=${studyId}`)).items.find((e) => e.detail.itemId === term.id)!;
    expect(JSON.stringify([log.detail.question, log.detail.note, log.detail.billByHand])).not.toMatch(leaks);
  });
});

describe("3. a 'bill by hand' answer whose note changes", () => {
  it("puts the new note on the master, and that is what's approved", async () => {
    const { studyId, doc } = await newStudy(app, "note", { scan: true });
    await extract(app, studyId);
    const page = `page:${doc.id}:1`;
    await answer(studyId, page, { optionId: "bill_by_hand", note: "Parking, $12 a visit" });
    await answer(studyId, page, { optionId: "bill_by_hand", note: "Parking, $120 a visit (misread the first time)" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified.map((u) => u.note)).toEqual(["Parking, $120 a visit (misread the first time)"]);
    await settleAll(built, studyId, 1);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified.map((u) => u.note)).toEqual(["Parking, $120 a visit (misread the first time)"]);
  });
});

describe("4. a total settled by 'the sum' whose part is corrected later", () => {
  it("is asked again, withheld until it is, and holds approval", async () => {
    const { studyId } = await newStudy(app, "stale");
    await extract(app, studyId);
    await retypeSample(studyId, "/budgetGrids/0/");
    await answer(studyId, ARITH, { optionId: "sum", note: "Ask the sponsor which total" });
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: `${G1_V2}/overheadCents`, note: "Overhead looks off", by: "Ben" })).statusCode).toBe(200);
    const reported = (await storedVersion(built, studyId, 1)).review.find((i) => i.reason === "reported")!.id;
    await answer(studyId, reported, { value: 243500 });
    await answer(studyId, reported, { value: 243500, note: "PDF text is the old exhibit; the signed page prints 2,435.00" });
    const row = await storedVersion(built, studyId, 1);
    expect(row.review.find((i) => i.id === ARITH)).toMatchObject({ outcome: null, answer: null, asPrinted: 848900 });
    expect(at((await version(studyId)).rulebook, `${G1_V2}/totalCents`)).toBeNull();
  });
});

describe("5. the blind sample shows nothing of the PDF check", () => {
  it("its page, not the bound spot; a differing answer typed again blind; a second miss logged with no note asked", async () => {
    const { studyId } = await newStudy(app, "sample");
    await extract(app, studyId);
    const id = "sample:/budgetGrids/0/procedures/0/cells/V1";
    const row = await storedVersion(built, studyId, 1);
    const ev = row.evidence.find((e) => e.path === "/budgetGrids/0/procedures/0/cells/V1")!;
    expect(ev.where[0]!.box).not.toBeNull();
    expect((await version(studyId)).review.find((i) => i.id === id)!.where).toEqual([{ ...ev.where[0]!, box: null }]);
    expect(await answer(studyId, id, { value: 1 })).toMatchObject({ outcome: "differs", compare: null });
    expect(JSON.stringify(await version(studyId))).not.toMatch(/"read":5500/);
    expect(await answer(studyId, id, { value: 1 })).toMatchObject({ outcome: "chosen", missed: true });
    expect((await get<AuditPage>(`/audit?studyId=${studyId}`)).items.filter((e) => e.action === "sample.missed")).toHaveLength(1);
  });
});

describe("6. 'prospective only' on an amendment", () => {
  it("shows no date and takes the amendment's own date typed: never the read's as a person's", async () => {
    const { studyId } = await liveStudy(built);
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend") }])).json<DocumentDto[]>();
    await extract(app, studyId, { documentIds: [amend!.id] });
    const q = (await version(studyId, 2)).review.find((i) => i.path === "/appliesFrom/value")!;
    expect(q.options).toEqual([{ id: "prospective", label: "Prospective only: from the amendment's own date" }]);
    const refused = await post(`/studies/${studyId}/versions/2/review/${encodeURIComponent(q.id)}`, { optionId: "prospective", by: "Sam" });
    expect(refused.json()).toMatchObject({ statusCode: 400, message: "Type the amendment's own date, as it's printed on the amendment." });
    // checked like any typed date against the read's start date (January 1)
    expect(await answer(studyId, q.id, { optionId: "prospective", value: "2026-01-01" }, 2)).toMatchObject({ outcome: "matched", answer: { optionId: "prospective", value: "2026-01-01" } });
    const row = await storedVersion(built, studyId, 2);
    expect([row.rulebook!.appliesFrom.value, row.evidence.find((e) => e.path === "/appliesFrom/value")]).toEqual(["2026-01-01", expect.objectContaining({ status: "attested", note: "Typed by Sam" })]);
  });
});

describe("7. a cap whose kind needs a limit the read didn't find", () => {
  it("asks the limit once the kind is settled", async () => {
    const { studyId } = await newStudy(app, "cap");
    await extract(app, studyId);
    await setRulebook(studyId, (rb) => (rb.screenFail!.cap.n = null));
    await built.ctx.db.execute(sql`UPDATE rulebook_versions SET evidence = (SELECT coalesce(jsonb_agg(e), '[]') FROM jsonb_array_elements(evidence) e WHERE e->>'path' <> '/screenFail/cap/n') WHERE study_id = ${studyId}`);
    await answer(studyId, "interpret:/screenFail/cap/kind", { optionId: "blocks_with_reauth" });
    expect((await version(studyId)).review.find((i) => i.path === "/screenFail/cap/n")).toMatchObject({ id: "cap:/screenFail/cap/n", reason: "REQUIRED_MISSING", outcome: null });
  });
});

describe("8. amounts and percentages on the bill-by-hand list", () => {
  it("a full stop after the amount, a bracketed credit and a % with its full stop: listed right, never NaN or a 500", async () => {
    const studyId = await textPdf("amounts", [
      [60, "Archive storage at closeout is invoiced at $3,333.00."],
      [80, "Each late invoice is credited back to the Sponsor at ($1,500.00) per month."],
      [100, "Late payments accrue interest at 1.5%."],
    ]);
    const terms = (await storedVersion(built, studyId, 1)).review.filter((i) => i.reason === "UNACCOUNTED_TERM");
    const by = (re: RegExp) => terms.find((i) => re.test(i.term!.quote))!;
    expect([by(/storage/).term!.amounts, by(/credited/).term!.amounts, by(/interest/).term!.pct]).toEqual([[333300], [-150000], 1.5]);
    for (const t of [by(/storage/), by(/credited/), by(/interest/)]) await answer(studyId, t.id, { optionId: "bill_by_hand" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified.map((u) => [u.amounts, u.pct])).toEqual([[[333300], undefined], [[-150000], undefined], [[], 1.5]]);
  });
});

describe("10. what a withheld interpretation decides, row by row", () => {
  it("each visit's 'paid automatically' while how visits are paid is asked, each row's overhead while its scope is", async () => {
    const { studyId } = await newStudy(app, "rows");
    await extract(app, studyId);
    let v = await version(studyId);
    expect(v.rulebook!.budgetGrids.flatMap((g) => [...g.visits.map((x) => x.autopay), ...g.procedures.map((p) => p.overheadApplied)])).toEqual([null, null, null, null, null, null]);
    await answer(studyId, "interpret:/payment/visitPayment/value", { optionId: "auto_edc" });
    await answer(studyId, "interpret:/overhead/appliesTo/value", { optionId: "all_per_patient_lines" });
    v = await version(studyId);
    expect(v.rulebook!.budgetGrids[0]!.visits[0]!.autopay).toBe(true);
    expect(v.rulebook!.budgetGrids[0]!.procedures[0]!.overheadApplied).toBe(true);
  });
});

describe("11. typing by hand", () => {
  it("asks how each visit is paid, as a pick, when nobody chose it", async () => {
    const { studyId } = await newStudy(app, "hand", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/budgetGrids/0/visits/0/totalCents", value: 5500, note: "x", by: "Asha" })).statusCode).toBe(200);
    const v = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" })).json<RulebookVersionDto>();
    expect(v.review.find((i) => i.path === "/budgetGrids/0/visits/0/autopay")).toMatchObject({ id: "missing:/budgetGrids/0/visits/0/autopay", reason: "REQUIRED_MISSING", input: null, options: [{ id: "true" }, { id: "false" }] });
  });
});

describe("12. the log while an amount its label names is typed blind", () => {
  it("blanks the amount in the value's label", async () => {
    const { studyId } = await newStudy(app, "label");
    await extract(app, studyId);
    await setRulebook(studyId, (rb) => (rb.siteFees[0]!.name = "Archiving fee $250"));
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Ben" })).statusCode).toBe(200);
    const entry = (await get<AuditPage>(`/audit?studyId=${studyId}`)).items.find((e) => e.action === "number.reported")!;
    expect(entry.detail.value).toBe("Site fee › Archiving fee ••• › Amount");
  });
});

describe("13. a can't tell on a question not needed to approve", () => {
  it("still needs you: the contract isn't waiting for approval, and nobody is told it is", async () => {
    const { studyId } = await newStudy(app, "cant");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ["anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0"], note: "check", by: "Ben" });
    await answer(studyId, "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0", { cantTell: true });
    expect((await get<StudyPage>("/studies?view=needs-you")).items.map((s) => [s.id, s.needsYou])).toEqual([[studyId, 1]]);
    const kinds = (await get<AlertPage>("/alerts?for=Ben&limit=50")).items.filter((a) => a.studyId === studyId).map((a) => a.kind);
    expect(kinds.filter((k) => k === "ready_for_approval")).toHaveLength(1); // the first time round, before the send-back
  });
});

describe("14. a typo after typing by hand is marked done", () => {
  it("is reported with “This looks wrong”, once, and not before typing is done", async () => {
    const { studyId } = await newStudy(app, "typo", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    await patch(`/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 54, note: "x", by: "Asha" });
    const early = await post(`/studies/${studyId}/versions/1/report`, { path: "/payment/netDays/value", note: "typo", by: "Asha" });
    expect(early.json()).toMatchObject({ statusCode: 409, message: "Typing isn't marked done yet: change the value in the form instead." });
    await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" });
    await answer(studyId, "spot:/payment/netDays/value", { value: 54, by: "Ben" });
    const key = randomUUID();
    const first = await post(`/studies/${studyId}/versions/1/report`, { path: "/payment/netDays/value", note: "I typed 54; it's 45", by: "Asha" }, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await post(`/studies/${studyId}/versions/1/report`, { path: "/payment/netDays/value", note: "I typed 54; it's 45", by: "Asha" }, key);
    expect([again.body, again.headers["idempotent-replayed"]]).toEqual([first.body, "true"]);
    const row = await storedVersion(built, studyId, 1);
    expect(row.review.filter((i) => i.reason === "reported")).toHaveLength(1);
    expect((await get<AuditPage>(`/audit?studyId=${studyId}`)).items.filter((e) => e.action === "number.reported")).toHaveLength(1);
  });

  it("a report whose log entry fails leaves nothing behind", async () => {
    const { studyId } = await newStudy(app, "typo-fail", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    await patch(`/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 54, note: "x", by: "Asha" });
    await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" });
    await answer(studyId, "spot:/payment/netDays/value", { value: 54, by: "Ben" });
    const before = await storedVersion(built, studyId, 1);
    await built.ctx.db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'number.reported' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`),
    );
    await built.ctx.db.execute(sql.raw("CREATE TRIGGER test_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail()"));
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: "/payment/netDays/value", note: "typo", by: "Asha" })).statusCode).toBe(500);
    const after = await storedVersion(built, studyId, 1);
    expect([after.review, after.updatedAt]).toEqual([before.review, before.updatedAt]);
  });
});

describe("15. lows", () => {
  it("approval refuses a version changed in the same millisecond it was seen", async () => {
    const { studyId } = await newStudy(app, "asof");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: ["/siteFees/0/amountCents"], by: "Asha" });
    const seen = (await version(studyId)).updatedAt;
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: ["/invoiceables/0/amountCents"], by: "Asha" });
    expect((await version(studyId)).updatedAt > seen).toBe(true);
    expect((await signOff(app, studyId, 1, { by: "Ben", asOf: seen })).json()).toMatchObject({ statusCode: 409, message: "This contract changed since you opened it. Check it again." });
  });

  it("a refused body says what's missing, not who is typing", async () => {
    const { studyId } = await newStudy(app, "words", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    expect((await patch(`/studies/${studyId}/versions/1/values`, { value: 1, note: "x", by: "Asha" })).json().message).toBe("Say which value you're typing.");
    expect((await patch(`/studies/${studyId}/versions/1/values`, { path: "/payment/netDays/value", value: 1, by: "Asha" })).json().message).toBe("Add a short note about the value.");
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: ["x"], by: "Ben" })).json().message).toBe("Add a note saying what to look at again.");
    expect((await post(`/studies/${studyId}/versions/1/proofread`, { by: "Ben" })).json().message).toBe("Say which values you proofread.");
  });

  it("a file's kind is set by a named person; alerts are read for a name however it's typed", async () => {
    const { studyId, doc } = await newStudy(app, "people");
    expect((await patch(`/documents/${doc.id}`, { kind: "budget", by: "  " })).statusCode).toBe(400);
    await extract(app, studyId);
    await settleAll(built, studyId, 1, "Asha");
    const mine = (await get<AlertPage>("/alerts?for=%20asha%20&limit=50")).items.find((a) => a.kind === "ready_for_approval")!;
    expect(mine).toMatchObject({ by: "Asha", read: true }); // you're not alerted about what you did
    await post("/alerts/read", { by: "Ben" });
    expect((await get<AlertPage>("/alerts?for=BEN&limit=50")).unread).toBe(0);
  });

  it("the log's search pages on when only blanked entries match, instead of reading the whole log in one request", async () => {
    const { studyId } = await newStudy(app, "bound");
    await extract(app, studyId);
    // 40 entries about a question still open: their note, which the search matches in SQL, is blanked as shown
    await built.ctx.db.transaction(async (tx) => {
      for (let n = 0; n < 40; n++) await audit(tx, "Sam", studyId, "review.answered", { version: 1, itemId: "confirm:/payment/netDays/value", note: "zzq123" });
    });
    const page = await get<AuditPage>(`/audit?studyId=${studyId}&q=zzq123&limit=1`);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    let cursor = page.nextCursor;
    for (let n = 0; cursor && n < 10; n++) cursor = (await get<AuditPage>(`/audit?studyId=${studyId}&q=zzq123&limit=1&cursor=${cursor}`)).nextCursor;
    expect(cursor).toBeNull();
  });
});

// ---- The second review of 2026-10-29, through the API: each `it` failed before its fix. ----

const open = async (studyId: string, v = 1) => (await storedVersion(built, studyId, v)).review.filter((i) => !settled(i));
const MANUAL = { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" };

describe("C1. two grids for one arm that priced the same at the read", () => {
  it("asks which to bill once an answer sets them a single cell apart, and approval waits for it", async () => {
    const { studyId } = await newStudy(app, "twins");
    await extract(app, studyId);
    // as a read whose two grids priced the same: billed once, nothing asked
    await setRulebook(studyId, (rb) => (rb.budgetGrids[1]!.visits[1]!.totalCents = rb.budgetGrids[0]!.visits[1]!.totalCents));
    await setStored(studyId, ({ review }) => ({ review: review.filter((i) => i.reason !== "GRID_CONFLICT") }));
    await settleAll(built, studyId, 1);
    const CELL = "/budgetGrids/1/procedures/0/cells/V1";
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: CELL, note: "the revised exhibit prints another price", by: "Ben" })).statusCode).toBe(200);
    const reported = (await open(studyId))[0]!.id;
    await answer(studyId, reported, { value: 6000 });
    await answer(studyId, reported, { value: 6000, note: "the signed page prints 60.00" });
    const asked = await open(studyId);
    expect(asked).toEqual([expect.objectContaining({ reason: "GRID_CONFLICT", options: [expect.objectContaining({ id: "g1" }), expect.objectContaining({ id: "g2" })] })]);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(409);
    await answer(studyId, asked[0]!.id, { optionId: "g2" });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
    expect(billedGrids((await storedVersion(built, studyId, 1)).rulebook!).map((g) => g.id)).toEqual(["g2"]);
  });

  it("approval refuses an arm that bills no grid, with every question settled", async () => {
    const { studyId } = await newStudy(app, "unbilled");
    await extract(app, studyId);
    await settleAll(built, studyId, 1);
    // a master that got there before an answer asked which grid: two grids apart, none chosen
    await setRulebook(studyId, (rb) => (rb.governingGridIds = []));
    expect((await signOff(app, studyId, 1, { by: "Ben" })).json()).toMatchObject({ statusCode: 409, message: "Choose which budget grid to bill for this contract." });
  });
});

describe("H1. the blind sample's final answer", () => {
  it("can't be reset by “can't tell” or a send-back: the next wrong answer is a miss, each logged", async () => {
    const { studyId } = await newStudy(app, "retyped");
    await extract(app, studyId);
    const first = "sample:/budgetGrids/0/procedures/0/cells/V1";
    expect(await answer(studyId, first, { value: 1 })).toMatchObject({ outcome: "differs" });
    expect(await answer(studyId, first, { cantTell: true })).toMatchObject({ outcome: "cant_tell", retyped: true });
    expect(await answer(studyId, first, { value: 2 })).toMatchObject({ outcome: "chosen", missed: true });
    const second = "sample:/budgetGrids/0/visits/0/totalCents";
    await answer(studyId, second, { value: 1 });
    expect((await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: [second], note: "look again", by: "Ben" })).statusCode).toBe(200);
    expect(await answer(studyId, second, { value: 2 })).toMatchObject({ outcome: "chosen", missed: true });
    expect((await get<AuditPage>(`/audit?studyId=${studyId}`)).items.filter((e) => e.action === "sample.missed")).toHaveLength(2);
  });
});

describe("M1. a sampled value's spot on the page", () => {
  it("is its page only while it's withheld, as its question shows it", async () => {
    const { studyId } = await newStudy(app, "spot");
    await extract(app, studyId);
    const v = await version(studyId);
    const sampled = v.review.filter((i) => i.reason === SAMPLE).map((i) => i.path!);
    expect(sampled.length).toBeGreaterThan(0);
    for (const p of sampled) expect(v.evidence.find((e) => e.path === p)!.where.map((w) => w.box)).toEqual([null]);
    expect((await storedVersion(built, studyId, 1)).evidence.find((e) => e.path === sampled[0])!.where[0]!.box).not.toBeNull();
  });
});

describe("M2. 'prospective only' while the start date is asked", () => {
  it("withholds the amendment's own date, what a typed date is checked against", async () => {
    const { studyId } = await liveStudy(built, "dated");
    const [amend] = (await upload(app, [{ name: "Amendment 1.pdf", data: await makePdf("amend-dated") }])).json<DocumentDto[]>();
    expect((await patch(`/documents/${amend!.id}`, { kind: "amendment", by: "Asha" })).statusCode).toBe(200);
    await extract(app, studyId, { documentIds: [amend!.id] });
    await setRulebook(studyId, (rb) => (rb.documents.find((d) => d.kind === "amendment")!.date = "2026-03-15"), 2);
    const v = await version(studyId, 2);
    expect(JSON.stringify(v.rulebook!.documents)).not.toMatch(/2026-03-15/);
    const q = v.review.find((i) => i.path === "/appliesFrom/value")!;
    await answer(studyId, q.id, { optionId: "prospective", value: "2026-01-01" }, 2);
    expect((await version(studyId, 2)).rulebook!.documents.map((d) => d.date)).toContain("2026-03-15");
  });
});

describe("M3. the log while a typed amount is re-typed blind", () => {
  it("blanks it in the same fee's typed name", async () => {
    const { studyId } = await newStudy(app, "fee-name", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    const type = async (path: string, value: unknown) => expect((await patch(`/studies/${studyId}/versions/1/values`, { path, value, note: "x", by: "Asha" })).statusCode).toBe(200);
    await type("/siteFees", [{ code: null, name: "", amountCents: null, trigger: "one_time", dueDays: null, prov: MANUAL }]);
    // ten typed values for the pinned draw to re-type, the fee's amount among them; its name typed last, not drawn
    for (const [path, value] of [
      ["/siteFees/0/amountCents", 25000], ["/payment/netDays/value", 30], ["/budgetGrids/0/visits/0/name", "Screening"], ["/budgetGrids/0/visits/0/totalCents", 5500],
      ["/budgetGrids/0/procedures/0/name", "Blood draw"], ["/budgetGrids/0/procedures/0/cells/V1", 5500], ["/budgetGrids/0/procedures/0/unitCents", 5500],
      ["/budgetGrids/0/visits/0/autopay", true], ["/budgetGrids/0/procedures/0/overheadApplied", false], ["/budgetGrids/0/procedures/0/category", "procedure"],
      ["/siteFees/0/name", "Archiving fee $250"],
    ] as const)
      await type(path, value);
    await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" });
    expect((await open(studyId)).map((i) => i.id)).toContain("spot:/siteFees/0/amountCents");
    const entry = (await get<AuditPage>(`/audit?studyId=${studyId}&limit=100`)).items.find((e) => e.action === "value.typed" && e.detail.path === "/siteFees/0/name")!;
    expect(entry.detail).toMatchObject({ value: "Site fee › Archiving fee ••• › Name", after: "Archiving fee •••" });
  });
});

describe("M4. 'the total as printed' on a question stored before it kept the printed total", () => {
  it("puts back what the read's check found printed", async () => {
    const { studyId } = await newStudy(app, "old-total");
    await extract(app, studyId);
    await setStored(studyId, ({ review }) => ({ review: review.map(({ asPrinted: _, ...i }) => i) }));
    await answer(studyId, ARITH, { optionId: "sum", note: "Which total is right?" });
    await answer(studyId, ARITH, { optionId: "printed", note: "The printed total governs" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.budgetGrids[0]!.visits[1]!.totalCents).toBe(848900);
  });

  it("refuses it, in words, when nothing says what's printed", async () => {
    const { studyId } = await newStudy(app, "lost-total");
    await extract(app, studyId);
    await setStored(studyId, ({ review }) => ({ review: review.map(({ asPrinted: _, ...i }) => i), anomalies: [] }));
    await answer(studyId, ARITH, { optionId: "sum", note: "Which total is right?" });
    const res = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(ARITH)}`, { optionId: "printed", note: "?", by: "Sam" });
    expect(res.json()).toMatchObject({ statusCode: 409, message: expect.stringMatching(/^This question was asked before the app kept the total as printed/) });
    expect((await storedVersion(built, studyId, 1)).rulebook!.budgetGrids[0]!.visits[1]!.totalCents).toBe(848800);
  });
});

describe("M5. a rule the read gives without its quote", () => {
  it("blanks every money term on its page while it's asked", async () => {
    const studyId = await textPdf("netdays", [
      [60, "Sponsor shall pay each undisputed invoice within 37 days of receipt by the Sponsor."],
      [140, "This Work Order is effective as of August 22, 2025, and runs until the study closes."],
    ]);
    const v = await version(studyId);
    expect(v.evidence.find((e) => e.path === "/payment/netDays/value")!.where.map((w) => [w.page, w.box])).toEqual([[1, null]]);
    const term = v.review.find((i) => i.reason === "UNACCOUNTED_TERM" && /undisputed/.test(i.question))!;
    expect(JSON.stringify([term.question, term.term])).not.toMatch(/37/);
  });
});

describe("H2. a 3-decimal rate, and an amount written with USD", () => {
  it("is asked as a money term, with no amount to bill by", async () => {
    const studyId = await textPdf("rates", [
      [60, "Subject mileage is reimbursed at $0.655 per mile driven to each study appointment."],
      [80, "Archiving is paid at 500.00 USD per box stored off site by the Institution."],
    ]);
    const terms = (await storedVersion(built, studyId, 1)).review.filter((i) => i.reason === "UNACCOUNTED_TERM");
    expect(terms.find((i) => /mileage/.test(i.term!.quote))!.term!.amounts).toEqual([]);
    expect(terms.find((i) => /Archiving/.test(i.term!.quote))!.term!.amounts).toEqual([50000]);
  });
});

describe("L2. a cap answered 'No limit'", () => {
  const KIND = "interpret:/screenFail/cap/kind";
  const N = "/screenFail/cap/n";
  const setUp = async (seed: string) => {
    const { studyId } = await newStudy(app, seed);
    await extract(app, studyId);
    await answer(studyId, KIND, { optionId: "blocks_with_reauth" });
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: N, note: "the limit looks off", by: "Ben" })).statusCode).toBe(200);
    await answer(studyId, KIND, { optionId: "none" });
    return studyId;
  };

  it("closes a question still open on its limit, logged; the limit can't be reported after", async () => {
    const studyId = await setUp("no-limit");
    await answer(studyId, KIND, { optionId: "none", note: "§3 sets no limit" });
    const row = await storedVersion(built, studyId, 1);
    expect([row.review.some((i) => i.path === N && !settled(i)), row.rulebook!.screenFail!.cap]).toEqual([false, { kind: "none", n: null, ratio: null }]);
    expect((await get<AuditPage>(`/audit?studyId=${studyId}`)).items.filter((e) => e.action === "review.closed").map((e) => e.detail.path)).toEqual([N]);
    expect((await post(`/studies/${studyId}/versions/1/report`, { path: N, note: "again", by: "Ben" })).json()).toMatchObject({ statusCode: 409, message: "This cap has “No limit”, so there's no limit to report. If that's wrong, report the cap's kind instead." });
  });

  it("closing it is one write with its log entry: a failing entry leaves nothing behind", async () => {
    const studyId = await setUp("no-limit-fail");
    const before = await storedVersion(built, studyId, 1);
    await built.ctx.db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'review.closed' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`),
    );
    await built.ctx.db.execute(sql.raw("CREATE TRIGGER test_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail()"));
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(KIND)}`, { optionId: "none", note: "§3 sets no limit", by: "Sam" })).statusCode).toBe(500);
    const after = await storedVersion(built, studyId, 1);
    expect([after.review, after.rulebook, after.updatedAt]).toEqual([before.review, before.rulebook, before.updatedAt]);
  });
});

describe("L3. the test database guard", () => {
  it("checks the database's own name, not the whole URL", async () => {
    const was = process.env.DATABASE_URL;
    try {
      // "_test" in the user name only (the settings were read at import, so an app built anyway would still use the test database)
      process.env.DATABASE_URL = "postgres://dct_test:dct@localhost:5434/dct_finance";
      const got = await testApp().catch((e: Error) => e);
      if (!(got instanceof Error)) await got.app.close();
      expect(got).toEqual(new Error("tests must use the _test database"));
    } finally {
      process.env.DATABASE_URL = was;
    }
  });
});

// ---- The third review of 2026-10-29: each `it` failed before its fix. ----

describe("F3. a cap's limit typed by hand while its kind is “No limit”", () => {
  const SF = { amountCents: null, basis: "fixed", cap: { kind: "none", n: null, ratio: null }, paidVia: "invoice", requiredDocs: [], prov: { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } };
  const byHand = async (seed: string) => {
    const { studyId } = await newStudy(app, seed, { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    const type = (path: string, value: unknown) => patch(`/studies/${studyId}/versions/1/values`, { path, value, note: "x", by: "Asha" });
    expect((await type("/screenFail", SF)).statusCode).toBe(200);
    return { studyId, type };
  };

  it("is refused in words, whichever is typed second, the figure or the kind; nothing is written or logged", async () => {
    const { studyId, type } = await byHand("cap-hand");
    const before = await storedVersion(built, studyId, 1);
    const logged = async () => (await get<AuditPage>(`/audit?studyId=${studyId}`)).items.filter((e) => e.action === "value.typed").length;
    const was = await logged();
    const figure = { statusCode: 409, message: "This cap is set to “No limit”, so there's no limit to type here. If the contract does set one, change the cap's kind first." };
    expect((await type("/screenFail/cap/n", 7)).json()).toMatchObject(figure);
    expect((await type("/screenFail/cap/ratio", 0.5)).json()).toMatchObject(figure);
    expect((await type("/screenFail", { ...SF, cap: { kind: "none", n: 7, ratio: null } })).json()).toMatchObject(figure);
    const after = await storedVersion(built, studyId, 1);
    expect([after.rulebook, after.evidence, after.updatedAt, await logged()]).toEqual([before.rulebook, before.evidence, before.updatedAt, was]);
    // the kind first, then its limit: "No limit" over it is refused until the limit is cleared
    expect((await type("/screenFail/cap/kind", "count")).statusCode).toBe(200);
    expect((await type("/screenFail/cap/n", 7)).statusCode).toBe(200);
    expect((await type("/screenFail/cap/kind", "none")).json()).toMatchObject({
      statusCode: 409,
      message: "This cap still has a limit typed, so it can't be “No limit”. Clear the limit first, or pick the kind of limit the contract sets.",
    });
    expect((await type("/screenFail/cap/n", null)).statusCode).toBe(200);
    expect((await type("/screenFail/cap/kind", "none")).statusCode).toBe(200);
    expect((await storedVersion(built, studyId, 1)).rulebook!.screenFail!.cap).toEqual({ kind: "none", n: null, ratio: null });
  });

  it("one typed before the rule can still be cleared a figure at a time", async () => {
    const { studyId, type } = await byHand("cap-hand-old");
    await setRulebook(studyId, (rb) => (rb.screenFail!.cap = { kind: "none", n: 7, ratio: 0.5 }));
    expect((await type("/screenFail/cap/n", null)).statusCode).toBe(200);
    expect((await type("/screenFail/cap/ratio", 0.25)).statusCode).toBe(409);
    expect((await type("/screenFail/cap/ratio", null)).statusCode).toBe(200);
  });
});
