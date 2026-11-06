import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Patch, Question, Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checks } from "../src/checks";
import type { Ask, Budget, Reader } from "../src/models/reader";
import { pdfReader } from "../src/pdf";
import { resolve } from "../src/resolve";
import type { LoadedDoc } from "../src/types";
import { wordsOf } from "./words";

type Term = Rulebook["terms"][number];
type Grid = Rulebook["grids"][number];

let dir: string;
let docs: LoadedDoc[];

const FILLER = "This page carries ordinary contract wording and no payment figures at all, so that it has a real text layer and is not mistaken for a scan.";

async function pdf(name: string, pages: string[][]): Promise<LoadedDoc> {
  const file = await PDFDocument.create();
  const font = await file.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = file.addPage([612, 792]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 740 - i * 16, size: 9, font }));
  }
  const path = join(dir, name);
  await writeFile(path, await file.save());
  return pdfReader.load(path);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-resolve-"));
  docs = [
    await pdf("Budget.pdf", [["Exhibit A"], ["Exhibit B"], ["Startup fee schedule", FILLER, FILLER]]),
    await pdf("Contract.pdf", [["Article 4. Payment", "The holdback applies to all site fees.", FILLER, FILLER]]),
    await pdf("Protocol.pdf", [["PROTOCOL-ONLY-TEXT", FILLER, FILLER]]),
  ];
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const term = (over: Partial<Term> = {}): Term => ({
  id: "t1", category: "site_fee", name: "Screen failure fee", amountCents: 70000, unit: null, billing: "auto_paid", trigger: null, cap: null,
  formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
  source: { doc: "Budget.pdf", page: 1, quote: "Screen failure fee" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const grid = (examV2: number): Grid => ({
  id: "g1", name: "Budget", arm: null, doc: "Budget.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null,
  rows: [
    { name: "Exam", code: null, unitCostCents: null, cells: [10000, examV2], printedRowTotalCents: null },
    { name: "Labs", code: null, unitCostCents: null, cells: [5000, 5000], printedRowTotalCents: null },
  ],
  subtotal: [15000, 30000], overhead: null, additions: [], total: null, grandTotalCents: 45000, cellsReadTwice: [],
});

const question = (over: Partial<Question>): Question => ({
  id: "q1", kind: "reading", origin: "compile", about: null, question: "Which is it?", context: "The rulebook says $500.00.",
  source: { doc: "Budget.pdf", page: 2, quote: "" }, options: [], suggestion: null, state: "open", blocking: true, readings: [], resolution: null, ...over,
});

const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: {
    protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null,
    documents: [
      { doc: "Budget.pdf", role: "budget", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
      { doc: "Contract.pdf", role: "cta", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
      { doc: "Protocol.pdf", role: "protocol", hasMoney: false, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
    ],
  },
  terms: [], grids: [], accounted: [], questions: [], ...over,
});

const truth: Record<string, string> = {
  "row 'Exam' at visit 'V1'": "$100.00",
  "row 'Exam' at visit 'V2'": "$250.00",
  "row 'Labs' at visit 'V1'": "$50.00",
  "row 'Labs' at visit 'V2'": "$50.00",
  "the subtotal line at visit 'V1'": "$150.00",
  "the subtotal line at visit 'V2'": "$300.00",
  "the grand total": "$450.00",
  "the amount for 'Screen failure fee'": "$75.00",
};

const texts = (ask: Ask<unknown>) => ask.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
const itemsOf = (ask: Ask<unknown>) => [...texts(ask).matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ item: Number(m[1]), label: m[2]! }));

function fake(model: string, o: { read?: (label: string) => string | null; find?: unknown; fail?: boolean } = {}) {
  const calls: Ask<unknown>[] = [];
  const reader: Reader = {
    model,
    price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
    async ask<T>(req: Ask<T>) {
      calls.push(req);
      if (o.fail) throw new Error("secret provider detail");
      const value = req.name === "read_values" ? { answers: itemsOf(req).map(({ item, label }) => ({ item, answer: (o.read ?? (() => null))(label) })) } : o.find;
      return { value: value as T, model, usd: 0.1 };
    },
  };
  return { reader, calls };
}

const readers = (claude: Parameters<typeof fake>[1] = {}, openai: Parameters<typeof fake>[1] = claude) => ({ claude: fake("claude-x", claude), openai: fake("openai-x", openai) });

function run(book: Rulebook, r: ReturnType<typeof readers>, budget: Budget = { limit: 3, spent: 0 }) {
  return resolve(book, docs, checks.runChecks(book, docs), { claude: r.claude.reader, openai: r.openai.reader, budget });
}

const truthful = (label: string) => truth[label] ?? null;
const gridProblems = (book: Rulebook) => checks.runChecks(book, docs).grids["g1"]!.problems;
const question1 = (book: Rulebook, id: string) => book.questions.find((q) => q.id === id)!;

describe("reading: two reads agree", () => {
  it("patches the grid and the term, marks their proof, and the checks pass", async () => {
    const book = rulebook({ grids: [grid(20500)], terms: [term()] });
    expect(gridProblems(book)).not.toEqual([]);
    const r = readers({ read: truthful });
    const out = await run(book, r);

    expect(out.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 25000]);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 7500, evidence: "two_reads" });
    const report = checks.runChecks(out.rulebook, docs);
    expect(report.grids["g1"]).toEqual({ problems: [], unproven: [] });
    expect(report.quotes).toEqual({});
    expect(out.rulebook.questions).toEqual([]);
    expect(out.usd).toBeCloseTo(0.2);
    expect(out.log).toContain("p.1 (Budget.pdf): two reads agree on 7 values ✓");
    expect(book.grids[0]!.rows[0]!.cells[1]).toBe(20500);
  });

  it("asks both models once about the same pages, with the same prompt, and never shows them a current value", async () => {
    const r = readers({ read: truthful });
    await run(rulebook({ grids: [grid(20500)], terms: [term()] }), r);

    expect(r.claude.calls).toHaveLength(1);
    expect(r.openai.calls).toHaveLength(1);
    const [a, b] = [r.claude.calls[0]!, r.openai.calls[0]!];
    expect(a.parts).toEqual(b.parts);
    expect(a.system).toBe(b.system);
    expect(itemsOf(a).map((i) => i.label)).toContain("the amount for 'Screen failure fee'");
    expect(itemsOf(a)).toHaveLength(8);
    for (const current of ["205", "700", "20500", "70000"]) expect(texts(a)).not.toContain(current);
    expect(a.parts.filter((p) => p.type === "image")).toHaveLength(1);
  });

  it("undoes the change when it breaks the arithmetic, and asks a person with both readings", async () => {
    const book = rulebook({ grids: [grid(20500)] });
    const wrong = (label: string) => (label === "row 'Exam' at visit 'V2'" ? "$260.00" : truthful(label));
    const out = await run(book, readers({ read: wrong }));

    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(20500);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([]);
    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "reading", origin: "check", state: "open", about: { target: "grid", id: "g1" } });
    expect(q.readings).toEqual([
      { model: "claude-x", answer: "row 'Exam' at visit 'V2': $260.00" },
      { model: "openai-x", answer: "row 'Exam' at visit 'V2': $260.00" },
    ]);
    expect(q.options.map((o) => o.label)).toEqual(["Use what both models read", "Neither, I'll type the right value"]);
    expect(out.log.some((l) => l.includes("arithmetic fails"))).toBe(true);
  });

  it("when both reads match the rulebook and the print itself doesn't add up, asks a person to decide", async () => {
    const book = rulebook({ grids: [grid(20500)] });
    const asPrinted = (label: string) => (label === "row 'Exam' at visit 'V2'" ? "$205.00" : truthful(label));
    const out = await run(book, readers({ read: asPrinted }));

    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(20500);
    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "decision", origin: "check", state: "open" });
    expect(q.context).toContain("rows add up to");
    expect(q.options.map((o) => o.label)).toEqual(["Use them as printed", "Neither, I'll type the right value"]);
  });
});

describe("scanned pages: OCR first", () => {
  const sheet = (exam: string) => `Exhibit A\nScreen failure fee  $75.OO\nExam  $100.00  ${exam}\nLabs  $50.00  $5O.00`;
  const scanned = (text: string): LoadedDoc[] => {
    const [budget, ...rest] = docs;
    const [first, ...pages] = budget!.pages;
    return [{ ...budget!, pages: [{ ...first!, kind: "scan", layout: text, raw: text, words: wordsOf(text) }, ...pages] }, ...rest];
  };
  const openGrid = (): Grid => ({ ...grid(25000), subtotal: [15000, null], grandTotalCents: null });
  const book = () => rulebook({ grids: [openGrid()], terms: [term({ amountCents: 7500, source: { doc: "Budget.pdf", page: 1, quote: "Screen failure fee" } })] });
  const resolveOn = (scan: LoadedDoc[], r: ReturnType<typeof readers>, b: Rulebook, budget: Budget = { limit: 3, spent: 0 }) =>
    resolve(b, scan, checks.runChecks(b, scan), { claude: r.claude.reader, openai: r.openai.reader, budget });

  it("proves every value OCR read as the model wrote it, without calling a model", async () => {
    const scan = scanned(sheet("$250.OO"));
    const b = book();
    expect(checks.runChecks(b, scan).grids["g1"]!.unproven).toHaveLength(2);
    const r = readers({ read: truthful });
    const out = await resolveOn(scan, r, b);

    expect(r.claude.calls).toHaveLength(0);
    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 7500, evidence: "ocr_match" });
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([[0, 1], [1, 1]]);
    expect(checks.runChecks(out.rulebook, scan).problems).toEqual([]);
    expect(out.usd).toBe(0);
  });

  it("finds the quote despite OCR's letter and digit swaps", async () => {
    const scan = scanned(sheet("$250.00").replace("Screen failure fee", "Screen fai1ure fee"));
    const r = readers({ read: truthful });
    const out = await resolveOn(scan, r, book());
    expect(out.rulebook.terms[0]!.evidence).toBe("ocr_match");
    expect(r.claude.calls).toHaveLength(0);
  });

  it("doesn't let an amount elsewhere on the page prove a term whose quote can't be found", async () => {
    const b = rulebook({ grids: [openGrid()], terms: [term({ amountCents: 5000, source: { doc: "Budget.pdf", page: 1, quote: "Archiving fee" } })] });
    const r = readers({ read: truthful });
    const out = await resolveOn(scanned(sheet("$250.00")), r, b);
    expect(out.rulebook.terms[0]!.evidence).not.toBe("ocr_match");
    expect(r.claude.calls.length).toBeGreaterThan(0);
  });

  it("doesn't prove a grid value OCR read in another column of its row", async () => {
    const g = openGrid();
    const b = rulebook({ grids: [{ ...g, subtotal: null, rows: g.rows.map((row, i) => (i === 0 ? { ...row, cells: [25000, 10000] } : row)) }], terms: [] });
    expect(checks.runChecks(b, scanned(sheet("$250.00"))).grids["g1"]!.unproven).toContainEqual({ row: 0, col: 0 });
    const r = readers({ read: truthful });
    const out = await resolveOn(scanned(sheet("$250.00")), r, b);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual(expect.arrayContaining([[1, 0], [1, 1]]));
    expect(out.rulebook.grids[0]!.cellsReadTwice).not.toContainEqual([0, 0]);
    expect(r.claude.calls.length).toBeGreaterThan(0);
  });

  it("takes one closer look, without the OCR text or the value, when OCR read something else, and accepts it when the model reads what it wrote", async () => {
    const scan = scanned(sheet("$256.00"));
    const r = readers({ read: truthful });
    const out = await resolveOn(scan, r, book());

    expect(r.openai.calls).toHaveLength(0);
    expect(r.claude.calls).toHaveLength(1);
    const ask = r.claude.calls[0]!;
    expect(itemsOf(ask).map((i) => i.label)).toEqual(["row 'Exam' at visit 'V2'"]);
    expect(ask.parts.filter((p) => p.type === "image")).toHaveLength(1);
    for (const hidden of ["256", "250", "25000", "Exam  $100"]) expect(texts(ask)).not.toContain(hidden);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([[1, 1], [0, 1]]);
    expect(out.rulebook.terms[0]!.evidence).toBe("ocr_match");
    const report = checks.runChecks(out.rulebook, scan);
    expect([report.quotes, report.grids["g1"]]).toEqual([{}, { problems: [], unproven: [] }]);
    expect(out.log).toContain("p.1 (Budget.pdf): a second look confirms 1 value ✓");
  });

  it("hands over to the two models when the closer look reads something else, and asks a person if they differ, with the crop", async () => {
    const scan = scanned(sheet("$256.00"));
    const r = readers({ read: (l) => (l.includes("Exam") ? "$260.00" : truthful(l)) }, { read: (l) => (l.includes("Exam") ? "$265.00" : truthful(l)) });
    const out = await resolveOn(scan, r, book());

    expect(r.claude.calls).toHaveLength(2);
    expect(r.openai.calls).toHaveLength(1);
    const q = out.rulebook.questions.find((x) => x.id === "read:g1")!;
    expect(q.readings.map((x) => x.answer)).toEqual([expect.stringContaining("row 'Exam' at visit 'V2': $260.00"), expect.stringContaining("row 'Exam' at visit 'V2': $265.00")]);
    expect(q.source.region).toBeDefined();
    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(25000);
  });

  it("settles by the two models when they agree after a closer look that disagreed", async () => {
    const scan = scanned(sheet("$256.00"));
    const r = readers({ read: (l) => (l.includes("Exam") && r.claude.calls.length === 1 ? "$260.00" : truthful(l)) }, { read: truthful });
    const out = await resolveOn(scan, r, book());

    expect(r.claude.calls).toHaveLength(2);
    expect(out.log.some((l) => l.includes("two reads agree"))).toBe(true);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toContainEqual([0, 1]);
    expect(out.rulebook.questions).toEqual([]);
  });

  it("keeps to the budget: no closer look when it would pass the limit, and the value stays for the next stage", async () => {
    const scan = scanned(sheet("$256.00"));
    const r = readers({ read: truthful });
    const out = await resolveOn(scan, r, book(), { limit: 1, spent: 1 });
    expect(r.claude.calls).toHaveLength(0);
    expect(out.log.some((l) => l.includes("the second look could not be done"))).toBe(true);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([[1, 1]]);
  });
});

describe("reading: two reads disagree", () => {
  it("asks one question per grid, with every disagreeing value, both readings and each model's values as an option", async () => {
    const book = rulebook({ grids: [grid(20500)] });
    const read = (label: string, exam: string, labs: string) =>
      label === "row 'Exam' at visit 'V2'" ? exam : label === "row 'Labs' at visit 'V1'" ? labs : truthful(label);
    const out = await run(book, readers({ read: (l) => read(l, "$250.00", "$50.00") }, { read: (l) => read(l, "$205.00", "$80.00") }));

    expect(out.rulebook.questions).toHaveLength(1);
    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "reading", origin: "check", state: "open", about: { target: "grid", id: "g1" } });
    expect(q.readings).toEqual([
      { model: "claude-x", answer: "row 'Exam' at visit 'V2': $250.00; row 'Labs' at visit 'V1': $50.00" },
      { model: "openai-x", answer: "row 'Exam' at visit 'V2': $205.00; row 'Labs' at visit 'V1': $80.00" },
    ]);
    expect(q.options.map((o) => o.label)).toEqual(["Use what claude-x read", "Use what openai-x read", "Neither, I'll type the right value"]);
    expect(q.options[0]!.patches).toEqual<Patch[]>([
      { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } },
      { target: "grid", id: "g1", set: { "rows.1.cells.0": 5000 } },
    ]);
    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(20500);
  });

  it("asks one question for all the terms on a page", async () => {
    const page2 = { doc: "Budget.pdf", page: 2, quote: "Exhibit B" };
    const book = rulebook({ terms: [term({ id: "a", name: "Fee A", source: page2 }), term({ id: "b", name: "Fee B", source: page2 })] });
    const out = await run(book, readers({ read: () => "$1.00" }, { read: () => "$2.00" }));
    expect(out.rulebook.questions.map((q) => [q.id, q.about])).toEqual([["read:Budget.pdf:p2", null]]);
  });

  it("treats two blank answers as no reading at all", async () => {
    const out = await run(rulebook({ terms: [term()] }), readers({ read: () => null }));
    const q = question1(out.rulebook, "read:t1");
    expect(q.readings.map((x) => x.answer)).toEqual(["the amount for 'Screen failure fee': blank or unreadable", "the amount for 'Screen failure fee': blank or unreadable"]);
    expect(q.options.map((o) => o.label)).toEqual(["Neither, I'll type the right value"]);
    expect(out.rulebook.terms[0]!.evidence).toBe("quote");
  });
});

it("leaves reading questions raised by a model for a person: two models agreeing never settles them", async () => {
  const q = question({ options: [{ label: "$500.00", patches: [] }, { label: "$5,000.00", patches: [] }] });
  const r = readers({ read: () => "1" });
  const out = await run(rulebook({ questions: [q] }), r);
  expect(question1(out.rulebook, "q1")).toMatchObject({ state: "open", readings: [], resolution: null });
  expect(r.claude.calls).toHaveLength(0);
});

describe("elsewhere", () => {
  const options = [
    { label: "Yes, it applies", patches: [{ target: "term" as const, id: "t1", set: { holdbackApplies: "yes" } }] },
    { label: "No", patches: [] },
  ];
  const book = () =>
    rulebook({
      terms: [term({ source: { doc: "Contract.pdf", page: 1, quote: "Article 4" }, evidence: "quote", holdbackApplies: "unclear" })],
      questions: [
        question({ id: "e1", kind: "elsewhere", question: "Does the holdback apply?", options }),
        question({ id: "e2", kind: "elsewhere", question: "Is there a cap?", options }),
      ],
    });
  const hit = { question: 0, found: true, doc: "Contract.pdf", page: 1, quote: "The holdback applies to all site fees", option: 0 };

  it("never settles an amount, or a quote too short to identify a clause, by citation", async () => {
    const amount = [{ label: "$900", patches: [{ target: "term" as const, id: "t1", set: { amountCents: 90000 } }] }];
    const b = rulebook({
      terms: [term({ source: { doc: "Contract.pdf", page: 1, quote: "Article 4" }, evidence: "quote", holdbackApplies: "unclear" })],
      questions: [
        question({ id: "e1", kind: "elsewhere", options: amount }),
        question({ id: "e2", kind: "elsewhere", options }),
      ],
    });
    const out = await run(b, readers({ find: { answers: [hit, { ...hit, question: 1, quote: "holdback applies" }] } }));
    expect(out.rulebook.terms[0]!.amountCents).toBe(70000);
    expect(question1(out.rulebook, "e1")).toMatchObject({ kind: "decision", state: "open" });
    expect(question1(out.rulebook, "e2")).toMatchObject({ kind: "decision", state: "open" });
  });

  it("settles a question whose quote is verified on a text page, in one call for all questions", async () => {
    const r = readers({ find: { answers: [hit, { question: 1, found: false, doc: null, page: null, quote: null, option: null }] } });
    const out = await run(book(), r);

    expect(r.claude.calls).toHaveLength(1);
    expect(r.openai.calls).toHaveLength(0);
    const prompt = texts(r.claude.calls[0]!);
    expect(prompt).toContain("=== Contract.pdf p1 ===");
    expect(prompt).toContain("=== Budget.pdf p3 ===");
    expect(prompt).not.toContain("PROTOCOL-ONLY-TEXT");
    expect(prompt).toContain("Question 1: Is there a cap?");

    const e1 = question1(out.rulebook, "e1");
    expect(e1.state).toBe("auto_resolved");
    expect(e1.resolution).toEqual({ by: "citation", patches: options[0]!.patches, citation: { doc: "Contract.pdf", page: 1, quote: "The holdback applies to all site fees" } });
    expect(out.rulebook.terms[0]!.holdbackApplies).toBe("yes");
    expect(question1(out.rulebook, "e2")).toMatchObject({ kind: "decision", state: "open" });
  });

  it("turns a question into a decision when the quote isn't on the page, the page is a scan, or the option is invalid", async () => {
    const answers = [
      { ...hit, quote: "The holdback never applies" },
      { ...hit, question: 1, doc: "Budget.pdf", page: 1, quote: "Exhibit A" },
    ];
    const out = await run(book(), readers({ find: { answers } }));
    expect(out.rulebook.questions.map((q) => [q.id, q.kind, q.state])).toEqual([["e1", "decision", "open"], ["e2", "decision", "open"]]);
    expect(out.rulebook.terms[0]!.holdbackApplies).toBe("unclear");

    const badOption = await run(book(), readers({ find: { answers: [{ ...hit, option: 5 }] } }));
    expect(question1(badOption.rulebook, "e1")).toMatchObject({ kind: "decision", state: "open" });
  });
});

describe("decisions", () => {
  it("are never touched or sent to a model", async () => {
    const decision = question({ id: "d1", kind: "decision", options: [{ label: "A", patches: [] }] });
    const r = readers({ read: () => "0" });
    const out = await run(rulebook({ questions: [decision] }), r);
    expect(out.rulebook.questions).toEqual([decision]);
    expect(r.claude.calls).toHaveLength(0);
  });
});

describe("budget and errors", () => {
  it("stops calling models when the budget is spent, and leaves everything open with a log line", async () => {
    const e = question({ id: "e1", kind: "elsewhere", options: [{ label: "A", patches: [] }] });
    const r = readers({ read: truthful, find: { answers: [] } });
    const out = await run(rulebook({ grids: [grid(20500)], questions: [e] }), r, { limit: 0.15, spent: 0 });

    expect(r.claude.calls).toHaveLength(1);
    expect(r.openai.calls).toHaveLength(1);
    expect(out.rulebook.questions.find((q) => q.id === "e1")).toEqual(e);
    expect(out.log.some((l) => l.includes("$0.15 limit would be passed"))).toBe(true);
  });

  it("makes no call when the budget is already spent, and asks a person about what it could not read", async () => {
    const r = readers({ read: truthful });
    const out = await run(rulebook({ grids: [grid(20500)] }), r, { limit: 1, spent: 1 });
    expect(r.claude.calls).toHaveLength(0);
    expect(out.usd).toBe(0);
    expect(question1(out.rulebook, "read:g1")).toMatchObject({ state: "open", readings: [] });
    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(20500);
  });

  it("leaves the items for a person when a reader fails, without showing its error, and carries on", async () => {
    const e = question({ id: "e1", kind: "elsewhere", question: "Does the holdback apply?", options: [{ label: "A", patches: [] }] });
    const r = readers({ read: truthful, find: { answers: [] } }, { fail: true });
    const budget = { limit: 3, spent: 0 };
    const out = await run(rulebook({ grids: [grid(20500)], questions: [e] }), r, budget);

    expect(question1(out.rulebook, "read:g1")).toMatchObject({ state: "open", readings: [] });
    expect(out.log.join("\n")).toContain("openai-x couldn't answer");
    expect(out.log.join("\n")).not.toContain("secret");
    expect(question1(out.rulebook, "e1")).toMatchObject({ kind: "decision" });
    expect(budget.spent).toBeCloseTo(0.2);
  });
});
