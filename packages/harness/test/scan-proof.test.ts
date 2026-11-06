import { applyPatches, type Grid, type Relation, type Rulebook, type Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { normalizeAccounted, normalizeQuestion } from "../src/agent/normalize";
import { checks } from "../src/checks";
import { coverage } from "../src/checks/coverage";
import { checkRelations, withRelationProof } from "../src/checks/relations";
import type { Reader } from "../src/models/reader";
import { buildPage } from "../src/pdf/page";
import { resolve } from "../src/resolve";
import { withScans } from "../src/scan";
import { parseTranscription, type Transcription } from "../src/scan/transcribe";
import { verifyVersion } from "../src/scan/verify";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";
import { wordsOf } from "./words";

const DOC = "Budget.pdf";
const read = (lines: string[]) => parseTranscription({ rotation: 0, text: lines.join("\n") });
const NO_CALLS: Reader = { model: "openai-x", price: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, ask: () => Promise.reject(new Error("no calls")) };
const docOf = (first: Transcription[]): LoadedDoc =>
  withScans({ name: DOC, path: DOC, sha256: "probe", pages: first.map((_, i) => buildPage(i + 1, [], "image")) }, first.map((transcription, i) => ({ page: i + 1, version: "t", rotation: 0, transcription })));
function storeOf(second: Transcription[]): ScanStore {
  const pages: ScanPage[] = second.map((transcription, i) => ({ page: i + 1, version: verifyVersion(NO_CALLS), rotation: 0, transcription }));
  return { get: () => Promise.resolve([]), put: () => Promise.resolve(), verify: { get: () => Promise.resolve(pages), put: () => Promise.resolve() } };
}
const book = (over: Partial<Rulebook>): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [{ doc: DOC, role: "budget", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null }] },
  terms: [], grids: [], accounted: [], questions: [], relations: [], ...over,
});
async function settle(rb: Rulebook, first: Transcription[], second: Transcription[]) {
  const docs = [docOf(first)];
  const start = withRelationProof(rb, docs);
  const out = await resolve(start, docs, checks.runChecks(start, docs), { claude: NO_CALLS, openai: NO_CALLS, budget: { limit: 3, spent: 0 }, scans: storeOf(second) });
  return { rulebook: out.rulebook, docs, report: checks.runChecks(out.rulebook, docs) };
}
const open = (rb: Rulebook) => rb.questions.filter((q) => q.state === "open");

describe("a figure slipped into a blank cell along a summed row or column is never proven (C1)", () => {
  it("a row total doesn't prove a figure the first read moved sideways into a blank visit", async () => {
    // printed: ECG $100.00 at V1, V2 blank; the first read moved it to V2, and the row total still holds
    const truth = read(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2 | V3 | Total", "R 0.2-0.21 | ECG | $100.00 |  | $100.00 | $200.00", "R 0.22-0.23 | Labs | $50.00 | $50.00 | $50.00 | $150.00"]);
    const first = read(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2 | V3 | Total", "R 0.2-0.21 | ECG |  | $100.00 | $100.00 | $200.00", "R 0.22-0.23 | Labs | $50.00 | $50.00 | $50.00 | $150.00"]);
    const g: Grid = {
      id: "g1", name: "Budget", arm: null, doc: DOC, pages: [1], visits: ["V1", "V2", "V3"], overheadPct: null,
      rows: [
        { name: "ECG", code: null, unitCostCents: null, cells: [null, 10000, 10000], printedRowTotalCents: 20000 },
        { name: "Labs", code: null, unitCostCents: null, cells: [5000, 5000, 5000], printedRowTotalCents: 15000 },
      ],
      subtotal: null, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
      cellIds: { "rows.0.cells.1": "p1.t1.r1.c2", "rows.0.cells.2": "p1.t1.r1.c3", "rows.0.printedRowTotalCents": "p1.t1.r1.c4", "rows.1.cells.0": "p1.t1.r2.c1", "rows.1.cells.1": "p1.t1.r2.c2", "rows.1.cells.2": "p1.t1.r2.c3", "rows.1.printedRowTotalCents": "p1.t1.r2.c4" },
    };
    expect(checks.runChecks(book({ grids: [g] }), [docOf([first])]).grids["g1"]!.unproven).toContainEqual({ row: 0, col: 1 });

    const { rulebook, docs } = await settle(book({ grids: [g] }), [first], [truth]);
    expect(rulebook.grids[0]!.cellsReadTwice).not.toContainEqual([0, 1]);
    const q = open(rulebook).find((x) => x.about?.id === "g1")!;
    expect(q.readings.map((r) => r.answer)).toEqual(["row 'ECG' at visit 'V2': $100.00", "row 'ECG' at visit 'V2': blank"]);
    expect(q.options.map((o) => o.label)).toContain("Use the second reading (blank)");
    // the V1 figure the first read lost is listed as possibly missed
    const missed = coverage(rulebook, docs).pages.flatMap((p) => p.amounts.filter((a) => a.status === "missing").map((a) => a.cents));
    expect(missed).toContain(10000);
  });

  it("a column sum relation doesn't prove a figure the first read moved down into a blank row", async () => {
    // printed: ECG $100.00, Labs blank, Exam $30.00, subtotal $130.00; the first read moved ECG's figure to Labs
    const truth = read(["T 0.1-0.5 | Budget", "H | Procedure | V1", "R 0.2-0.21 | ECG | $100.00", "R 0.22-0.23 | Labs |  ", "R 0.24-0.25 | Exam | $30.00", "R 0.26-0.27 | Subtotal | $130.00"]);
    const first = read(["T 0.1-0.5 | Budget", "H | Procedure | V1", "R 0.2-0.21 | ECG |  ", "R 0.22-0.23 | Labs | $100.00", "R 0.24-0.25 | Exam | $30.00", "R 0.26-0.27 | Subtotal | $130.00"]);
    const g: Grid = {
      id: "g1", name: "Budget", arm: null, doc: DOC, pages: [1], visits: ["V1"], overheadPct: null,
      rows: [
        { name: "ECG", code: null, unitCostCents: null, cells: [null], printedRowTotalCents: null },
        { name: "Labs", code: null, unitCostCents: null, cells: [10000], printedRowTotalCents: null },
        { name: "Exam", code: null, unitCostCents: null, cells: [3000], printedRowTotalCents: null },
      ],
      subtotal: [13000], overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
      cellIds: { "rows.1.cells.0": "p1.t1.r2.c1", "rows.2.cells.0": "p1.t1.r3.c1", "subtotal.0": "p1.t1.r4.c1" },
    };
    const relations: Relation[] = [{ kind: "sum", doc: DOC, result: "p1.t1.r4.c1", operands: ["p1.t1.r2.c1", "p1.t1.r3.c1"] }];
    expect(checks.runChecks(book({ grids: [g], relations }), [docOf([first])]).grids["g1"]!.unproven).toContainEqual({ row: 1, col: 0 });

    const { rulebook } = await settle(book({ grids: [g], relations }), [first], [truth]);
    expect(rulebook.grids[0]!.cellsReadTwice).not.toContainEqual([1, 0]);
    // the reads split the label-only rows differently, so the cell is a person's to check
    expect(open(rulebook).find((x) => x.about?.id === "g1")!.context).toContain("row 'Labs' at visit 'V1': $100.00");
  });
});

describe("a second read's figure that makes the arithmetic hold leaves nothing to fix (C3)", () => {
  it("the corrected cell is proven, and the first read's figure is set aside as corrected", async () => {
    const truth = read(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.2-0.21 | ECG | $100.00 | $40.00", "R 0.22-0.23 | Labs | $30.00 | $50.00", "R 0.24-0.25 | Subtotal | $130.00 | $90.00"]);
    const first = read(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.2-0.21 | ECG | $180.00 | $40.00", "R 0.22-0.23 | Labs | $30.00 | $50.00", "R 0.24-0.25 | Subtotal | $130.00 | $90.00"]);
    const g: Grid = {
      id: "g1", name: "Budget", arm: null, doc: DOC, pages: [1], visits: ["V1", "V2"], overheadPct: null,
      rows: [
        { name: "ECG", code: null, unitCostCents: null, cells: [18000, 4000], printedRowTotalCents: null },
        { name: "Labs", code: null, unitCostCents: null, cells: [3000, 5000], printedRowTotalCents: null },
      ],
      subtotal: [13000, 9000], overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.cells.1": "p1.t1.r1.c2", "rows.1.cells.0": "p1.t1.r2.c1", "rows.1.cells.1": "p1.t1.r2.c2", "subtotal.0": "p1.t1.r3.c1", "subtotal.1": "p1.t1.r3.c2" },
    };
    const { rulebook, report } = await settle(book({ grids: [g] }), [first], [truth]);

    expect(rulebook.grids[0]!.rows[0]!.cells).toEqual([10000, 4000]);
    expect(rulebook.grids[0]!.cellsReadTwice).toContainEqual([0, 0]);
    expect(rulebook.accounted).toEqual([{ doc: DOC, page: 1, cell: "p1.t1.r1.c1", reason: "corrected by a second read" }]);
    expect(open(rulebook)).toEqual([]);
    expect(report.problems).toEqual([]);
  });
});

describe("a second read is applied only where the first read's arithmetic failed", () => {
  const first = read(["T 0.1-0.5 | Budget", "H | Procedure | V1", "R 0.2-0.21 | ECG | $100.00", "R 0.22-0.23 | Labs | $200.00", "R 0.24-0.25 | Subtotal | $300.00"]);
  const swapped = read(["T 0.1-0.5 | Budget", "H | Procedure | V1", "R 0.2-0.21 | ECG | $200.00", "R 0.22-0.23 | Labs | $100.00", "R 0.24-0.25 | Subtotal | $300.00"]);
  const grid = (cells: number[]): Grid => ({
    id: "g1", name: "Budget", arm: null, doc: DOC, pages: [1], visits: ["V1"], overheadPct: null,
    rows: [{ name: "ECG", code: null, unitCostCents: null, cells: [cells[0]!], printedRowTotalCents: null }, { name: "Labs", code: null, unitCostCents: null, cells: [cells[1]!], printedRowTotalCents: null }],
    subtotal: [30000], overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
    cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.1.cells.0": "p1.t1.r2.c1", "subtotal.0": "p1.t1.r3.c1" },
  });

  it("a second read that swaps two figures the first read had right is asked about, never applied", async () => {
    const { rulebook } = await settle(book({ grids: [grid([10000, 20000])] }), [first], [swapped]);
    expect(rulebook.grids[0]!.rows.map((r) => r.cells[0])).toEqual([10000, 20000]);
    expect(rulebook.grids[0]!.cellsReadTwice).toEqual([]);
    expect(rulebook.accounted).toEqual([]);
    const q = open(rulebook).find((x) => x.about?.id === "g1")!;
    expect(q.options.map((o) => o.label)).toEqual(["Use the first readings", "Use the second readings"]);
    expect(q.readings.map((r) => r.answer)).toEqual(["row 'ECG' at visit 'V1': $100.00; row 'Labs' at visit 'V1': $200.00", "row 'ECG' at visit 'V1': $200.00; row 'Labs' at visit 'V1': $100.00"]);
    expect(open(rulebook)).toHaveLength(1);
  });
});

describe("an amount only the second read found is a person's to settle (C2)", () => {
  // the first read dropped the Labs row
  const truth = read(["T 0.1-0.5 | Fees", "H | Item | Fee", "R 0.2-0.21 | ECG | $100.00", "R 0.22-0.23 | Labs | $250.00"]);
  const first = read(["T 0.1-0.5 | Fees", "H | Item | Fee", "R 0.2-0.21 | ECG | $100.00"]);
  const ecg: Term = {
    id: "t1", category: "site_fee", name: "ECG", amountCents: 10000, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
    holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: DOC, page: 1, quote: "ECG $100.00", cell: "p1.t1.r1.c1" }, evidence: "none", houseRuleIds: [], notes: null,
  };
  const missed = (rb: Rulebook, docs: LoadedDoc[]) => coverage(rb, docs).pages.flatMap((p) => p.amounts.filter((a) => a.secondRead !== undefined).map((a) => [a.cents, a.status]));
  /** What the answer route does with a person's pick, without the database. */
  const pick = (rb: Rulebook, id: string, option: number): Rulebook => {
    const chosen = rb.questions.find((q) => q.id === id)!.options[option]!;
    const next = applyPatches(rb, chosen.patches);
    const touched = new Set(chosen.patches.filter((p) => p.target === "term").map((p) => p.id));
    return { ...next, terms: next.terms.map((t) => (touched.has(t.id) ? { ...t, evidence: "person" as const } : t)), questions: next.questions.map((q) => (q.id === id ? { ...q, state: "answered" as const } : q)) };
  };

  it("a person-captured term for the amount, named on its row, clears it", () => {
    const docs = [docOf([first])];
    docs[0]!.pages[0]!.second = truth;
    const labs: Term = { ...ecg, id: "t2", name: "Labs", amountCents: 25000, evidence: "person", source: { doc: DOC, page: 1, quote: "ECG" } };
    expect(missed(book({ terms: [ecg, labs] }), docs)).toEqual([[25000, "decided"]]);
    // the same amount on another row clears nothing
    expect(missed(book({ terms: [ecg, { ...labs, name: "Parking" }] }), docs)).toEqual([[25000, "missing"]]);
  });

  it("is asked once per page, and can be added as a fee by a person, leaving nothing to fix but how it is billed", async () => {
    const { rulebook, docs } = await settle(book({ terms: [ecg] }), [first], [truth]);
    const q = open(rulebook).find((x) => x.id === "read:Budget.pdf:p1:missed")!;
    expect(q).toMatchObject({ kind: "decision", question: "A second reading of p.1 of Budget.pdf found $250.00 that the first reading missed. Is it a fee?" });
    expect(q.options.map((o) => o.label)).toEqual(["It's a fee: add it", "It isn't a separate amount: set it aside"]);
    expect(checks.runChecks(rulebook, docs).unaccounted).toEqual([{ doc: DOC, page: 1, amountCents: 25000, context: "Labs $250.00", secondRead: true }]);

    const added = pick(rulebook, q.id, 0);
    expect(added.terms[1]).toMatchObject({ name: "Labs", amountCents: 25000, billing: "unknown", evidence: "person", source: { doc: DOC, page: 1, quote: "Labs $250.00" } });
    const report = checks.runChecks(added, docs);
    expect(report.problems).toEqual([]);
    expect(report.required.map((x) => x.id)).toEqual(["rule:billing"]);
    expect(missed(added, docs)).toEqual([[25000, "decided"]]);
  });

  it("can be set aside by a person", async () => {
    const { rulebook, docs } = await settle(book({ terms: [ecg] }), [first], [truth]);
    const aside = pick(rulebook, "read:Budget.pdf:p1:missed", 1);
    expect(aside.accounted).toEqual([{ doc: DOC, page: 1, cell: "p1.t1.r2.c1 (second read)", reason: "set aside by a person" }]);
    expect(checks.runChecks(aside, docs).problems).toEqual([]);
    // a re-run asks nothing more
    const again = await resolve(aside, docs, checks.runChecks(aside, docs), { claude: NO_CALLS, openai: NO_CALLS, budget: { limit: 3, spent: 0 }, scans: storeOf([truth]) });
    expect(open(again.rulebook)).toEqual([]);
  });

  it("the agent can't account away a second-read-only amount", () => {
    const docs = [docOf([first])];
    docs[0]!.pages[0]!.second = truth;
    const listed = book({ terms: [ecg], accounted: [{ doc: DOC, page: 1, amountCents: 25000, reason: "a double read" }] });
    expect(missed(listed, docs)).toEqual([[25000, "missing"]]);
    // nor give the reason only a person's answer gives, nor offer to set money aside in a question
    expect(normalizeAccounted({ doc: DOC, page: 1, cell: "p1.t1.r2.c1 (second read)", reason: "Set aside by a person." })).toMatchObject({ ok: false });
    const asked = normalizeQuestion({ id: "q", kind: "decision", question: "Is it a fee?", source: { doc: DOC, page: 1, quote: "" }, options: [{ label: "No", patches: [{ target: "accounted", id: "x", set: { doc: DOC, page: 1, cell: "p1.t1.r2.c1 (second read)", reason: "set aside by a person" } }] }] });
    expect(asked.ok && asked.value.options[0]!.patches).toEqual([]);
    // the compile agent is told so, and isn't asked to fix it
    expect(checks.runChecks(book({ terms: [ecg] }), docs).problems.filter((p) => p.check === "unaccounted")).toEqual([expect.objectContaining({ afterCompile: true })]);
  });
});

describe("a question only a re-run can clear offers no answer (I1)", () => {
  const sheet = read(["T 0.1-0.5 | Fees", "H | Item | Fee", "R 0.2-0.21 | ECG | $100.00"]);
  const ecg = (over: Partial<Term> = {}): Term => ({
    id: "t1", category: "site_fee", name: "ECG", amountCents: 10000, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
    holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: DOC, page: 1, quote: "ECG $100.00", cell: "p1.t1.r1.c1" }, evidence: "none", houseRuleIds: [], notes: null, ...over,
  });

  it("a page whose second read couldn't be made can't be waved through", async () => {
    // no second read in the store, and none can be made: the page is a blank render here
    const { rulebook } = await settle(book({ terms: [ecg()] }), [sheet], []);
    expect(open(rulebook).map((q) => [q.id, q.options])).toEqual([["read:t1:unread", []]]);
    const settled = await settle(book({ terms: [ecg({ evidence: "person" })] }), [sheet], []);
    expect(open(settled.rulebook).map((q) => [q.id, q.options])).toEqual([["read:Budget.pdf:p1:unread", []]]);
  });

  it("a scanned value's question offers only answers that set a value, and says what to do if none is right", async () => {
    const { rulebook } = await settle(book({ terms: [ecg()] }), [sheet], [read(["T 0.1-0.5 | Fees", "H | Item | Fee", "R 0.2-0.21 | ECG | $180.00"])]);
    const q = open(rulebook)[0]!;
    expect(q.options.map((o) => o.label)).toEqual(["Use the first reading ($100.00)", "Use the second reading ($180.00)"]);
    expect(q.context).toContain("If the page prints something else, leave this open and tell the team");
  });
});

describe("an amount in a scanned table's title (I2)", () => {
  const titled = read(["T 0.1-0.5 | Start-up fee $5,000.00 (non-refundable)", "H | Procedure | V1", "R 0.2-0.21 | ECG | $100.00"]);

  it("is counted, and can be cited by its own id", () => {
    const docs = [docOf([titled])];
    expect(docs[0]!.pages[0]!.cells!.map((c) => c.id)).toContain("p1.t1.title");
    expect(coverage(book({}), docs).pages[0]!.amounts.map((a) => [a.cents, a.status])).toEqual([[500000, "missing"], [10000, "missing"]]);
    const startup: Term = {
      id: "t1", category: "site_fee", name: "Start-up fee", amountCents: 500000, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
      holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: DOC, page: 1, quote: "Start-up fee", cell: "p1.t1.title" }, evidence: "none", houseRuleIds: [], notes: null,
    };
    const report = checks.runChecks(book({ terms: [startup] }), docs);
    expect(report.problems.filter((p) => p.check === "cell")).toEqual([]);
    expect(coverage(book({ terms: [startup] }), docs).pages[0]!.amounts[0]).toMatchObject({ cents: 500000, status: "captured" });
  });
});

describe("a grid on a text page and a scanned page (I3)", () => {
  it("an amount the text page happens to print never proves a cell the scan's cell is cited for", () => {
    const scan = docOf([read(["T 0.1-0.5 | Budget", "H | Procedure | V1 | V2", "R 0.2-0.21 | ECG | $100.00 | $50.00"])]);
    const text = buildPage(2, wordsOf("Parking is reimbursed at $50.00 per visit."), "text");
    const docs = [{ ...scan, pages: [...scan.pages, text] }];
    const g: Grid = {
      id: "g1", name: "Budget", arm: null, doc: DOC, pages: [1, 2], visits: ["V1", "V2"], overheadPct: null,
      rows: [{ name: "ECG", code: null, unitCostCents: null, cells: [10000, 5000], printedRowTotalCents: null }],
      subtotal: null, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false,
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.cells.1": "p1.t1.r1.c2" },
    };
    expect(checks.runChecks(book({ grids: [g] }), docs).grids["g1"]!.unproven).toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }]);
  });
});

describe("'same' links one fee printed twice, never two fees (I5)", () => {
  const fees = read(["T 0.1-0.5 | Fees", "H | Item | Fee", "R 0.2-0.21 | Screen failure | $150.00"]);
  const screenFail: Term = {
    id: "t1", category: "site_fee", name: "Screen failure", amountCents: 15000, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
    holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: DOC, page: 1, quote: "Screen failure", cell: "p1.t1.r1.c1" }, evidence: "none", houseRuleIds: [], notes: null,
  };
  const same = (line: string) => {
    const rb = book({ terms: [screenFail], relations: [{ kind: "same", doc: DOC, result: "p1.t1.r1.c1", operands: ["p2.l1"] }] });
    const docs = [docOf([fees, read([`L 0.1-0.12 | ${line}`])])];
    return { evidence: withRelationProof(rb, docs).terms[0]!.evidence, problems: checkRelations(rb, docs).problems.map((p) => p.message) };
  };

  it("an unrelated amount on another page doesn't prove it", () => {
    expect(same("Parking is reimbursed at $150.00 per visit.")).toEqual({
      evidence: "none",
      problems: ["p1.t1.r1.c1 = p2.l1: p2.l1 doesn't name the fee (\"Screen failure\"), so it may be another fee that costs the same."],
    });
  });

  it("nor does the quote of a value citing the other cell, which is always on its own line", () => {
    const parking = { ...screenFail, name: "Parking", source: { doc: DOC, page: 2, quote: "Parking is reimbursed", cell: "p2.l1" } };
    const rb = book({ terms: [parking], relations: [{ kind: "same", doc: DOC, result: "p2.l1", operands: ["p1.t1.r1.c1"] }] });
    const docs = [docOf([fees, read(["L 0.1-0.12 | Parking is reimbursed at $150.00 per visit."])])];
    expect(withRelationProof(rb, docs).terms[0]!.evidence).toBe("none");
  });

  it("the same fee named on the other page does", () => {
    expect(same("Each screen failure is paid at $150.00.")).toEqual({ evidence: "math", problems: [] });
  });
});
