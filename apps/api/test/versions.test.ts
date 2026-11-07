import type { Question, Rulebook } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checks, resolve, scanVersion, type Reader } from "@dct/harness";
import { buildApp } from "../src/app.js";
import { answers, auditLog, documents, parties, proofreads, reads, studies, versions } from "../src/db/schema.js";
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

type Table = Parameters<typeof scanStore.put>[1]["transcription"]["tables"][number];

/** A document with one scanned page: no text layer in the PDF, and a transcription saved for it. */
async function scannedDoc(tables: Table[] = []) {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.setTitle(randomUUID());
  const sha256 = await savePdf(Buffer.from(await pdf.save()));
  const lines = [{ text: "Exhibit A", top: 0.05, bottom: 0.06, unsure: false, marks: [] }];
  await scanStore.put(sha256, { page: 1, version: "test", rotation: 0, transcription: { rotation: 0, lines, tables } });
  const [doc] = await db().insert(documents).values({ sha256, name: "scan.pdf", bytes: 1, pages: [{ page: 1, kind: "scan", chars: 9, firstLine: "Exhibit A" }], createdBy: "test" }).returning();
  return doc!.id;
}

const field = (text: string) => ({ text, unsure: false, marks: [] });
const printed = (cents: Rulebook["grids"][number]["subtotal"]) => (cents ?? []).map((c) => field(typeof c === "number" ? `$${(c / 100).toFixed(2)}` : ""));
const table = (rows: [string, Table["rows"][number]["cells"]][]): Table => ({
  title: "Budget", top: 0.1, bottom: 0.5, columns: [],
  rows: rows.map(([label, cells], i) => ({ label, top: 0.1 + i * 0.02, bottom: 0.11 + i * 0.02, cells })),
});

/** A scanned page that prints the grid's rows and subtotal as its one table, and the grid citing each of its amounts there. */
async function scannedGrid(g: Rulebook["grids"][number]) {
  const cellIds: Record<string, string> = {};
  const lines = [...g.rows.map((r) => r.cells), g.subtotal];
  lines.forEach((cells, i) => cells?.forEach((c, j) => {
    if (typeof c === "number") cellIds[i < g.rows.length ? `rows.${i}.cells.${j}` : `subtotal.${j}`] = `p1.t1.r${i + 1}.c${j + 1}`;
  }));
  const documentIds = [await scannedDoc([table([...g.rows.map((r): [string, Table["rows"][number]["cells"]] => [r.name, printed(r.cells)]), ["Subtotal", printed(g.subtotal)]])])];
  return { documentIds, grid: { ...g, cellIds } };
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
    expect(Object.keys(body).sort()).toEqual(["answers", "approvedAt", "approvedBy", "createdAt", "createdBy", "documentIds", "documents", "id", "number", "problems", "proofreads", "read", "rulebook", "status", "studyId"]);
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
    const { documentIds, grid } = await scannedGrid(rb.grids[0]!);
    const cited = { ...rb, grids: [grid] };
    const checked = checks.runChecks(cited, await loadDocs(db(), documentIds));
    return seed({ documentIds, rulebook: cited, problems: checked.problems });
  };

  it("answering the marked-values question on a scanned grid lets the version be approved", async () => {
    const asWritten = gridQuestion("person:g1", "Use the values as written", [{ target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } }]);
    // the second read already agreed on V1, which on a scan its column total alone can't prove
    const { id } = await seedScan(rulebook({ terms: [], grids: [{ ...scanGrid([10000, null]), cellsReadTwice: [[0, 0]] }], questions: [asWritten] }));
    expect((await stored(id)).problems).toHaveLength(1);

    const res = await answer(id, "person:g1", { option: 0, by: "Ana" });
    expect(res.json().problems).toEqual([]);
    expect(res.json().rulebook.grids[0].cellsReadTwice).toEqual([[0, 0], [0, 1]]);
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

describe("answers that leave a scanned grid failing", () => {
  const grid = (accepted: boolean) =>
    ({
      id: "g1", name: "Budget", arm: null, doc: "scan.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null,
      rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, 25000], printedRowTotalCents: null }],
      subtotal: [10000, 20000], overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: accepted,
    }) as Rulebook["grids"][number];
  const source = { doc: "scan.pdf", page: 1, quote: "" };
  const seedGrid = async (accepted: boolean, questions: Question[], over: Partial<Rulebook["grids"][number]> = {}) => {
    const { documentIds, grid: cited } = await scannedGrid({ ...grid(accepted), ...over });
    // the transcribed figures stay on the page when an answer replaces them
    const accounted = [25000, 20000].map((amountCents) => ({ doc: "scan.pdf", page: 1, amountCents, reason: "the whole-page reading" }));
    const rb = rulebook({ terms: [], grids: [cited], questions, accounted });
    return seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, await loadDocs(db(), documentIds)).problems });
  };
  const cellTo = (cents: number) => [{ target: "grid" as const, id: "g1", set: { "rows.0.cells.1": cents } }];

  it("after answering a zoomed disagreement on a grid whose totals still fail, the person is asked to use them as printed, then can approve", async () => {
    const zoomed = question("read:g1", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use the whole-page reading ($250.00)", patches: cellTo(25000) }, { label: "Use the zoomed reading ($260.00)", patches: cellTo(26000) }, { label: "Neither, I'll type the right value", patches: [] }] });
    const { id } = await seedGrid(false, [zoomed]);

    const res = (await answer(id, "read:g1", { option: 1, by: "Ana" })).json();
    const asked = res.rulebook.questions.find((q: Question) => q.state === "open");
    expect(asked).toMatchObject({ id: "read:g1:printed", kind: "decision", blocking: true, question: "The figures of 'Budget' don't add up. Use them as printed?" });
    expect(asked.options[0]).toEqual({ label: "Use them as printed", patches: [{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }] });
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(409);

    expect((await answer(id, "read:g1:printed", { option: 0, by: "Ana" })).json().problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("an answer that changes a scanned subtotal clears its citation, and the version can be approved", async () => {
    const fix = question("q-subtotal", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use $250.00", patches: [{ target: "grid", id: "g1", set: { "subtotal.1": 25000 } }] }] });
    // the second read agreed on both cells, which on a scan the column totals alone can't prove
    const { id } = await seedGrid(false, [fix], { cellsReadTwice: [[0, 0], [0, 1]] });

    const res = (await answer(id, "q-subtotal", { option: 0, by: "Ana" })).json();
    expect(res.rulebook.grids[0].cellIds).toMatchObject({ "subtotal.0": "p1.t1.r2.c1", "subtotal.1": null });
    expect(res.problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("changing a figure of a grid accepted as printed clears the acceptance and asks again", async () => {
    const change = question("q-change", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use $260.00", patches: cellTo(26000) }] });
    const { id } = await seedGrid(true, [change]);
    expect((await stored(id)).problems).toEqual([]);

    const res = (await answer(id, "q-change", { option: 0, by: "Ana" })).json();
    expect(res.rulebook.grids[0].acceptedAsPrinted).toBe(false);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.rulebook.questions.filter((q: Question) => q.state === "open").map((q: Question) => q.id)).toEqual(["read:g1:printed"]);
  });

  it("an answer that writes the same values keeps the acceptance", async () => {
    const same = question("q-same", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use $250.00", patches: cellTo(25000) }] });
    const { id } = await seedGrid(true, [same]);
    const res = (await answer(id, "q-same", { option: 0, by: "Ana" })).json();
    expect(res.rulebook.grids[0].acceptedAsPrinted).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.rulebook.questions.filter((q: Question) => q.state === "open")).toEqual([]);
  });

  it("a grid with the wrong number of visit values isn't offered 'use as printed' again and again", async () => {
    const rename = question("q-rename", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Rename it", patches: [{ target: "grid", id: "g1", set: { name: "Budget 2" } }] }] });
    const { documentIds, grid: short } = await scannedGrid({ ...grid(false), rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000], printedRowTotalCents: null }] });
    const rb = rulebook({ terms: [], grids: [short], questions: [rename] });
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, await loadDocs(db(), documentIds)).problems });

    const res = (await answer(id, "q-rename", { option: 0, by: "Ana" })).json();
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.rulebook.questions.filter((q: Question) => q.state === "open")).toEqual([]);
  });

  it("a grid with no printed totals never asks 'use them as printed'", async () => {
    const { documentIds, grid: bare } = await scannedGrid({ ...grid(false), subtotal: null });
    const rb = rulebook({ terms: [], grids: [{ ...bare, cellsReadTwice: [[0, 0]] }], questions: [question("q1", { options: [{ label: "Nothing changes", patches: [] }] })] });
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, await loadDocs(db(), documentIds)).problems });

    // nothing there can fail to add up: the cell no read settled is left for the next read or a person
    const res = (await answer(id, "q1", { option: 0, by: "Ana" })).json();
    // shown in words for the accountant, not the compile agent's
    expect(res.problems.map((p: { message: string }) => p.message)).toEqual(["Some figures of a budget on p.1 of scan.pdf aren't proven by a printed total or a second reading yet; start the read again."]);
    expect((await approve(id, { by: "Ben" })).json().message).toBe("1 problem still to fix before this can be approved. First: Some figures of a budget on p.1 of scan.pdf aren't proven by a printed total or a second reading yet; start the read again.");
    expect(res.rulebook.questions.filter((q: Question) => q.state === "open")).toEqual([]);
  });

  it("asks only once while the question about the grid is still open", async () => {
    const change = question("q-change", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use $260.00", patches: cellTo(26000) }] });
    const open = question("read:g1", { about: { target: "grid", id: "g1" }, source, options: [{ label: "Use them as printed", patches: [{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }] }] });
    const { id } = await seedGrid(false, [change, open]);
    const res = (await answer(id, "q-change", { option: 0, by: "Ana" })).json();
    expect(res.rulebook.questions.map((q: Question) => q.id)).toEqual(["q-change", "read:g1"]);
  });
});

describe("an answer that changes a scanned term's amount", () => {
  const scanSource = { doc: "scan.pdf", page: 1, quote: "Exam" };
  const options = [
    { label: "Use $260.00", patches: [{ target: "term" as const, id: "t9", set: { amountCents: 26000 } }] },
    { label: "Use the fee with overhead", patches: [{ target: "term" as const, id: "t9", set: { amountCents: 26000, "source.cell": "p1.t1.r1.c2" } }] },
  ];

  it.each([
    [0, undefined],
    [1, "p1.t1.r1.c2"],
  ])("drops the old citation unless the option cites another cell (option %i), and the version can be approved", async (option, cell) => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00"), field("$260.00")]]])])];
    const rb = rulebook({
      terms: [term("t9", { amountCents: 25000, evidence: "none", source: { ...scanSource, cell: "p1.t1.r1.c1" } })],
      accounted: [{ doc: "scan.pdf", page: 1, amountCents: 25000, reason: "the fee before overhead" }, { doc: "scan.pdf", page: 1, cell: "p1.t1.r1.c2", reason: "the fee with overhead" }],
      questions: [question("read:t9", { kind: "reading", about: { target: "term", id: "t9" }, source: scanSource, options })],
    });
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, await loadDocs(db(), documentIds)).problems });

    const res = (await answer(id, "read:t9", { option, by: "Ana" })).json();
    expect(res.rulebook.terms[0].source.cell).toBe(cell);
    expect(res.problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("a person's correction sets aside the misread printed cell, so it doesn't block approval", async () => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00")]]])])];
    const rb = rulebook({
      terms: [term("t9", { amountCents: 25000, evidence: "none", source: { ...scanSource, cell: "p1.t1.r1.c1" } })],
      questions: [question("read:t9", { kind: "reading", about: { target: "term", id: "t9" }, source: scanSource, options: [options[0]!] })],
    });
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, await loadDocs(db(), documentIds)).problems });

    const res = (await answer(id, "read:t9", { option: 0, by: "Ana" })).json();
    expect(res.rulebook.accounted).toEqual([{ doc: "scan.pdf", page: 1, cell: "p1.t1.r1.c1", reason: "corrected by a person" }]);
    expect(res.problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });
});

describe("an option the resolver wrote", () => {
  const reader = (answers: Record<string, unknown>): Reader => ({
    model: "fake-openai",
    price: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ask: async <T,>(req: { name: string }) => ({ value: answers[req.name] as T, model: "fake-openai", usd: 0 }),
  });

  it("picking the second reading of a scanned term drops the citation of the old value, so the version can be approved", async () => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00")]]])])];
    const docs = await loadDocs(db(), documentIds);
    const before = rulebook({
      terms: [term("t9", { amountCents: 25000, evidence: "none", source: { doc: "scan.pdf", page: 1, quote: "Exam", cell: "p1.t1.r1.c1" } })],
      accounted: [{ doc: "scan.pdf", page: 1, amountCents: 25000, reason: "the first reading" }],
    });
    const second = reader({ verify_page: { rotation: 0, text: "T 0.1-0.5 | Budget\nR 0.1-0.11 | Exam | $260.00" } });
    const { rulebook: rb } = await resolve(before, docs, checks.runChecks(before, docs), { claude: second, openai: second, budget: { limit: 5, spent: 0 } });
    const option = rb.questions.find((q) => q.id === "read:t9")!.options.findIndex((o) => o.label === "Use the second reading ($260.00)");
    expect(option).toBeGreaterThan(0);
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, docs).problems });

    const res = (await answer(id, "read:t9", { option, by: "Ana" })).json();
    expect(res.rulebook.terms[0]).toMatchObject({ amountCents: 26000, evidence: "person", source: { doc: "scan.pdf", page: 1, quote: "Exam" } });
    expect(res.rulebook.terms[0].source).not.toHaveProperty("cell");
    expect(res.problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });
});

describe("an amount only a second reading of the page found", () => {
  const reader = (answers: Record<string, unknown>): Reader => ({
    model: "fake-openai",
    price: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ask: async <T,>(req: { name: string }) => ({ value: answers[req.name] as T, model: "fake-openai", usd: 0 }),
  });
  // the first read dropped the Labs row; the second read, kept in the store, has it
  const missedDraft = async () => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00")]]])])];
    const docs = await loadDocs(db(), documentIds);
    const before = rulebook({ terms: [term("t9", { amountCents: 25000, evidence: "none", source: { doc: "scan.pdf", page: 1, quote: "Exam", cell: "p1.t1.r1.c1" } })] });
    const second = reader({ verify_page: { rotation: 0, text: "T 0.1-0.5 | Budget\nR 0.1-0.11 | Exam | $250.00\nR 0.12-0.13 | Labs | $75.00" } });
    const { rulebook: rb } = await resolve(before, docs, checks.runChecks(before, docs), { claude: second, openai: second, budget: { limit: 5, spent: 0 }, scans: scanStore });
    const problems = checks.runChecks(rb, docs).problems;
    expect(problems.map((p) => p.message)).toEqual(['$75.00 on p.1 of scan.pdf was found only by a second reading of the page ("Labs $75.00"): answer the question about it.']);
    return seed({ documentIds, rulebook: rb, problems });
  };

  it("can be added as a fee by a person, and the version approved", async () => {
    const { id } = await missedDraft();
    const added = (await answer(id, "read:scan.pdf:p1:missed:t1.r2", { option: 0, by: "Ana" })).json();
    expect(added.rulebook.terms[1]).toMatchObject({ name: "Labs", amountCents: 7500, billing: "unknown", evidence: "person", source: { doc: "scan.pdf", page: 1, quote: "Labs $75.00" } });
    expect(added.problems).toEqual([]);
    // how it is billed is the one thing left to decide
    const billed = (await answer(id, "rule:billing", { option: 0, by: "Ana" })).json();
    expect(billed.rulebook.terms[1].billing).toBe("auto_paid");
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("every amount on the page can be set aside at once, which closes the other rows' questions", async () => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00")]]])])];
    const docs = await loadDocs(db(), documentIds);
    const before = rulebook({ terms: [term("t9", { amountCents: 25000, evidence: "none", source: { doc: "scan.pdf", page: 1, quote: "Exam", cell: "p1.t1.r1.c1" } })] });
    const second = reader({ verify_page: { rotation: 0, text: "T 0.1-0.5 | Budget\nR 0.1-0.11 | Exam | $250.00\nR 0.12-0.13 | Labs | $75.00\nR 0.14-0.15 | Parking | $20.00" } });
    const { rulebook: rb } = await resolve(before, docs, checks.runChecks(before, docs), { claude: second, openai: second, budget: { limit: 5, spent: 0 }, scans: scanStore });
    const rows = rb.questions.filter((q) => q.id.includes(":missed:"));
    expect(rows.map((q) => q.id)).toEqual(["read:scan.pdf:p1:missed:t1.r2", "read:scan.pdf:p1:missed:t1.r3"]);
    const { id } = await seed({ documentIds, rulebook: rb, problems: checks.runChecks(rb, docs).problems });

    const res = (await answer(id, rows[0]!.id, { option: 2, by: "Ana" })).json();
    expect(res.rulebook.questions.map((q: Question) => [q.id, q.state])).toEqual([["read:scan.pdf:p1:missed:t1.r2", "answered"], ["read:scan.pdf:p1:missed:t1.r3", "auto_resolved"]]);
    expect(res.problems).toEqual([]);
    expect((await approve(id, { by: "Ben" })).statusCode).toBe(200);
  });

  it("an answer that sets an amount aside is refused on a question that isn't a check's", async () => {
    const aside = { target: "accounted" as const, id: "x", set: { doc: "contract.pdf", page: 1, amountCents: 150000, reason: "set aside by a person" } };
    const { id } = await seed({ rulebook: rulebook({ questions: [question("q1", { options: [{ label: "Set it aside", patches: [aside] }] })] }) });
    const res = await answer(id, "q1", { option: 0, by: "Ana" });
    expect([res.statusCode, res.json().message]).toEqual([409, "That answer would set an amount aside, which only a check of the page can offer, so it wasn't applied."]);
    expect((await stored(id)).rulebook!.accounted).toEqual([]);
  });

  it("a second read kept under another prompt's version isn't attached to the page", async () => {
    const documentIds = [await scannedDoc([table([["Exam", [field("$250.00")]]])])];
    const [{ sha256 }] = (await db().select({ sha256: documents.sha256 }).from(documents).where(eq(documents.id, documentIds[0]!))) as [{ sha256: string }];
    const second = { page: 1, rotation: 0, transcription: { rotation: 0, lines: [], tables: [table([["Exam", [field("$250.00")]], ["Labs", [field("$75.00")]]])] } };
    await scanStore.verify!.put(sha256, { ...second, version: "verify-0 fake-openai" });
    expect((await loadDocs(db(), documentIds))[0]!.pages[0]!.second).toBeUndefined();
    await scanStore.verify!.put(sha256, { ...second, version: "verify-1 fake-openai" });
    expect((await loadDocs(db(), documentIds))[0]!.pages[0]!.second).toBeDefined();
    // a read with its reader known takes only pages that reader made
    const [first] = await scanStore.get(sha256);
    await scanStore.put(sha256, { ...first!, version: scanVersion(reader({})) });
    expect((await loadDocs(db(), documentIds, reader({})))[0]!.pages[0]!.second).toBeDefined();
    await scanStore.put(sha256, { ...first!, version: scanVersion({ ...reader({}), model: "another-model" }) });
    expect((await loadDocs(db(), documentIds, { ...reader({}), model: "another-model" }))[0]!.pages[0]!.second).toBeUndefined();
  });

  it("can be set aside by a person, and the version approved", async () => {
    const { id } = await missedDraft();
    const res = (await answer(id, "read:scan.pdf:p1:missed:t1.r2", { option: 1, by: "Ana" })).json();
    expect(res.rulebook.accounted).toEqual([{ doc: "scan.pdf", page: 1, cell: "p1.t1.r2.c1 (second read)", reason: "set aside by a person" }]);
    expect(res.problems).toEqual([]);
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

const list = async (studyId: string) => (await app.inject({ url: "/api/v1/studies" })).json().find((s: { id: string }) => s.id === studyId);

describe("GET /studies rows", () => {
  it("says who the PI is, from the latest version that has a rulebook", async () => {
    const { studyId } = await seed({ rulebook: rulebook({ study: { ...rulebook().study, pi: "Dr. Old" } }) });
    await seed({ studyId, number: 2, status: "draft", rulebook: rulebook({ study: { ...rulebook().study, pi: "Dr. New" } }) });
    await db().insert(versions).values({ studyId, number: 3, status: "reading", documentIds: [docId], createdBy: "test" });
    const row = await list(studyId);
    expect(row.pi).toBe("Dr. New");
    expect(row.latestVersion).toMatchObject({ number: 3, status: "reading" });
    expect(row.openDecisions).toBe(0);
    expect(row.pi).not.toBeNull();
    expect((await list(await study())).pi).toBeNull();
  });

  it("counts the latest draft's open blocking questions, not answered or non-blocking ones", async () => {
    const { studyId, id } = await seed({ rulebook: rulebook({ questions: [question("a"), question("b"), question("c", { blocking: false }), question("d", { state: "answered" })] }) });
    const row = await list(studyId);
    expect(row).toMatchObject({ openDecisions: 2, liveVersion: null, newVersionInProgress: false, answeredBy: [], latestVersion: { id, number: 1, status: "draft" } });
  });

  it("counts failing checks as one decision only when no question is open", async () => {
    const failing = await seed({ problems: [badQuote] });
    expect((await list(failing.studyId)).openDecisions).toBe(1);
    const both = await seed({ problems: [badQuote], rulebook: rulebook({ questions: [question("a"), question("b")] }) });
    expect((await list(both.studyId)).openDecisions).toBe(2);
    const clean = await seed();
    expect((await list(clean.studyId)).openDecisions).toBe(0);
  });

  it("has nothing to decide on a live or failed latest version, and names who answered only a draft", async () => {
    const live = await seed({ status: "approved", problems: [badQuote], rulebook: rulebook({ questions: [question("a")] }) });
    expect(await list(live.studyId)).toMatchObject({ openDecisions: 0, liveVersion: 1, newVersionInProgress: false, answeredBy: [] });
    const failed = await seed({ status: "failed", rulebook: rulebook({ questions: [question("a")] }) });
    expect((await list(failed.studyId)).openDecisions).toBe(0);

    const { studyId, id } = await seed({ rulebook: rulebook({ questions: [question("q1"), question("q2")] }) });
    await answer(id, "q1", { option: 1, by: "Ben" });
    await answer(id, "q2", { option: 1, by: "Ana" });
    await answer(id, "q2", { option: 1, by: "Ana" });
    expect(await list(studyId)).toMatchObject({ answeredBy: ["Ana", "Ben"], openDecisions: 0 });
    await approve(id, { by: "Cy" });
    expect((await list(studyId)).answeredBy).toEqual([]);
  });

  it("marks a newer draft or reading over the live version, and the live number stays", async () => {
    const { studyId } = await seed({ status: "approved" });
    expect((await list(studyId)).newVersionInProgress).toBe(false);
    await seed({ studyId, number: 2, status: "draft" });
    expect(await list(studyId)).toMatchObject({ liveVersion: 1, newVersionInProgress: true, latestVersion: { number: 2, status: "draft" } });
    await db().update(versions).set({ status: "failed" }).where(and(eq(versions.studyId, studyId), eq(versions.number, 2)));
    expect((await list(studyId)).newVersionInProgress).toBe(false);
  });

  it("updatedAt is the latest of the study's creation, its versions' creation and approval, and its reads' finish", async () => {
    // a draft carrying an approval stamp: a live version's can't be edited to try this
    const { studyId, id } = await seed();
    const approvedAt = new Date(Date.now() + 60_000);
    await db().update(versions).set({ approvedAt }).where(eq(versions.id, id));
    expect((await list(studyId)).updatedAt).toBe(approvedAt.toISOString());
    const finishedAt = new Date(Date.now() + 120_000);
    await db().insert(reads).values({ versionId: id, budgetUsd: 1, status: "done", finishedAt });
    expect((await list(studyId)).updatedAt).toBe(finishedAt.toISOString());
    expect((await list(await study())).updatedAt).toEqual(expect.any(String));
  });
});

const proofread = (id: string, body: unknown) => app.inject({ method: "POST", url: `/api/v1/versions/${id}/proofread`, payload: body as object });
const unproofread = (id: string, by: string, item: string) => app.inject({ method: "DELETE", url: `/api/v1/versions/${id}/proofread?by=${encodeURIComponent(by)}&item=${encodeURIComponent(item)}` });
const gridded = () =>
  rulebook({
    grids: [{ id: "g:1", name: "Arm A", arm: null, doc: "contract.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null, rows: [{ name: "Labs", code: null, unitCostCents: null, cells: [100, 200], printedRowTotalCents: null }], subtotal: null, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false }],
  });

describe("proofreading a version", () => {
  it("records marks on a draft, ordered by time, ignoring repeats, and returns the version", async () => {
    const { id } = await seed({ rulebook: gridded() });
    // marks made in one call share a timestamp, so they come back by item name
    const res = await proofread(id, { by: "Ana", items: ["t1", "grid:g:1:0:1", "t1"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().proofreads).toEqual([{ item: "grid:g:1:0:1", by: "Ana", at: expect.any(String) }, { item: "t1", by: "Ana", at: expect.any(String) }].map((m) => expect.objectContaining({ item: m.item, by: "Ana" })));
    const again = await proofread(id, { by: "Ana", items: ["t1"] });
    expect(again.json().proofreads).toHaveLength(2);
    expect((await proofread(id, { by: "Ben", items: ["t1"] })).json().proofreads.map((m: { by: string }) => m.by)).toEqual(["Ana", "Ana", "Ben"]);
    expect((await app.inject({ url: `/api/v1/versions/${id}` })).json().proofreads).toHaveLength(3);
    expect((await audits(id)).map((a) => [a.action, a.by, a.detail])).toEqual([["version.proofread", "Ana", { items: ["t1", "grid:g:1:0:1"] }], ["version.proofread", "Ben", { items: ["t1"] }]]);
  });

  it("works on an approved version without touching the live rulebook", async () => {
    const { id } = await seed({ status: "approved" });
    const before = await stored(id);
    const res = await proofread(id, { by: "Ana", items: ["t1"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().proofreads).toHaveLength(1);
    expect(await stored(id)).toEqual(before);
    expect((await unproofread(id, "Ana", "t1")).json().proofreads).toEqual([]);
    expect((await stored(id)).status).toBe("approved");
  });

  it("the guard on live rulebooks is still in force beside it", async () => {
    const { id } = await seed({ status: "approved" });
    await proofread(id, { by: "Ana", items: ["t1"] });
    expect(await refusal(db().update(versions).set({ rulebook: rulebook({ terms: [] }) }).where(eq(versions.id, id)))).toBe("A live rulebook can't be changed: make a new version instead.");
  });

  it("does not hold up approval", async () => {
    const { id } = await seed();
    expect((await approve(id, { by: "Cy" })).statusCode).toBe(200);
  });

  it("refuses items that aren't in the rulebook, in plain words, and saves none of them", async () => {
    const { id } = await seed({ rulebook: gridded() });
    for (const item of ["nope", "grid:g:1:0:2", "grid:g:1:1:0", "grid:other:0:0", "grid:g:1:-1:0", "grid:g:1"]) {
      const res = await proofread(id, { by: "Ana", items: ["t1", item] });
      expect([res.statusCode, res.json().message]).toEqual([400, `"${item}" isn't a term or a grid cell in this rulebook, so it can't be proofread. Reload the page and try again.`]);
    }
    expect(await db().select().from(proofreads).where(eq(proofreads.versionId, id))).toEqual([]);
  });

  it("refuses a bad request", async () => {
    const { id } = await seed();
    const msg = async (body: unknown) => (await proofread(id, body)).json().message;
    expect(await msg({ items: ["t1"] })).toBe("Say who is doing this: pick your name first.");
    expect(await msg({ by: "Ana" })).toBe("Send the items to proofread as a list.");
    expect(await msg({ by: "Ana", items: [] })).toBe("Pick at least one item to proofread.");
    expect(await msg({ by: "Ana", items: Array.from({ length: 201 }, (_, i) => `t${i}`) })).toBe("Proofread at most 200 items at a time.");
    expect(await msg({ by: "Ana", items: [""] })).toBe("An item's id can't be empty.");
    expect((await proofread(id, { by: "Ana", items: [1] })).statusCode).toBe(400);
  });

  it("accepts 200 items", async () => {
    const terms = Array.from({ length: 200 }, (_, i) => term(`x${i}`));
    const { id } = await seed({ rulebook: rulebook({ terms }) });
    expect((await proofread(id, { by: "Ana", items: terms.map((t) => t.id) })).json().proofreads).toHaveLength(200);
  });

  it("is refused on a reading, failed or superseded version, and an unknown one", async () => {
    const reading = await seed({ status: "reading" });
    const failed = await seed({ status: "failed" });
    const old = await seed({ status: "superseded" });
    const said = async (id: string) => { const r = await proofread(id, { by: "Ana", items: ["t1"] }); const d = await unproofread(id, "Ana", "t1"); expect(d.statusCode).toBe(409); expect(d.json().message).toBe(r.json().message); return [r.statusCode, r.json().message]; };
    expect(await said(reading.id)).toEqual([409, "This version is still being read, so it can't be proofread yet. Wait for the read to finish."]);
    expect(await said(failed.id)).toEqual([409, "This version couldn't be read, so there is nothing to proofread."]);
    expect(await said(old.id)).toEqual([409, "This version has been replaced by a newer live one, so it can't be proofread. Open the live version instead."]);
    const missing = await proofread(randomUUID(), { by: "Ana", items: ["t1"] });
    expect([missing.statusCode, missing.json().message]).toEqual([404, "There is no such version."]);
  });
});

describe("taking a proofread mark back", () => {
  it("removes only the caller's own mark, and audits it", async () => {
    const { id } = await seed();
    await proofread(id, { by: "Ana", items: ["t1"] });
    await proofread(id, { by: "Ben", items: ["t1"] });
    const res = await unproofread(id, "Ana", "t1");
    expect(res.statusCode).toBe(200);
    expect(res.json().proofreads.map((m: { by: string }) => m.by)).toEqual(["Ben"]);
    expect((await audits(id)).map((a) => a.action)).toEqual(["version.proofread", "version.proofread", "version.unproofread"]);
  });

  it("treats a name the same whatever its letter case", async () => {
    const { id } = await seed();
    await proofread(id, { by: "Ana", items: ["t1"] });
    expect((await proofread(id, { by: "ana", items: ["t1"] })).json().proofreads).toEqual([expect.objectContaining({ item: "t1", by: "Ana" })]);
    expect((await audits(id)).map((a) => a.action)).toEqual(["version.proofread"]);
    expect((await unproofread(id, "ana", "t1")).json().proofreads).toEqual([]);
  });

  it("says so when there is no such mark of yours, and asks who and what", async () => {
    const { id } = await seed();
    await proofread(id, { by: "Ben", items: ["t1"] });
    const res = await unproofread(id, "Ana", "t1");
    expect([res.statusCode, res.json().message]).toEqual([404, "You haven't proofread that item, so there is no mark of yours to take off."]);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/versions/${id}/proofread?item=t1` })).json().message).toBe("Say who is doing this: pick your name first.");
    expect((await app.inject({ method: "DELETE", url: `/api/v1/versions/${id}/proofread?by=Ana` })).json().message).toBe("Say which item to take your mark off.");
  });
});
