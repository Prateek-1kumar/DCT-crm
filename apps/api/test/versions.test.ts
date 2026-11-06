import type { Question, Rulebook } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checks } from "@dct/harness";
import { buildApp } from "../src/app.js";
import { answers, auditLog, documents, parties, reads, studies, versions } from "../src/db/schema.js";
import { loadDocs } from "../src/lib/docs.js";
import { savePdf, scanStore } from "../src/lib/storage.js";
import type { App, Built } from "./helpers.js";

let built: Built;
let app: App;
let docId: string;

beforeAll(async () => {
  built = await buildApp({
    routes: (api, { db }) => {
      api.post("/test/rewrite/:id", async (req) => {
        await db.update(versions).set({ rulebook: null }).where(eq(versions.id, (req.params as { id: string }).id));
        return { ok: true };
      });
    },
  });
  app = built.app;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  // a page needs a real amount of text to count as text rather than a scan
  ["Startup fee $1,500.00 due on signing.", "The sponsor pays the institution within forty-five days of an itemized invoice for work done.", "Payments are made by wire transfer to the account named in the notice given by the institution.", "Either party may end this agreement by written notice if the other fails to correct a breach within thirty days.", "Records are kept for the period the law requires and the sponsor may audit them during business hours."].forEach((line, i) =>
    page.drawText(line, { x: 40, y: 700 - i * 20, size: 9, font }),
  );
  const sha256 = await savePdf(Buffer.from(await pdf.save()));
  const [doc] = await built.ctx.db
    .insert(documents)
    .values({ sha256, name: "contract.pdf", bytes: 1, pages: [{ page: 1, kind: "text", chars: 250, firstLine: "Startup fee" }], createdBy: "test" })
    .onConflictDoUpdate({ target: documents.sha256, set: { name: "contract.pdf" } })
    .returning();
  docId = doc!.id;
});
afterAll(() => app.close());

const db = () => built.ctx.db;
const source = { doc: "contract.pdf", page: 1, quote: "Startup fee $1,500.00" };

const term = (id: string, over: Partial<Rulebook["terms"][number]> = {}): Rulebook["terms"][number] => ({
  id, category: "site_fee", name: `Fee ${id}`, amountCents: null, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null,
  conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const question = (id: string, over: Partial<Question> = {}): Question => ({
  id, kind: "decision", origin: "compile", about: null, question: `Question ${id}?`, context: "", source,
  options: [{ label: "Yes", patches: [{ target: "term", id: "t1", set: { notes: "Confirmed" } }] }, { label: "Nothing changes", patches: [] }],
  suggestion: null, state: "open", blocking: true, readings: [], resolution: null, ...over,
});

const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [term("t1", { amountCents: 150000 })], grids: [], accounted: [], questions: [], ...over,
});

const badQuote = { check: "quote", id: "t2", doc: "contract.pdf", page: 1, message: "quote not found on p.1 of contract.pdf" };
const withBadQuote = (over: Partial<Rulebook> = {}) =>
  rulebook({
    terms: [term("t1", { amountCents: 150000 }), term("t2", { source: { ...source, quote: "Closeout fee" } })],
    questions: [question("q-fix", { blocking: false, options: [{ label: "It is the signing clause", patches: [{ target: "term", id: "t2", set: { source: { ...source, quote: "due on signing" } } }] }, { label: "Leave it", patches: [] }] })],
    ...over,
  });

async function otherDoc() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(`Other ${randomUUID()}`, { x: 40, y: 700, size: 9, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const sha256 = await savePdf(Buffer.from(await pdf.save()));
  const [doc] = await db().insert(documents).values({ sha256, name: `other-${sha256.slice(0, 6)}.pdf`, bytes: 1, pages: [{ page: 1, kind: "image", chars: 0, firstLine: "" }], createdBy: "test" }).returning();
  return doc!.id;
}

/** A document with one scanned page: no text layer in the PDF, and a transcription saved for it. */
async function scannedDoc() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.setTitle(randomUUID());
  const sha256 = await savePdf(Buffer.from(await pdf.save()));
  const words = ["Exhibit", "A"].map((text, i) => ({ text, x0: 0.05 + i * 0.1, x1: 0.1 + i * 0.1, y0: 0.05, y1: 0.06 }));
  await scanStore.put(sha256, { page: 1, version: "test", rotation: 0, words });
  const [doc] = await db().insert(documents).values({ sha256, name: "scan.pdf", bytes: 1, pages: [{ page: 1, kind: "scan", chars: 9, firstLine: "Exhibit A" }], createdBy: "test" }).returning();
  return doc!.id;
}

async function study() {
  const [sponsor, site] = await db()
    .insert(parties)
    .values([{ kind: "sponsor", name: `Sponsor ${randomUUID()}`, createdBy: "test" }, { kind: "site", name: `Site ${randomUUID()}`, createdBy: "test" }])
    .returning();
  const [s] = await db().insert(studies).values({ protocol: `P-${randomUUID()}`, sponsorId: sponsor!.id, siteId: site!.id, createdBy: "test" }).returning();
  return s!.id;
}

async function seed(opts: { documentIds?: string[]; rulebook?: Rulebook; status?: (typeof versions.$inferInsert)["status"]; problems?: (typeof versions.$inferInsert)["problems"]; studyId?: string; number?: number } = {}) {
  const studyId = opts.studyId ?? (await study());
  const status = opts.status ?? "draft";
  const [v] = await db()
    .insert(versions)
    .values({
      studyId, number: opts.number ?? 1, status, documentIds: opts.documentIds ?? [docId], rulebook: opts.rulebook ?? rulebook(), problems: opts.problems ?? [], createdBy: "test",
      ...(status === "approved" || status === "superseded" ? { approvedAt: new Date(), approvedBy: "Old Approver" } : {}),
    })
    .returning();
  return { studyId, id: v!.id };
}

const answer = (id: string, questionId: string, body: unknown) => app.inject({ method: "POST", url: `/api/v1/versions/${id}/questions/${encodeURIComponent(questionId)}/answer`, payload: body as object });
const approve = (id: string, body: unknown) => app.inject({ method: "POST", url: `/api/v1/versions/${id}/approve`, payload: body as object });
const stored = async (id: string) => (await db().select().from(versions).where(eq(versions.id, id)))[0]!;
const audits = (entityId: string) => db().select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);
const refusal = async (p: PromiseLike<unknown>) => ((await p.then(() => null, (e: { cause?: { message?: string } }) => e)) as { cause?: { message?: string } } | null)?.cause?.message;

describe("GET /versions/:id", () => {
  it("returns the version with its answers and read", async () => {
    const { id, studyId } = await seed({ rulebook: rulebook({ questions: [question("q1")] }), problems: [badQuote] });
    expect((await db().insert(reads).values({ versionId: id, budgetUsd: 3 }).returning())[0]).toBeDefined();
    await answer(id, "q1", { option: 0, by: "Ana" });
    const res = await app.inject({ url: `/api/v1/versions/${id}` });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["answers", "approvedAt", "approvedBy", "createdAt", "createdBy", "documentIds", "documents", "id", "number", "problems", "read", "rulebook", "status", "studyId"]);
    expect(body).toMatchObject({ id, studyId, number: 1, status: "draft", documentIds: [docId], createdBy: "test", approvedAt: null, approvedBy: null });
    expect(body.documents).toEqual([{ id: docId, name: "contract.pdf", pageCount: 1 }]);
    expect(body.answers).toEqual([{ questionId: "q1", option: 0, by: "Ana", at: expect.any(String) }]);
    expect(body.read).toEqual({ id: expect.any(String), status: "queued" });
  });

  it("lists its documents in the order it was read from them", async () => {
    const { id } = await seed();
    const other = await otherDoc();
    for (const order of [[docId, other], [other, docId]]) {
      await db().update(versions).set({ documentIds: order }).where(eq(versions.id, id));
      expect((await app.inject({ url: `/api/v1/versions/${id}` })).json().documents.map((d: { id: string }) => d.id)).toEqual(order);
    }
  });

  it("has no read when none was started; unknown and malformed ids are refused", async () => {
    const { id } = await seed();
    expect((await app.inject({ url: `/api/v1/versions/${id}` })).json().read).toBeNull();
    const missing = await app.inject({ url: `/api/v1/versions/${randomUUID()}` });
    expect([missing.statusCode, missing.json().message]).toEqual([404, "There is no such version."]);
    expect((await app.inject({ url: "/api/v1/versions/nope" })).statusCode).toBe(400);
  });
});

describe("GET /versions/:id/coverage", () => {
  const coverage = (id: string) => app.inject({ url: `/api/v1/versions/${id}/coverage` });

  it("says where each printed amount went, with the document it is on", async () => {
    const { id } = await seed();
    const res = await coverage(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pages: [{
        documentId: docId, doc: "contract.pdf", page: 1, kind: "text",
        amounts: [{ box: [expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)], text: "$1,500.00", cents: 150000, status: "captured", ref: { target: "term", id: "t1" }, reason: null, line: "Startup fee $1,500.00 due on signing.", doubt: null }],
        clauses: [{ termId: "t1", boxes: [[expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]] }],
      }],
      totals: { amounts: 1, captured: 1, decided: 0, setAside: 0, missing: 0 },
    });
  });

  it("counts an amount no term, grid or note accounts for as missing", async () => {
    const { id } = await seed({ rulebook: rulebook({ terms: [term("t1", { amountCents: 99900 })] }) });
    const body = (await coverage(id)).json();
    expect(body.pages[0].amounts[0]).toMatchObject({ cents: 150000, status: "missing", ref: null });
    expect(body.totals).toEqual({ amounts: 1, captured: 0, decided: 0, setAside: 0, missing: 1 });
  });

  it("follows the version's document order", async () => {
    const { id } = await seed();
    const other = await otherDoc();
    await db().update(versions).set({ documentIds: [other, docId] }).where(eq(versions.id, id));
    expect((await coverage(id)).json().pages.map((p: { documentId: string }) => p.documentId)).toEqual([other, docId]);
  });

  it("is refused for a version not read yet, and for an unknown one", async () => {
    const { id } = await seed({ status: "reading" });
    await db().update(versions).set({ rulebook: null }).where(eq(versions.id, id));
    const unread = await coverage(id);
    expect([unread.statusCode, unread.json().message]).toEqual([409, "This version hasn't been read yet."]);
    expect((await coverage(randomUUID())).statusCode).toBe(404);
    expect((await coverage("nope")).statusCode).toBe(400);
  });
});

describe("answering a question", () => {
  it("applies the option's patches, marks the term as a person's decision, and records who and when", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    const res = await answer(id, "q1", { option: 0, by: "Ana" });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.rulebook.terms[0]).toMatchObject({ id: "t1", notes: "Confirmed", evidence: "person" });
    expect(body.rulebook.questions[0].state).toBe("answered");
    expect(body.answers).toEqual([{ questionId: "q1", option: 0, by: "Ana", at: expect.any(String) }]);
    expect((await stored(id)).rulebook).toEqual(body.rulebook);
    expect(await db().select().from(answers).where(eq(answers.versionId, id))).toHaveLength(1);
  });

  it("leaves other terms' evidence alone, and an answer with no patches changes only the question", async () => {
    const rb = rulebook({ terms: [term("t1", { amountCents: 150000 }), term("t2", { source: { ...source, quote: "due on signing" } })], questions: [question("q1")] });
    const { id } = await seed({ rulebook: rb });
    expect((await answer(id, "q1", { option: 1, by: "Ana" })).json().rulebook).toEqual({ ...rb, questions: [{ ...rb.questions[0], state: "answered" }] });
    const { id: other } = await seed({ rulebook: rb });
    const terms = (await answer(other, "q1", { option: 0, by: "Ana" })).json().rulebook.terms;
    expect(terms.map((t: { evidence: string }) => t.evidence)).toEqual(["person", "quote"]);
  });

  it("re-runs the checks: an answer that fixes a quote clears the problem, one that doesn't leaves it", async () => {
    const { id } = await seed({ rulebook: withBadQuote(), problems: [badQuote] });
    const kept = (await answer(id, "q-fix", { option: 1, by: "Ana" })).json();
    expect(kept.problems).toEqual([badQuote]);
    const { id: other } = await seed({ rulebook: withBadQuote(), problems: [badQuote] });
    const fixed = (await answer(other, "q-fix", { option: 0, by: "Ana" })).json();
    expect(fixed.problems).toEqual([]);
    expect((await stored(other)).problems).toEqual([]);
  });

  it("adds a required decision the answer makes necessary, once", async () => {
    const rb = rulebook({ terms: [term("t1", { amountCents: 150000, billing: "unknown" })], questions: [question("q1"), question("q2")] });
    const { id } = await seed({ rulebook: rb });
    const first = (await answer(id, "q1", { option: 1, by: "Ana" })).json();
    expect(first.rulebook.questions.map((q: Question) => [q.id, q.state, q.blocking])).toEqual([["q1", "answered", true], ["q2", "open", true], ["rule:billing", "open", true]]);
    const second = (await answer(id, "q2", { option: 1, by: "Ana" })).json();
    expect(second.rulebook.questions.filter((q: Question) => q.id === "rule:billing")).toHaveLength(1);
  });

  it("refuses a second answer to the same question", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    await answer(id, "q1", { option: 0, by: "Ana" });
    const again = await answer(id, "q1", { option: 1, by: "Ben" });
    expect([again.statusCode, again.json().message]).toEqual([409, "This question has already been answered"]);
    expect(await db().select().from(answers).where(eq(answers.versionId, id))).toHaveLength(1);
  });

  it.each(["reading", "failed", "approved", "superseded"] as const)("refuses to answer a %s version", async (status) => {
    const { id } = await seed({ status, rulebook: rulebook({ questions: [question("q1")] }) });
    const res = await answer(id, "q1", { option: 0, by: "Ana" });
    expect([res.statusCode, res.json().message]).toEqual([409, `This version is ${status}, so it can't be answered. Only a draft can.`]);
    expect(await db().select().from(answers).where(eq(answers.versionId, id))).toHaveLength(0);
  });

  it("404s an unknown version or question", async () => {
    const { id } = await seed();
    const noQuestion = await answer(id, "nope", { option: 0, by: "Ana" });
    expect([noQuestion.statusCode, noQuestion.json().message]).toEqual([404, "This version has no such question."]);
    expect((await answer(randomUUID(), "q1", { option: 0, by: "Ana" })).statusCode).toBe(404);
  });

  it.each([
    [{ option: 2, by: "Ana" }, "This question has 2 options: pick one of them."],
    [{ option: -1, by: "Ana" }, "Pick one of the options."],
    [{ option: 0.5, by: "Ana" }, "Pick one of the options."],
    [{ by: "Ana" }, "Pick one of the options."],
    [{ option: 0 }, "Say who is doing this: pick your name first."],
    [{ option: 0, by: "  " }, "Say who is doing this: pick your name first."],
    [undefined, "The request is missing its details."],
  ])("refuses a bad answer %j", async (body, message) => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    const res = await answer(id, "q1", body);
    expect([res.statusCode, res.json().message]).toEqual([400, message]);
    expect(await db().select().from(answers).where(eq(answers.versionId, id))).toHaveLength(0);
    expect(await audits(id)).toHaveLength(0);
  });

  it("refuses an answer whose patches don't fit, and saves nothing", async () => {
    const rb = rulebook({ questions: [question("q1", { options: [{ label: "Broken", patches: [{ target: "term", id: "t1", set: { nosuch: 1 } }] }] })] });
    const { id } = await seed({ rulebook: rb });
    const res = await answer(id, "q1", { option: 0, by: "Ana" });
    expect([res.statusCode, res.json().message]).toEqual([409, "A term has no field called 'nosuch', so term 't1' can't be changed that way."]);
    expect((await stored(id)).rulebook).toEqual(rb);
    expect(await db().select().from(answers).where(eq(answers.versionId, id))).toHaveLength(0);
    expect(await audits(id)).toHaveLength(0);
  });

  it("refuses an answer that would leave the rulebook invalid", async () => {
    const rb = rulebook({ questions: [question("q1", { options: [{ label: "Bad", patches: [{ target: "term", id: "t1", set: { amountCents: "lots" } }] }] })] });
    const { id } = await seed({ rulebook: rb });
    const res = await answer(id, "q1", { option: 0, by: "Ana" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/^That change would leave the rulebook invalid/);
    expect((await stored(id)).rulebook).toEqual(rb);
  });

  it("writes one audit entry, in the same transaction", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    await answer(id, "q1", { option: 0, by: "Ana" });
    const log = await audits(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ by: "Ana", action: "version.answered", entity: "version", detail: { questionId: "q1", option: 0, label: "Yes" } });
  });
});

describe("answering a question about a scanned grid", () => {
  // stored before grids had acceptedAsPrinted, as older versions are
  const scanGrid = (subtotal: (number | null)[]) =>
    ({
      id: "g1", name: "Budget", arm: null, doc: "scan.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null,
      rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, 25000], printedRowTotalCents: null }],
      subtotal, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [],
    }) as unknown as Rulebook["grids"][number];
  const gridQuestion = (id: string, label: string, patches: Question["options"][number]["patches"]) =>
    question(id, { about: { target: "grid", id: "g1" }, source: { doc: "scan.pdf", page: 1, quote: "" }, options: [{ label, patches }, { label: "Neither, I'll type the right value", patches: [] }] });
  const seedScan = async (rb: Rulebook) => {
    const documentIds = [await scannedDoc()];
    const checked = checks.runChecks(rb, await loadDocs(db(), documentIds));
    return seed({ documentIds, rulebook: rb, problems: checked.problems });
  };

  it("answering the marked-values question on a scanned grid lets the version be approved", async () => {
    const asWritten = gridQuestion("person:g1", "Use the values as written", [{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } }]);
    const { id } = await seedScan(rulebook({ terms: [], grids: [scanGrid([10000, null])], questions: [asWritten] }));
    expect((await stored(id)).problems).toHaveLength(1);

    const res = await answer(id, "person:g1", { option: 0, by: "Ana" });
    expect(res.json().problems).toEqual([]);
    expect(res.json().rulebook.grids[0].cellsReadTwice).toEqual([[0, 1]]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("answers to two questions about one grid add to each other's proven cells", async () => {
    const first = gridQuestion("person:g1", "Use the values as written", [{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } }]);
    const second = gridQuestion("read:g1", "Use the whole-page reading", [{ target: "grid", id: "g1", set: { "rows.0.cells.0": 10000 } }]);
    const { id } = await seedScan(rulebook({ terms: [], grids: [scanGrid([null, null])], questions: [first, second] }));

    await answer(id, "person:g1", { option: 0, by: "Ana" });
    const res = await answer(id, "read:g1", { option: 0, by: "Ana" });
    expect(res.json().rulebook.grids[0].cellsReadTwice).toEqual([[0, 1], [0, 0]]);
  });

  it("accepting a grid whose figures don't add up as printed lets the version be approved", async () => {
    const accept = gridQuestion("read:g1", "Use them as printed", [{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }]);
    const { id } = await seedScan(rulebook({ terms: [], grids: [scanGrid([10000, 20000])], questions: [accept] }));
    expect((await stored(id)).problems[0]!.message).toContain("rows add up to");

    const res = await answer(id, "read:g1", { option: 0, by: "Ana" });
    expect(res.json().problems).toEqual([]);
    expect(res.json().rulebook.grids[0].acceptedAsPrinted).toBe(true);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });
});

describe("approving a version", () => {
  it("approves a clean draft and supersedes the study's previous live version", async () => {
    const studyId = await study();
    const old = await seed({ studyId, number: 1, status: "approved" });
    const draft = await seed({ studyId, number: 2 });
    const res = await approve(draft.id, { by: "Dana" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: draft.id, status: "approved", approvedBy: "Dana", approvedAt: expect.any(String) });
    expect(await stored(old.id)).toMatchObject({ status: "superseded", approvedBy: "Old Approver" });
    expect((await audits(draft.id)).map((a) => [a.by, a.action, a.detail])).toEqual([["Dana", "version.approved", { number: 2, supersedes: old.id, ticked: [] }]]);
    expect((await audits(old.id)).map((a) => [a.by, a.action, a.detail])).toEqual([["Dana", "version.superseded", { number: 1, supersededBy: draft.id }]]);
  });

  it("approves a first version with nothing to supersede", async () => {
    const { id } = await seed();
    expect((await approve(id, { by: "Dana" })).json().status).toBe("approved");
    expect((await audits(id))[0]!.detail).toEqual({ number: 1, supersedes: null, ticked: [] });
  });

  it("only approves a draft", async () => {
    for (const status of ["reading", "failed", "approved", "superseded"] as const) {
      const { id } = await seed({ status });
      const res = await approve(id, { by: "Dana" });
      expect([res.statusCode, res.json().message]).toEqual([409, `This version is ${status}, so it can't be approved. Only a draft can.`]);
    }
  });

  it("waits for open blocking questions, but not for non-blocking ones", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1"), question("q2", { question: "Is the fee waived?" }), question("q3", { blocking: false })] }) });
    const res = await approve(id, { by: "Dana" });
    expect([res.statusCode, res.json().message]).toEqual([409, '2 questions still need an answer before this can be approved. First: "Question q1?"']);
    await answer(id, "q1", { option: 1, by: "Ana" });
    expect((await approve(id, { by: "Dana" })).json().message).toBe('1 question still needs an answer before this can be approved. First: "Is the fee waived?"');
    await answer(id, "q2", { option: 1, by: "Ana" });
    expect((await approve(id, { by: "Dana" })).statusCode).toBe(200);
  });

  it("waits for the checks to find nothing wrong", async () => {
    const { id } = await seed({ rulebook: withBadQuote(), problems: [badQuote, { ...badQuote, id: "t3" }] });
    const res = await approve(id, { by: "Dana" });
    expect([res.statusCode, res.json().message]).toEqual([409, "2 problems still to fix before this can be approved. First: quote not found on p.1 of contract.pdf"]);
    expect((await stored(id)).status).toBe("draft");
  });

  it("won't let someone who answered a question approve, whatever the letter case", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    await answer(id, "q1", { option: 1, by: "Ana" });
    for (const by of ["Ana", "ana"]) {
      const res = await approve(id, { by });
      expect([res.statusCode, res.json().message]).toEqual([409, "Someone who answered this version's questions can't also approve it: ask a colleague."]);
    }
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
    expect((await audits(id)).map((a) => a.action)).toEqual(["version.answered", "version.approved"]);
  });

  it("records the terms and grids the approver ticked", async () => {
    const { id } = await seed();
    expect((await approve(id, { by: "Dana", ticked: ["t1", "g1"] })).statusCode).toBe(200);
    expect((await audits(id))[0]!.detail).toEqual({ number: 1, supersedes: null, ticked: ["t1", "g1"] });
  });

  it.each([
    [{ by: "Dana", ticked: Array(51).fill("t") }, "Tick at most 50 items."],
    [{ by: "Dana", ticked: ["x".repeat(201)] }, "A ticked item's id is too long."],
    [{ by: "Dana", ticked: "t1" }, "Send the ticked items as a list."],
    [{ by: "Dana", ticked: [1] }, "Send the ticked items as a list."],
  ])("refuses bad ticked items %j", async (body, message) => {
    const { id } = await seed();
    const res = await approve(id, body);
    expect([res.statusCode, res.json().message]).toEqual([400, message]);
    expect((await stored(id)).status).toBe("draft");
  });

  it("takes 50 ticked items of 200 characters", async () => {
    const { id } = await seed();
    expect((await approve(id, { by: "Dana", ticked: Array(50).fill("x".repeat(200)) })).statusCode).toBe(200);
  });

  it("refuses a body with no name", async () => {
    const { id } = await seed();
    const res = await approve(id, {});
    expect([res.statusCode, res.json().message]).toEqual([400, "Say who is doing this: pick your name first."]);
  });

  it("leaves the previous live version alone when the approval is refused", async () => {
    const studyId = await study();
    const old = await seed({ studyId, number: 1, status: "approved" });
    const draft = await seed({ studyId, number: 2, problems: [badQuote] });
    expect((await approve(draft.id, { by: "Dana" })).statusCode).toBe(409);
    expect((await stored(old.id)).status).toBe("approved");
    expect(await audits(old.id)).toHaveLength(0);
  });
});

describe("the database refuses to change what is live", () => {
  const rejected = "A live rulebook can't be changed: make a new version instead.";

  it("an approved version's rulebook, problems, documents and approval", async () => {
    const { id } = await seed({ status: "approved" });
    const update = (set: Record<string, unknown>) => refusal(db().update(versions).set(set).where(eq(versions.id, id)));
    expect(await update({ rulebook: rulebook({ accounted: [{ doc: "contract.pdf", pages: [1], reason: "x" }] }) })).toBe(rejected);
    expect(await update({ problems: [badQuote] })).toBe(rejected);
    expect(await update({ documentIds: [] })).toBe(rejected);
    expect(await update({ approvedBy: "Someone" })).toBe(rejected);
    expect(await update({ approvedAt: new Date(0) })).toBe(rejected);
    expect(await update({ status: "draft" })).toBe(rejected);
    expect(await refusal(db().delete(versions).where(eq(versions.id, id)))).toBe("An approved rulebook can't be deleted.");
  });

  it("an approved version can still move on to superseded; a superseded one can't change at all", async () => {
    const { id } = await seed({ status: "approved" });
    await db().update(versions).set({ status: "superseded" }).where(eq(versions.id, id));
    expect(await refusal(db().update(versions).set({ rulebook: rulebook() }).where(eq(versions.id, id)))).toBe("A superseded rulebook can't be changed.");
    expect(await refusal(db().delete(versions).where(eq(versions.id, id)))).toBe("An approved rulebook can't be deleted.");
  });

  it("reaches the API as a 409 with the same plain message", async () => {
    const { id } = await seed({ status: "approved" });
    const res = await app.inject({ method: "POST", url: `/api/v1/test/rewrite/${id}` });
    expect([res.statusCode, res.json().message]).toEqual([409, rejected]);
    expect((await stored(id)).rulebook).not.toBeNull();
  });

  it("the audit log refuses updates, deletes and truncation", async () => {
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1")] }) });
    await answer(id, "q1", { option: 0, by: "Ana" });
    const message = "The audit log can't be changed or deleted.";
    expect(await refusal(db().update(auditLog).set({ by: "Mallory" }).where(eq(auditLog.entityId, id)))).toBe(message);
    expect(await refusal(db().delete(auditLog).where(and(eq(auditLog.entityId, id))))).toBe(message);
    expect(await refusal(db().execute(sql`TRUNCATE audit_log`))).toBe(message);
    expect(await audits(id)).toHaveLength(1);
  });
});
