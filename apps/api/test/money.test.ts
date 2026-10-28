import { bindEvidence, isoDate, reviewFromEvidence, runContractChecks, type TextPage } from "@dct/extraction";
import { type AlertPage, type AuditPage, billedGrids, type DocumentDto, type ReviewItem, type Rulebook, type RulebookVersionDto, type StudyPage } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { rulebookVersions } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrate.js";
import { carryGrid } from "../src/domain.js";
import { fakeControls, fakeExtraction } from "../src/extraction/fake.js";
import { plainWarnings } from "../src/jobs.js";
import { answer as answerDraft, at, recheck, reviewDraft } from "../src/review.js";
import { type App, type Built, extract, liveStudy, makePdf, newStudy, resetDb, settleAll, signOff, storedVersion, testApp, upload, waitJob } from "./helpers.js";

// Regressions for the review of money paths: each `it` failed before its fix.

// ExcelJS is a dependency of @dct/shared only; load it from there to read the export back.
type Row = { values: unknown[] };
type Workbook = { xlsx: { load(b: Buffer): Promise<unknown> }; getWorksheet(name: string): { eachRow(fn: (r: Row) => void): void } | undefined };
const ExcelJS = createRequire(path.resolve(import.meta.dirname, "../../../packages/shared/package.json"))("exceljs") as { Workbook: new () => Workbook };

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
  fakeControls.warnings = [];
  await resetDb(built);
});

const get = async <T>(url: string) => (await app.inject({ url: `/api/v1${url}` })).json<T>();
const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, payload });
const patch = (url: string, payload: object) => app.inject({ method: "PATCH", url: `/api/v1${url}`, payload });
const version = (id: string, v = 1) => get<RulebookVersionDto>(`/studies/${id}/versions/${v}`);
const auditOf = async (id: string) => (await get<AuditPage>(`/audit?studyId=${id}&limit=100`)).items;
const answer = async (id: string, item: string, body: object, v = 1) => {
  const res = await post(`/studies/${id}/versions/${v}/review/${encodeURIComponent(item)}`, { by: "Sam", ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<RulebookVersionDto>().review.find((i) => i.id === item)!;
};
async function draft(seed = "s", opts?: { scan?: boolean }) {
  const s = await newStudy(app, seed, opts);
  expect((await extract(app, s.studyId)).job.state).toBe("succeeded");
  return s;
}

// The real checks and the real binder, on the fake read's rulebook (no AI, no database).
const port = { bindEvidence, reviewFromEvidence };
const docs = [{ id: "d1", filename: "Work Order.pdf" }];
const base = async () => (await fakeExtraction.extractStudy({ documents: [{ id: "d1", filename: "Work Order.pdf", path: "", kind: "work_order" }] })).rulebook;
const local = (rulebook: Rulebook, review: ReviewItem[] = []) => ({ version: 1, byHand: false, rulebook, review, evidence: [] as RulebookVersionDto["evidence"], editors: [] as string[] });

describe("1. bill by hand: a money term the master can't hold is listed on the master itself", () => {
  const PARKING = "Sponsor will reimburse parking at $12.00 per subject visit.";

  it("a bill-by-hand answer lists it; another answer takes it off; approval, the export and a correction keep it", async () => {
    const { studyId, doc } = await draft();
    const term = (await version(studyId)).review.find((i) => i.reason === "UNACCOUNTED_TERM")!;
    expect(term.term).toEqual({ quote: PARKING, amounts: [1200] });
    await answer(studyId, term.id, { optionId: "bill_by_hand" });
    const entry = { label: PARKING, quote: PARKING, page: 1, amounts: [1200], note: "", prov: { source: { documentId: doc.id, page: 1 }, confidence: 1, method: "manual", crossCheck: "not_checked" }, itemId: term.id };
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toEqual([entry]);
    await answer(studyId, term.id, { optionId: "not_payment" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toEqual([]);
    await answer(studyId, term.id, { optionId: "bill_by_hand", note: "Billed monthly with the visits" });
    expect((await auditOf(studyId)).filter((e) => e.detail.itemId === term.id).map((e) => [e.action, e.detail.billByHand ?? e.detail.offBillByHand])).toEqual([
      ["review.changed", PARKING],
      ["review.changed", PARKING],
      ["review.answered", PARKING],
    ]);

    await settleAll(built, studyId, 1);
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
    expect((await version(studyId)).rulebook!.unclassified).toEqual([{ ...entry, note: "Billed monthly with the visits" }]);

    const x = await app.inject({ url: `/api/v1/studies/${studyId}/versions/1/export.xlsx` });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload);
    const rows: string[] = [];
    wb.getWorksheet("Bill by hand")!.eachRow((r: Row) => rows.push(r.values.slice(1).join(" | ")));
    expect(rows[1]).toBe(`${PARKING} | ${PARKING} | Work Order.pdf | 1 | $12.00 |  |  | Billed monthly with the visits`);

    // "This looks wrong" on the live version: the correction draft is a copy, list and all
    const v2 = (await post(`/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Sam" })).json<RulebookVersionDto>();
    expect(v2.rulebook!.unclassified).toEqual([{ ...entry, note: "Billed monthly with the visits" }]);
  });

  it("a scan page listed to bill by hand needs a note saying what's on it, and goes on the list as that page", async () => {
    const { studyId, doc } = await draft("scan", { scan: true });
    const page = `page:${doc.id}:1`;
    const bare = await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(page)}`, { optionId: "bill_by_hand", by: "Sam" });
    expect([bare.statusCode, bare.json().message]).toEqual([400, "Add a short note for this answer: what on this page is billed by hand? Name each term and its amount."]);
    await answer(studyId, page, { optionId: "bill_by_hand", note: "Parking, $12 a visit" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toMatchObject([{ label: "Page 1 of “Work Order.pdf”", quote: "", page: 1, amounts: [], note: "Parking, $12 a visit", itemId: page }]);
    // sent back, it's off the list until it's answered again
    await post(`/studies/${studyId}/versions/1/send-back`, { itemIds: [page], note: "Which visits?", by: "Morgan" });
    expect((await storedVersion(built, studyId, 1)).rulebook!.unclassified).toEqual([]);
  });
});

describe("2–3. the governing grid is chosen per arm, and an amendment's new grid is asked again", () => {
  const arms = async () => {
    const rb = await base();
    const [g1, g2] = rb.budgetGrids as [Rulebook["budgetGrids"][number], Rulebook["budgetGrids"][number]];
    const arm = (g: typeof g1, id: string, label: string, a: string, bump: number) => ({ ...structuredClone(g), id, label, arm: a, visits: g.visits.map((v) => ({ ...v, totalCents: v.totalCents + bump })) });
    rb.budgetGrids = [arm(g1, "gA1", "Arm A exhibit", "Arm A", 0), arm(g1, "gA2", "Arm A budget", "Arm A", 100), arm(g2, "gB1", "Arm B exhibit", "Arm B", 0), arm(g2, "gB2", "Arm B budget", "Arm B", 200)];
    return rb;
  };

  it("one question per arm; a pick for one arm never changes another's", async () => {
    const rb = await arms();
    const { review, evidence } = reviewDraft(port, rb, runContractChecks(rb), [], docs);
    const grid = review.filter((i) => i.reason === "GRID_CONFLICT");
    expect(grid.map((i) => [i.path, i.question.split(":")[0], i.options.map((o) => o.id)])).toEqual([
      [null, "Arm A", ["gA1", "gA2"]],
      [null, "Arm B", ["gB1", "gB2"]],
    ]);
    const d = { ...local(rb, review), evidence };
    answerDraft(d, grid[0]!.id, { optionId: "gA2", by: "Asha" }, isoDate);
    answerDraft(d, grid[1]!.id, { optionId: "gB1", by: "Asha" }, isoDate);
    expect(d.rulebook.governingGridIds).toEqual(["gA2", "gB1"]);
    answerDraft(d, grid[0]!.id, { optionId: "gA1", by: "Asha" }, isoDate); // arm A changes its mind; arm B's stays
    expect(d.rulebook.governingGridIds).toEqual(["gB1", "gA1"]);
    expect(billedGrids(d.rulebook).map((g) => g.id)).toEqual(["gA1", "gB1"]);
  });

  it("an arm's choice is carried only while its grids are the same; an added grid asks again", async () => {
    const live = { ...(await base()), governingGridIds: ["g1"] };
    const added = await base();
    added.budgetGrids.push({ ...structuredClone(added.budgetGrids[0]!), id: "g3", label: "Amendment 1 budget", visits: added.budgetGrids[0]!.visits.map((v) => ({ ...v, totalCents: v.totalCents + 50000 })) });
    expect(carryGrid(added, live)).toEqual([]);
    const asked = reviewDraft(port, added, runContractChecks(added), [], docs).review.filter((i) => i.reason === "GRID_CONFLICT");
    expect(asked.map((i) => i.options.map((o) => o.id))).toEqual([["g1", "g2", "g3"]]);
    // the same grids: carried, and not asked again
    const same = await base();
    expect(carryGrid(same, live)).toEqual(["g1"]);
    const carried = { ...same, governingGridIds: ["g1"] };
    expect(reviewDraft(port, carried, runContractChecks(carried), [], docs).review.filter((i) => i.reason === "GRID_CONFLICT")).toEqual([]);
    // a version's one pick from before per-arm choices counts for its own arm
    expect(carryGrid(same, { ...live, governingGridIds: [], governingGridId: "g2" })).toEqual(["g2"]);
  });
});

describe("4. maker-checker", () => {
  it("a re-typer whose answer changes a value is an editor, so they can't approve alone", async () => {
    const { studyId } = await newStudy(app, "hand", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    const CELL = "/budgetGrids/0/procedures/0/cells/V1";
    for (const [p, value] of [[CELL, 5500], ["/budgetGrids/0/visits/0/totalCents", 5500], ["/budgetGrids/0/procedures/0/name", "Blood draw"], ["/payment/netDays/value", 45]] as const)
      expect((await patch(`/studies/${studyId}/versions/1/values`, { path: p, value, note: "x", by: "Asha" })).statusCode).toBe(200);
    expect((await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" })).statusCode).toBe(200);
    await patch("/settings", { makerChecker: true, by: "Morgan" });
    // Bob re-types the cell as $99.00: it differs, and he keeps his own value
    expect(await answer(studyId, `spot:${CELL}`, { value: 9900, by: "Bob" })).toMatchObject({ outcome: "differs" });
    expect(await answer(studyId, `spot:${CELL}`, { value: 9900, note: "page 2, row 1", by: " Bob " })).toMatchObject({ outcome: "chosen" });
    const stored = await storedVersion(built, studyId, 1);
    expect([at(stored.rulebook, CELL), stored.editors]).toEqual([9900, ["Asha", "Bob"]]);
    // having changed a value, he's no longer independent of what's on the contract: someone else re-types the rest
    const next = stored.review.find((i) => i.outcome === null)!;
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(next.id)}`, { value: 1, by: "Bob" })).json().message).toBe(
      "Bob changed a value on this contract, so someone else has to re-type the rest.",
    );
    await settleAll(built, studyId, 1, "Carol");
    expect((await signOff(app, studyId, 1, { by: "bob" })).json().message).toBe("Maker-checker is on: bob answered questions on this contract, so someone else has to approve it.");
    expect((await signOff(app, studyId, 1, { by: "Carol" })).statusCode).toBe(200);
  });

  it("is on in a new database", async () => {
    const name = `dct_finance_test_fresh_${process.pid}`;
    await built.ctx.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name}`));
    await built.ctx.db.execute(sql.raw(`CREATE DATABASE ${name}`));
    const url = config.databaseUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
    try {
      await runMigrations(url);
      const client = new pg.Client(url);
      await client.connect();
      try {
        expect((await client.query("SELECT maker_checker FROM settings")).rows).toEqual([{ maker_checker: true }]);
      } finally {
        await client.end();
      }
    } finally {
      await built.ctx.db.execute(sql.raw(`DROP DATABASE IF EXISTS ${name}`));
    }
  });
});

describe("5. every question holds approval; a Review question clears by a choice or a reason with a note", () => {
  const G1_TOTAL = "/budgetGrids/0/visits/1/totalCents"; // the fake read: printed 8,489.00, its parts add up to 8,488.00

  it("a total the contract prints wrong asks which number governs, with a note for the sponsor; the sum writes the sum", async () => {
    // one grid row of $55.00 plus 40% overhead is $77.00 a visit; Week 0 prints $78.00
    const rb = await base();
    rb.rounding.value = "cents";
    const g = rb.budgetGrids[0]!;
    g.visits = g.visits.map((v, i) => ({ ...v, procedureSubtotalCents: 5500, overheadCents: 2200, nonProcedureCents: 0, totalCents: i ? 7800 : 7700 }));
    g.perPatientTotals = [{ ...g.perPatientTotals[0]!, cents: 15500 }];
    const [problem, ...more] = recheck((r) => runContractChecks(r), { rulebook: rb, review: [], anomalies: [] }, G1_TOTAL);
    expect(more).toEqual([]);
    expect(problem).toMatchObject({ reason: "VISIT_TOTAL_MISMATCH", blocking: false, options: [{ id: "printed", note: "What should we ask the sponsor?" }, { id: "sum", note: "What should we ask the sponsor?" }] });
    const d = local(rb, [problem!]);
    expect(() => answerDraft(d, problem!.id, { optionId: "sum", by: "Asha" }, isoDate)).toThrow("Add a short note for this answer: what should we ask the sponsor?");
    answerDraft(d, problem!.id, { optionId: "sum", note: "Why is the Week 0 total a dollar over its parts?", by: "Asha" }, isoDate);
    expect([at(d.rulebook, G1_TOTAL), d.review[0]!.outcome, d.evidence]).toEqual([7700, "chosen", [expect.objectContaining({ path: G1_TOTAL, status: "attested" })]]);
  });

  it("through the API: the choice is written and logged like a correction, and can't-tell on a Review question still holds approval", async () => {
    const { studyId } = await draft();
    const id = `anomaly:VISIT_TOTAL_MISMATCH:${G1_TOTAL}`;
    await settleAll(built, studyId, 1);
    await answer(studyId, id, { cantTell: true });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).json().message).toBe("1 question still needs an answer before this can be approved.");
    await answer(studyId, id, { optionId: "sum", note: "Query the Week 0 total" });
    expect(at((await storedVersion(built, studyId, 1)).rulebook, G1_TOTAL)).toBe(848800);
    expect((await auditOf(studyId)).find((e) => e.detail.itemId === id && "after" in e.detail)!.detail).toMatchObject({ path: G1_TOTAL, before: 848900, after: 848800 });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });

  it("other Review questions offer a choice or a reason that needs a note", async () => {
    const { studyId } = await draft();
    const doc = "anomaly:MISSING_REFERENCED_DOC:/referencedDocuments/0";
    expect((await version(studyId)).review.find((i) => i.id === doc)!.options).toEqual([
      { id: "later", label: "Go ahead; I'll upload it later" },
      { id: "not_needed", label: "It doesn't affect billing", note: "Why doesn't it affect billing?" },
    ]);
    expect((await post(`/studies/${studyId}/versions/1/review/${encodeURIComponent(doc)}`, { optionId: "not_needed", note: "  ", by: "Sam" })).statusCode).toBe(400);
    expect(await answer(studyId, doc, { optionId: "not_needed", note: "It only sets the governing law" })).toMatchObject({ outcome: "chosen" });
  });
});

describe("7. an amendment being read, or one that couldn't be read, is never “waiting for approval”", () => {
  it("shows as reading, then as couldn't read, with its alert; “This looks wrong” on the live version says what to do", async () => {
    const { studyId } = await liveStudy(built, "amend");
    const status = async () => (await built.ctx.db.execute<{ status: string; stage: number }>(sql`SELECT status, stage FROM studies WHERE id = ${studyId}`)).rows[0];
    const views = async () => Object.fromEntries(await Promise.all(["approval", "failed", "live"].map(async (v) => [v, (await get<StudyPage>(`/studies?view=${v}`)).items.some((s) => s.id === studyId)])));
    const alerts = async () => (await get<AlertPage>("/alerts?for=Zed&limit=50")).items.filter((a) => a.studyId === studyId).map((a) => `${a.kind}@${a.version}`);
    const report = () => post(`/studies/${studyId}/versions/1/report`, { path: "/siteFees/0/amountCents", note: "check", by: "Sam" });
    let release!: () => void;
    fakeControls.hold = new Promise<void>((r) => (release = r));
    try {
      const q = (await post(`/studies/${studyId}/extract`, { by: "Asha" })).json<{ jobId: string }>();
      expect(await status()).toEqual({ status: "extracting", stage: 4 });
      expect(await views()).toEqual({ approval: false, failed: false, live: false });
      expect((await report()).json().message).toBe("Version 2 is being read right now. When it's ready, report this there.");
      fakeControls.failNext = 1;
      release();
      expect((await waitJob(app, q.jobId)).state).toBe("failed");
    } finally {
      release();
      fakeControls.hold = null;
    }
    expect(await status()).toEqual({ status: "extraction_failed", stage: 1 });
    expect(await views()).toEqual({ approval: false, failed: true, live: false });
    expect(await alerts()).toEqual(["couldnt_read@2", "ready_for_approval@1", "questions_ready@1"]);
    expect((await report()).json().message).toBe("The amendment in version 2 couldn't be read. Read it again, or type it in by hand, then report this on that version.");
    // read again: the same version, and it's a draft under review now
    expect((await extract(app, studyId)).v).toBe(2);
    expect(await status()).toMatchObject({ status: "amendment_in_review" });
  });
});

describe("8. a contract typed by hand is checked, and nothing nobody typed is approved", () => {
  it("marking typing done runs the checks on what was typed; a total that doesn't add up is asked once its numbers are re-typed", async () => {
    const { studyId } = await newStudy(app, "hand", { scan: true });
    fakeControls.failNext = 1;
    await extract(app, studyId);
    await post(`/studies/${studyId}/versions/by-hand`, { by: "Asha" });
    const v0 = "/budgetGrids/0/visits/0";
    // subtotal 100 + overhead 40 ≠ total 150
    for (const [p, value] of [[`${v0}/procedureSubtotalCents`, 10000], [`${v0}/overheadCents`, 4000], [`${v0}/totalCents`, 15000]] as const)
      expect((await patch(`/studies/${studyId}/versions/1/values`, { path: p, value, note: "x", by: "Asha" })).statusCode).toBe(200);
    const done = (await post(`/studies/${studyId}/versions/1/by-hand/done`, { by: "Asha" })).json<RulebookVersionDto>();
    // the re-typed numbers hold the check back (one flag per root cause); it was found, and is asked after
    expect(done.review.map((i) => i.reason)).toEqual(["spot_check", "spot_check", "spot_check"]);
    await settleAll(built, studyId, 1, "Bob", 3);
    const v = await storedVersion(built, studyId, 1);
    expect(v.review.find((i) => i.reason === "VISIT_TOTAL_MISMATCH")).toMatchObject({ id: `anomaly:VISIT_TOTAL_MISMATCH:${v0}/totalCents`, outcome: null });
  });
});

describe("9. blind entry: a withheld value's neighbouring words never give it away", () => {
  it("blanks the numbers in its item's words and its location while it's open, and shows them once it's answered", async () => {
    const { studyId, doc } = await draft();
    const row = await storedVersion(built, studyId, 1);
    const rb = structuredClone(row.rulebook!);
    // the read's 6-month deadline (nothing on the page backs it, so it's asked) with words that restate it
    rb.deadlines[0] = { ...rb.deadlines[0]!, consequence: "not approved if sent more than 6 months after close", prov: { ...rb.deadlines[0]!.prov, source: { documentId: doc.id, page: 1, location: "§5.2 (6 months)" } } };
    await built.ctx.db.update(rulebookVersions).set({ rulebook: rb }).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, 1)));
    const shown = (await version(studyId)).rulebook!.deadlines[0]!;
    expect(shown).toMatchObject({ value: null, kind: "invoice_months_after_study_close", consequence: "not approved if sent more than ••• months after close" });
    expect(shown.prov.source).toEqual({ documentId: doc.id, page: 1, location: "§5.2 (••• months)" });
    expect((await app.inject({ url: `/api/v1/studies/${studyId}/versions/1` })).body).not.toMatch(/6 months/);
    await answer(studyId, "confirm:/deadlines/0/value", { value: 6 });
    expect((await version(studyId)).rulebook!.deadlines[0]).toMatchObject({ value: 6, consequence: "not approved if sent more than 6 months after close" });
  });
});

describe("approval: the version as the approver saw it", () => {
  it("is refused if anything changed since they opened it", async () => {
    const { studyId } = await draft();
    await settleAll(built, studyId, 1);
    const seen = (await version(studyId)).updatedAt;
    await post(`/studies/${studyId}/versions/1/proofread`, { paths: ["/siteFees/0/amountCents"], by: "Asha" });
    expect((await signOff(app, studyId, 1, { by: "Ben", asOf: seen })).json()).toMatchObject({ statusCode: 409, message: "This contract changed since you opened it. Check it again." });
    expect((await signOff(app, studyId, 1, { by: "Ben" })).statusCode).toBe(200);
  });
});

describe("10. lows", () => {
  const cause = (p: Promise<unknown>) => p.then(() => "no error", (e: { cause?: { message?: string }; message: string }) => e.cause?.message ?? e.message);

  it("the audit log and signed versions refuse TRUNCATE, directly and through CASCADE", async () => {
    await liveStudy(built);
    const count = async () => (await built.ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_log`)).rows[0]!.n;
    const before = await count();
    expect(await cause(built.ctx.db.execute(sql`TRUNCATE audit_log`))).toBe("audit_log is append-only");
    expect(await cause(built.ctx.db.execute(sql`TRUNCATE rulebook_versions CASCADE`))).toMatch(/append-only|immutable/);
    expect(await cause(built.ctx.db.execute(sql`TRUNCATE studies CASCADE`))).toMatch(/append-only|immutable/);
    expect(await count()).toBe(before);
  });

  it("an upload takes its files' locks in sha256 order, so two that share files queue up instead of deadlocking", async () => {
    const [a, b] = [await makePdf("lock-a"), await makePdf("lock-b")];
    const sha = (x: Buffer) => createHash("sha256").update(x).digest("hex");
    const [low, high] = sha(a) < sha(b) ? [a, b] : [b, a];
    // someone else holds the lower file's lock
    const other = new pg.Client(config.databaseUrl);
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(7102, hashtext($1))", [sha(low)]);
      // the higher file comes first in this upload
      const sent = upload(app, [{ name: "high.pdf", data: high }, { name: "low.pdf", data: low }]);
      for (let i = 0; i < 100; i++) {
        const { rows } = await other.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 7102 AND NOT granted");
        if (rows[0].n) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // it waits for the lower one without having taken the higher one
      expect((await other.query("SELECT pg_try_advisory_xact_lock(7102, hashtext($1)) AS ok", [sha(high)])).rows[0].ok).toBe(true);
      await other.query("ROLLBACK");
      expect((await sent).statusCode).toBe(201);
    } finally {
      await other.end();
    }
  });

  it("an upload over the limits says so in plain words", async () => {
    const many = await Promise.all(Array.from({ length: 51 }, async (_, i) => ({ name: `f${i}.pdf`, data: await makePdf(`many-${i}`, 1) })));
    expect((await upload(app, many)).json()).toMatchObject({ statusCode: 413, message: "Upload at most 50 files at once." });
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(config.maxUploadBytes)]);
    expect((await upload(app, [{ name: "big.pdf", data: big }])).json()).toMatchObject({ statusCode: 413, message: "This file is bigger than the 50 MB limit. Split it into smaller PDFs and upload those." });
  });

  it("a weaker reading is said in plain words with the version, and logged in the reading's own words", async () => {
    const said = ["The re-read of budget grid 2 failed, so the first read was kept: timed out", "The cross-read is off (CROSS_READ=off, or no key)."];
    expect(plainWarnings(said)).toEqual(["Budget grid 2 was read only once: its second, closer reading failed. Check its numbers with extra care."]);
    fakeControls.warnings = said;
    const { studyId } = await draft();
    expect((await version(studyId)).warnings).toEqual(plainWarnings(said));
    expect((await auditOf(studyId)).find((e) => e.action === "extraction.completed")!.detail.warnings).toEqual(said);
  });
});

describe("11. a text page with a picture big enough to hold prices is attested like a scan", () => {
  it("asks about the page, and bill by hand lists it", async () => {
    const rb = await base();
    const pages: TextPage[] = [{ documentId: "d1", page: 3, width: 612, height: 792, source: "text", words: [], hidden: 0, largePicture: true }];
    const { review, evidence } = reviewDraft(port, rb, [], pages, docs);
    const picture = review.find((i) => i.reason === "PICTURE_PAGE")!;
    expect(picture).toMatchObject({
      id: "picture:d1:3", kind: "unaccounted", blocking: true, path: null, where: [{ documentId: "d1", page: 3, box: null }],
      question: "Page 3 of “Work Order.pdf” has a picture that may contain prices, and a picture can't be searched for money terms. Does it have any that the invoicing master doesn't hold?",
    });
    expect(picture.options.map((o) => o.id)).toEqual(["none", "bill_by_hand"]);
    const d = { ...local(rb, review), evidence };
    answerDraft(d, picture.id, { optionId: "bill_by_hand", note: "Pharmacy fee table, $1,500 set-up", by: "Asha" }, isoDate);
    expect(d.rulebook.unclassified).toMatchObject([{ label: "Page 3 of “Work Order.pdf”", page: 3, note: "Pharmacy fee table, $1,500 set-up", itemId: picture.id }]);
    // no picture, no question
    expect(reviewDraft(port, rb, [], [{ ...pages[0]!, largePicture: false }], docs).review.map((i) => i.reason)).not.toContain("PICTURE_PAGE");
  });
});

describe("answering again", () => {
  it("the same settling answer again, from the same person, changes nothing (it used to reopen the question)", async () => {
    const { studyId } = await draft();
    const item = "confirm:/budgetGrids/1/visits/1/totalCents"; // the PDF prints 8,489.00
    expect(await answer(studyId, item, { value: 849000 })).toMatchObject({ outcome: "differs" });
    const keep = { value: 849000, note: "The page shows a correction in ink" };
    expect(await answer(studyId, item, keep)).toMatchObject({ outcome: "chosen" });
    const logged = (await auditOf(studyId)).length;
    const before = await storedVersion(built, studyId, 1);
    expect(await answer(studyId, item, keep)).toMatchObject({ outcome: "chosen" });
    expect([(await auditOf(studyId)).length, (await storedVersion(built, studyId, 1)).updatedAt]).toEqual([logged, before.updatedAt]);
  });
});

describe("a shared file's kind", () => {
  it("a change is logged on every study that uses the file", async () => {
    const { studyId: one, doc } = await newStudy(app, "shared");
    const [other] = (await upload(app, [{ name: "Work order 2.pdf", data: await makePdf("other") }])).json<DocumentDto[]>();
    const two = (await post("/studies", { documentIds: [doc.id, other!.id] })).json<{ studyId: string; jobId: string }>();
    await waitJob(app, two.jobId);
    expect((await patch(`/documents/${doc.id}`, { kind: "master_agreement", by: "Asha" })).statusCode).toBe(200);
    for (const id of [one, two.studyId]) expect((await auditOf(id))[0]).toMatchObject({ action: "document.kind_set", by: "Asha", detail: { documentId: doc.id, to: "master_agreement" } });
  });
});

describe("uploads, with the locks taken first", () => {
  it("a file twice in one upload, or already stored, is still one document", async () => {
    const pdf = await makePdf("dup");
    const [first] = (await upload(app, [{ name: "a.pdf", data: pdf }])).json<DocumentDto[]>();
    const [again] = (await upload(app, [{ name: "a.pdf", data: pdf }, { name: "b.pdf", data: pdf }])).json<DocumentDto[]>();
    expect(again!.duplicateOf).toBe(first!.id);
  });
});
