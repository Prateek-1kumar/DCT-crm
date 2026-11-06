import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Patch, Question, Region, Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checks } from "../src/checks";
import type { Ask, Budget, Reader } from "../src/models/reader";
import { pdfReader } from "../src/pdf";
import { resolve } from "../src/resolve";
import type { Doubt, LoadedDoc } from "../src/types";
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
  subtotal: [15000, 30000], overhead: null, additions: [], total: null, grandTotalCents: 45000, cellsReadTwice: [], acceptedAsPrinted: false,
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
    expect(q.options[0]!.patches).toEqual<Patch[]>([{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }]);
  });
});

describe("scanned pages: one closer look by the vision reader", () => {
  const sheet = "Exhibit A\nScreen failure fee  $75.00\nExam  $100.00  $250.00\nLabs  $50.00  $50.00\nStartup fee  $1,000.00\nAmended charge  $900.00";
  const scanned = (doubts: Record<number, Doubt> = {}, text = sheet): LoadedDoc[] => {
    const [budget, ...rest] = docs;
    const [first, ...pages] = budget!.pages;
    const words = wordsOf(text).map((w) => ({ ...w, ...(doubts[Math.round(w.y0 * 100)] ? { doubt: doubts[Math.round(w.y0 * 100)] } : {}) }));
    return [{ ...budget!, pages: [{ ...first!, kind: "scan", layout: text, raw: text, words }, ...pages] }, ...rest];
  };
  const fee = (over: Partial<Term> = {}) => term({ amountCents: 7500, source: { doc: "Budget.pdf", page: 1, quote: "Screen failure fee" }, ...over });
  const resolveOn = (scan: LoadedDoc[], r: ReturnType<typeof readers>, b: Rulebook) =>
    resolve(b, scan, checks.runChecks(b, scan), { claude: r.claude.reader, openai: r.openai.reader, budget: { limit: 3, spent: 0 } });

  it("a matching zoomed re-look proves a scanned amount", async () => {
    const r = readers({ fail: true }, { read: () => "$75.00" });
    const out = await resolveOn(scanned(), r, rulebook({ terms: [fee()] }));

    expect(r.claude.calls).toHaveLength(0);
    expect(r.openai.calls).toHaveLength(1);
    expect(itemsOf(r.openai.calls[0]!).map((i) => i.label)).toEqual([expect.stringContaining("every amount printed on the row labelled 'Screen failure fee'")]);
    expect(texts(r.openai.calls[0]!)).not.toContain("7500");
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 7500, evidence: "two_reads" });
    expect(out.rulebook.questions).toEqual([]);
  });

  it("a term whose value is printed on its row next to another amount is confirmed by the re-look", async () => {
    const text = "Exhibit A\nCoordinator fee  $200.00  $266.00";
    const t = term({ amountCents: 20000, name: "Coordinator fee", source: { doc: "Budget.pdf", page: 1, quote: "Coordinator fee" } });
    const r = readers({ fail: true }, { read: () => "$200.00 | $266.00" });
    const out = await resolveOn(scanned({}, text), r, rulebook({ terms: [t] }));

    expect(itemsOf(r.openai.calls[0]!)[0]!.label).toContain("every amount printed on the row labelled 'Coordinator fee'");
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 20000, evidence: "two_reads" });
    expect(out.rulebook.questions).toEqual([]);

    const missing = await resolveOn(scanned({}, text), readers({ fail: true }, { read: () => "$266.00 | $300.00" }), rulebook({ terms: [t] }));
    const q = question1(missing.rulebook, "read:t1");
    expect(q.readings[1]!.answer).toBe("the amount for 'Coordinator fee': $266.00, $300.00 on that row");
    expect(q.options.map((o) => o.label)).toEqual(["Use the whole-page reading ($200.00)", "Neither, I'll type the right value"]);
    expect(missing.rulebook.terms[0]!.evidence).toBe("quote");
  });

  it("a re-run drops a reading question the re-look now confirms", async () => {
    const stale = question({ id: "read:t1", origin: "check", about: { target: "term", id: "t1" } });
    const out = await resolveOn(scanned(), readers({ fail: true }, { read: () => "$75.00" }), rulebook({ terms: [fee()], questions: [stale] }));

    expect(out.rulebook.questions.find((q) => q.id === "read:t1")).toBeUndefined();
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 7500, evidence: "two_reads" });
  });

  it("a re-run keeps answered questions and questions from the compile agent, the reviewer and the rules", async () => {
    const kept = [
      question({ id: "read:t1", origin: "check", state: "answered" }),
      question({ id: "read:c1", origin: "compile" }),
      question({ id: "person:r1", origin: "reviewer" }),
      question({ id: "read:u1", origin: "rule" }),
      question({ id: "read:g1:printed", origin: "check", kind: "decision" }),
    ];
    const out = await resolveOn(scanned(), readers({ fail: true }, { read: () => "$75.00" }), rulebook({ terms: [fee()], questions: kept }));

    expect(out.rulebook.questions).toEqual(kept);
  });

  it("a differing re-look asks with both readings and the crop", async () => {
    const r = readers({ fail: true }, { read: () => "$85.00" });
    const out = await resolveOn(scanned(), r, rulebook({ terms: [fee()] }));

    const q = question1(out.rulebook, "read:t1");
    expect(q).toMatchObject({ kind: "reading", origin: "check", state: "open", about: { target: "term", id: "t1" } });
    expect(q.readings).toEqual([
      { model: "openai-x (whole page)", answer: "the amount for 'Screen failure fee': $75.00" },
      { model: "openai-x (zoomed)", answer: "the amount for 'Screen failure fee': $85.00" },
    ]);
    expect(q.source.region).toBeDefined();
    expect(q.options.map((o) => o.label)).toEqual(["Use the whole-page reading ($75.00)", "Use the zoomed reading ($85.00)", "Neither, I'll type the right value"]);
    expect(out.rulebook.terms[0]).toMatchObject({ amountCents: 7500, evidence: "quote" });
  });

  describe("a dense page, where rows are 0.015 apart", () => {
    const centre = (i: number) => 0.02 + i * 0.015;
    const dense = (): LoadedDoc[] => {
      const [budget, ...rest] = docs;
      const [first, ...pages] = budget!.pages;
      const words = Array.from({ length: 44 }, (_, i) => [
        { text: `Fee${i}`, x0: 0.05, x1: 0.1, y0: centre(i) - 0.005, y1: centre(i) + 0.005 },
        { text: `$${i}.00`, x0: 0.3, x1: 0.4, y0: centre(i) - 0.005, y1: centre(i) + 0.005 },
      ]).flat();
      return [{ ...budget!, pages: [{ ...first!, kind: "scan", layout: "", raw: "", words }, ...pages] }, ...rest];
    };
    const fees = (rows: number[]) => rows.map((i) => term({ id: `t${i}`, name: `Fee${i}`, amountCents: i * 100, source: { doc: "Budget.pdf", page: 1, quote: `Fee${i}` } }));
    const answer = (label: string) => `$${/Fee(\d+)/.exec(label)![1]}.00`;
    const look = (rows: number[], r: ReturnType<typeof readers>) => {
      const scan = dense();
      const book = rulebook({ terms: fees(rows) });
      return resolve(book, scan, checks.runChecks(book, scan), { claude: r.claude.reader, openai: r.openai.reader, budget: { limit: 3, spent: 0 } });
    };

    it("the zoomed re-look crop contains the rows either side of the target", async () => {
      const regions: Region[] = [];
      const render = pdfReader.render.bind(pdfReader);
      const spy = vi.spyOn(pdfReader, "render").mockImplementation(async (doc, n, opts) => {
        if (opts?.region) regions.push(opts.region);
        return render(doc, n, opts);
      });
      try {
        await look([20], readers({ fail: true }, { read: answer }));
      } finally {
        spy.mockRestore();
      }

      expect(regions).toHaveLength(1);
      const [, top, , bottom] = regions[0]!;
      for (const row of [18, 19, 21, 22]) {
        expect(top).toBeLessThanOrEqual(centre(row));
        expect(bottom).toBeGreaterThanOrEqual(centre(row));
      }
    });

    it("tells the reader to read the row with the label, and to answer null if it is not in the picture", async () => {
      const r = readers({ fail: true }, { read: answer });
      await look([20], r);

      expect(r.openai.calls[0]!.system).toContain("row or term it names by its label");
      expect(r.openai.calls[0]!.system).toContain("null if that label is not in the picture");
    });

    it("re-looks on one page are asked in one call", async () => {
      const r = readers({ fail: true }, { read: answer });
      const out = await look([5, 12, 20, 28, 40], r);

      expect(r.openai.calls).toHaveLength(1);
      expect(itemsOf(r.openai.calls[0]!).map((i) => i.label)).toEqual([5, 12, 20, 28, 40].map((i) => expect.stringContaining(`the row labelled 'Fee${i}'`)));
      expect(r.openai.calls[0]!.parts.filter((p) => p.type === "image")).toHaveLength(5);
      expect(out.rulebook.terms.map((t) => t.evidence)).toEqual(Array(5).fill("two_reads"));
    });

    it("a page with many spots is asked in calls of at most 12 crops, each answer kept with its own item", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => i + 1);
      const r = readers({ fail: true }, { read: (label) => (label.includes("Fee9'") ? "$1.00" : answer(label)) });
      const out = await look(rows, r);

      expect(r.openai.calls.map((c) => itemsOf(c).length)).toEqual([12, 2]);
      expect(out.rulebook.terms.filter((t) => t.evidence === "two_reads").map((t) => t.id)).toEqual(rows.filter((i) => i !== 9).map((i) => `t${i}`));
      expect(question1(out.rulebook, "read:t9").readings[1]!.answer).toBe("the amount for 'Fee9': $1.00");
    });
  });

  it("a struck-out amount and its handwritten replacement are both asked, with no model call", async () => {
    const r = readers({ fail: true }, { fail: true });
    const terms = [
      term({ id: "t1", amountCents: 100000, source: { doc: "Budget.pdf", page: 1, quote: "Startup fee" } }),
      term({ id: "t2", amountCents: 90000, source: { doc: "Budget.pdf", page: 1, quote: "Amended charge" } }),
    ];
    const out = await resolveOn(scanned({ 4: "struck_out", 5: "handwritten" }), r, rulebook({ terms }));

    expect(r.claude.calls).toHaveLength(0);
    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.questions.map((q) => [q.id, q.kind, q.source.region !== undefined])).toEqual([["person:t1", "reading", true], ["person:t2", "reading", true]]);
    expect(question1(out.rulebook, "person:t1").context).toContain("p.1 shows this value struck out");
    expect(question1(out.rulebook, "person:t2").context).toContain("p.1 shows this value handwritten");
    expect(question1(out.rulebook, "person:t1").options.map((o) => o.label)).toEqual(["Use $1,000.00", "Neither, I'll type the right value"]);
    expect(out.rulebook.terms.map((t) => t.evidence)).toEqual(["quote", "quote"]);
  });

  it("a scanned grid whose totals fail is fixed by a closer read when the totals then hold", async () => {
    const b = rulebook({ grids: [grid(20500)] });
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned(), r, b);

    expect(r.claude.calls).toHaveLength(0);
    expect(r.openai.calls).toHaveLength(1);
    expect(out.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 25000]);
    expect(out.rulebook.questions).toEqual([]);
    expect(checks.runChecks(out.rulebook, scanned()).grids["g1"]!.problems).toEqual([]);
    expect(out.log).toContain("p.1 (Budget.pdf): a closer read corrected 1 value and the totals now add up ✓");
  });

  it("a scanned grid still failing after the closer read is asked", async () => {
    const wrong = (label: string) => (label === "row 'Exam' at visit 'V2'" ? "$260.00" : truthful(label));
    const r = readers({ fail: true }, { read: wrong });
    const out = await resolveOn(scanned(), r, rulebook({ grids: [grid(20500)] }));

    expect(out.rulebook.grids[0]!.rows[0]!.cells[1]).toBe(20500);
    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "reading", origin: "check", state: "open", about: { target: "grid", id: "g1" } });
    expect(q.readings).toEqual([
      { model: "openai-x (whole page)", answer: "row 'Exam' at visit 'V2': $205.00" },
      { model: "openai-x (zoomed)", answer: "row 'Exam' at visit 'V2': $260.00" },
    ]);
    expect(q.source.region).toBeUndefined();
    expect(q.options.map((o) => o.label)).toEqual(["Use the whole-page reading ($205.00)", "Use the zoomed reading ($260.00)", "Neither, I'll type the right value"]);
  });

  it("a scanned grid whose closer read sees the print as it is asks whether to use it, and the answer accepts it", async () => {
    const asPrinted = (label: string) => (label === "row 'Exam' at visit 'V2'" ? "$205.00" : truthful(label));
    const r = readers({ fail: true }, { read: asPrinted });
    const out = await resolveOn(scanned(), r, rulebook({ grids: [grid(20500)] }));

    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "decision", question: "The figures of 'Budget' don't add up. Use them as printed?" });
    expect(q.options[0]!.patches).toEqual<Patch[]>([{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }]);
  });

  const openGrid = (): Grid => ({ ...grid(25000), subtotal: [15000, null], grandTotalCents: null });

  describe("the closer look is closer than the transcription", () => {
    const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    const imagesOf = (ask: Ask<unknown>) => ask.parts.flatMap((p) => (p.type === "image" ? [sizeOf(p.png)] : []));
    const low = `Exhibit A${"\n".repeat(68)}Visit  V1  V2\nExam  $100.00  $250.00\nLabs  $50.00  $50.00`;

    it("the zoomed re-look of a grid cell sends the header and the row at full detail", async () => {
      const r = readers({ fail: true }, { read: truthful });
      await resolveOn(scanned({}, low), r, rulebook({ grids: [openGrid()] }));

      expect(r.openai.calls).toHaveLength(1);
      const [call] = r.openai.calls;
      expect(imagesOf(call!)).toHaveLength(4);
      for (const image of imagesOf(call!)) {
        expect(image.width).toBeGreaterThanOrEqual(2500);
        expect(image.height).toBeLessThan(500);
      }
      expect(texts(call!)).toContain("column headings");
    });

    it("a grid cell whose visit headings can't be found is shown from the top of the page, so the headings are still in the picture", async () => {
      const r = readers({ fail: true }, { read: truthful });
      await resolveOn(scanned({}, low.replace("Visit  V1  V2\n", "")), r, rulebook({ grids: [openGrid()] }));

      const [call] = r.openai.calls;
      expect(imagesOf(call!)).toHaveLength(2);
      for (const image of imagesOf(call!)) expect(image.height).toBeGreaterThan(2000);
      expect(texts(call!)).not.toContain("column headings");
    });

    it("the closer read of a whole scanned grid sends the page and its strips, as the transcription saw it", async () => {
      const r = readers({ fail: true }, { read: truthful });
      await resolveOn(scanned(), r, rulebook({ grids: [grid(20500)] }));

      const sent = imagesOf(r.openai.calls[0]!);
      expect(sent).toHaveLength(4);
      expect(Math.max(...sent.map((i) => i.width))).toBeGreaterThanOrEqual(1500);
    });
  });

  it("a handwritten cell in a scan grid whose totals fail is asked, never settled by the closer read", async () => {
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, rulebook({ grids: [grid(20500)] }));

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 20500]);
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([]);
    expect(out.rulebook.questions.map((q) => q.id)).toEqual(["person:g1", "read:g1"]);
    expect(question1(out.rulebook, "person:g1").context).toContain("row 'Exam' at visit 'V2': $205.00 (handwritten)");
    expect(question1(out.rulebook, "person:g1").source.region).toBeDefined();
  });

  it("a handwritten cell in a scanned grid whose totals add up is still asked", async () => {
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, rulebook({ grids: [grid(25000)] }));

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.questions.map((q) => q.id)).toEqual(["person:g1"]);
    const q = question1(out.rulebook, "person:g1");
    expect(q.context).toContain("row 'Exam' at visit 'V1': $100.00 (handwritten); row 'Exam' at visit 'V2': $250.00 (handwritten)");
    expect(q.context).not.toContain("Labs");
    expect(out.rulebook.grids[0]!.cellsReadTwice).toEqual([]);
  });

  it("a marked subtotal line in a scanned grid whose totals add up is asked in the same question", async () => {
    const text = "Exhibit A\nExam  $100.00  $250.00\nLabs  $50.00  $50.00\nSubtotal  $150.00  $300.00";
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned({ 3: "struck_out" }, text), r, rulebook({ grids: [grid(25000)] }));

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.questions.map((q) => q.id)).toEqual(["person:g1"]);
    const q = question1(out.rulebook, "person:g1");
    expect(q.context).toContain("the subtotal line at visit 'V1': $150.00 (struck out); the subtotal line at visit 'V2': $300.00 (struck out)");
    expect(q.options[0]!.patches).toEqual<Patch[]>([
      { target: "grid", id: "g1", set: { "subtotal.0": 15000 } },
      { target: "grid", id: "g1", set: { "subtotal.1": 30000 } },
    ]);
  });

  it("a handwritten cell in a passing scanned grid whose row can't be found is still asked, and an unmarked one is not", async () => {
    const lost = grid(25000);
    const b = rulebook({ grids: [{ ...lost, rows: lost.rows.map((row, i) => (i === 0 ? { ...row, name: "Phlebotomy" } : row)) }] });
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, b);

    expect(r.openai.calls).toHaveLength(0);
    const q = question1(out.rulebook, "person:g1");
    expect(q.context).toContain("row 'Phlebotomy' at visit 'V1': $100.00 (could not be found on the page)");
    expect(q.context).not.toContain("Labs");

    const clean = await resolveOn(scanned(), readers({ fail: true }, { read: truthful }), b);
    expect(clean.rulebook.questions).toEqual([]);
  });

  it("a failing scanned grid with a marked cell also asks whether to use the print as it is, without a closer read", async () => {
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, rulebook({ grids: [grid(20500)] }));

    expect(r.openai.calls).toHaveLength(0);
    const q = question1(out.rulebook, "read:g1");
    expect(q).toMatchObject({ kind: "decision", blocking: true, question: "The figures of 'Budget' don't add up. Use them as printed?" });
    expect(q.context).toContain("rows add up to");
    expect(q.context).toContain("The figures shown are as first read from the image, and none were checked closely because some of them are marked");
    expect(q.options).toEqual([
      { label: "Use them as printed", patches: [{ target: "grid", id: "g1", set: { acceptedAsPrinted: true } }] },
      { label: "Neither, I'll type the right value", patches: [] },
    ]);
  });

  it("one handwritten row in a scan grid is asked once", async () => {
    const r = readers({ fail: true }, { fail: true });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, rulebook({ grids: [{ ...grid(25000), subtotal: null, grandTotalCents: null }] }));

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.questions.map((x) => x.id)).toEqual(["person:g1", "read:g1"]);
    const q = question1(out.rulebook, "person:g1");
    expect(q.context).toContain("row 'Exam' at visit 'V1': $100.00 (handwritten); row 'Exam' at visit 'V2': $250.00 (handwritten)");
    expect(q.options.map((o) => o.label)).toEqual(["Use the values as written", "Neither, I'll type the right value"]);
    expect(q.options[0]!.patches).toEqual<Patch[]>([
      { target: "grid", id: "g1", set: { "rows.0.cells.0": 10000 } },
      { target: "grid", id: "g1", set: { "rows.0.cells.1": 25000 } },
    ]);
  });

  it("marked cells on two pages of one scanned grid are asked once, naming each page", async () => {
    const [budget, ...rest] = docs;
    const page = (n: number, text: string) => ({ ...budget!.pages[n - 1]!, kind: "scan" as const, layout: text, raw: text, words: wordsOf(text).map((w) => (w.y0 >= 0.01 ? { ...w, doubt: "handwritten" as const } : w)) });
    const scan = [{ ...budget!, pages: [page(1, "Exhibit A\nExam  $100.00  $250.00"), page(2, "Exhibit B\nLabs  $50.00  $50.00"), budget!.pages[2]!] }, ...rest];
    const g = { ...openGrid(), pages: [1, 2] };
    const r = readers({ fail: true }, { fail: true });
    const out = await resolveOn(scan, r, rulebook({ grids: [g] }));

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.questions.map((q) => q.id)).toEqual(["person:g1"]);
    expect(question1(out.rulebook, "person:g1").context).toContain("row 'Exam' at visit 'V1': $100.00 (handwritten, p.1); row 'Exam' at visit 'V2': $250.00 (handwritten, p.1); row 'Labs' at visit 'V1': $50.00 (handwritten, p.2); row 'Labs' at visit 'V2': $50.00 (handwritten, p.2)");
  });

  it("a failing scan grid whose row can't be found never settles its cells by a closer read", async () => {
    const lost = grid(20500);
    const b = rulebook({ grids: [{ ...lost, rows: lost.rows.map((row, i) => (i === 0 ? { ...row, name: "Phlebotomy" } : row)) }] });
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned(), r, b);

    expect(r.openai.calls).toHaveLength(0);
    expect(out.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 20500]);
    expect(question1(out.rulebook, "person:g1").context).toContain("could not be found on the page");
    expect(question1(out.rulebook, "person:g1").source.region).toBeUndefined();
  });

  it("a handwritten cell and a disagreeing cell in one scan grid both reach a person", async () => {
    const read = (label: string) => (label === "row 'Labs' at visit 'V2'" ? "$55.00" : truthful(label));
    const r = readers({ fail: true }, { read });
    const out = await resolveOn(scanned({ 2: "handwritten" }), r, rulebook({ grids: [openGrid()] }));

    expect(itemsOf(r.openai.calls[0]!).map((i) => i.label)).toEqual(["row 'Labs' at visit 'V2'"]);
    expect(out.rulebook.questions.map((q) => q.id).sort()).toEqual(["person:g1", "read:g1"]);
    expect(question1(out.rulebook, "person:g1").options[0]!.label).toBe("Use the values as written");
    expect(question1(out.rulebook, "read:g1").readings.map((x) => x.model)).toEqual(["openai-x (whole page)", "openai-x (zoomed)"]);
  });

  it("a grid spanning a text page and a scan page is never read by Claude", async () => {
    const spanning = { ...grid(20500), pages: [1, 2] };
    const r = readers({ fail: true }, { read: truthful });
    const out = await resolveOn(scanned(), r, rulebook({ grids: [spanning] }));

    expect(r.claude.calls).toHaveLength(0);
    expect(r.openai.calls).toHaveLength(1);
    expect(r.openai.calls[0]!.parts.filter((p) => p.type === "image")).toHaveLength(5);
    expect(out.rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 25000]);
    expect(out.rulebook.questions).toEqual([]);
  });

  it("a changed scan cell no total covers is asked, not accepted", async () => {
    const g = { ...grid(25000), subtotal: [15000, null], grandTotalCents: null, rows: grid(25000).rows.map((row, i) => (i === 0 ? { ...row, cells: [10500, 25000] } : row)) };
    const read = (label: string) => (label === "row 'Labs' at visit 'V2'" ? "$55.00" : truthful(label));
    const r = readers({ fail: true }, { read });
    const out = await resolveOn(scanned(), r, rulebook({ grids: [g] }));

    expect(out.rulebook.grids[0]!.rows.map((row) => row.cells)).toEqual([[10500, 25000], [5000, 5000]]);
    const q = question1(out.rulebook, "read:g1");
    expect(q.readings.map((x) => x.answer)).toEqual([expect.stringContaining("row 'Labs' at visit 'V2': $50.00"), expect.stringContaining("row 'Labs' at visit 'V2': $55.00")]);
  });

  it("a scanned grid the closer read could not be made is asked in plain words", async () => {
    const out = await resolveOn(scanned(), readers({ fail: true }, { fail: true }), rulebook({ grids: [grid(20500)] }));
    const q = question1(out.rulebook, "read:g1");
    expect(q.context).toBe("This still needs a closer second read of the page, and it could not be done in this run. Start the read again to have this spot read closely.");
    expect(out.log.join("\n")).not.toContain("secret");
  });

  it("when the closer look runs out of budget, the amount is asked and nothing passes silently or is spent", async () => {
    const r = readers({ fail: true }, { read: () => "$75.00" });
    const budget = { limit: 3.8, spent: 3.795 };
    const b = rulebook({ terms: [fee()] });
    const scan = scanned();
    const out = await resolve(b, scan, checks.runChecks(b, scan), { claude: r.claude.reader, openai: r.openai.reader, budget });

    expect(r.openai.calls).toHaveLength(0);
    expect(budget.spent).toBe(3.795);
    expect(out.usd).toBe(0);
    expect(out.rulebook.terms[0]!.evidence).toBe("quote");
    expect(question1(out.rulebook, "read:t1:unread")).toMatchObject({ state: "open", blocking: true, context: expect.stringContaining("Start the read again") });
    expect(out.log.join("\n")).toContain("the $3.80 limit would be passed");
  });

  it("a scanned amount whose spot can't be found is asked", async () => {
    const r = readers({ fail: true }, { read: () => "$50.00" });
    const out = await resolveOn(scanned(), r, rulebook({ terms: [fee({ amountCents: 5000, source: { doc: "Budget.pdf", page: 1, quote: "Archiving fee" } })] }));

    expect(r.openai.calls).toHaveLength(0);
    const q = question1(out.rulebook, "person:t1");
    expect(q.context).toContain("could not be found on the page");
    expect(q.options.map((o) => o.label)).toEqual(["Use $50.00", "Neither, I'll type the right value"]);
    expect(q.source.region).toBeUndefined();
    expect(out.rulebook.terms[0]!.evidence).toBe("quote");
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
