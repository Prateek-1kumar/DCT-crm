import { describe, expect, it } from "vitest";
import type { Rulebook } from "@dct/shared";
import { checks } from "../src/checks";
import type { LoadedDoc, Page, PageKind } from "../src/types";
import { wordsOf } from "./words";

type Grid = Rulebook["grids"][number];
type Term = Rulebook["terms"][number];

const page = (n: number, kind: PageKind, layout: string, raw = layout): Page => ({ page: n, kind, layout, raw, words: wordsOf(layout), maskBoxes: [], firstLine: "", rotation: 0 });
const scan = (n: number, layout: string): Page => page(n, "scan", layout);
const doc = (name: string, ...pages: Page[]): LoadedDoc => ({ name, path: `/x/${name}`, sha256: "0", pages });

const grid = (over: Partial<Grid>): Grid => ({
  id: "g1", name: "Budget", arm: null, doc: "A.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null,
  rows: [], subtotal: null, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], acceptedAsPrinted: false, ...over,
});

const term = (over: Partial<Term>): Term => ({
  id: "t1", category: "site_fee", name: "Startup fee", amountCents: null, unit: null, billing: "auto_paid", trigger: null, cap: null,
  formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
  source: { doc: "A.pdf", page: 1, quote: "x" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [], grids: [], accounted: [], questions: [], ...over,
});

const cbt = (over: Partial<Grid> = {}): Grid =>
  grid({
    visits: ["Screening", "Baseline"],
    overheadPct: 35,
    rows: [
      { name: "Physical exam", code: null, unitCostCents: null, cells: [50000, 40000], printedRowTotalCents: 90000 },
      { name: "Labs", code: null, unitCostCents: null, cells: [124600, 81900], printedRowTotalCents: 206500 },
    ],
    subtotal: [174600, 121900],
    overhead: [61110, 42665],
    additions: [{ name: "Stipend", cells: [10000, 10000] }],
    total: [245710, 174565],
    grandTotalCents: 420275,
    ...over,
  });

describe("checkGrid", () => {
  it("proves the CBT-CS301 columns", () => {
    expect(checks.checkGrid(cbt(), [])).toEqual({ problems: [], unproven: [] });
  });

  it("flags a wrong cell in its column and row, and leaves it unproven", () => {
    const g = cbt();
    g.rows[1]!.cells[0] = 142600;
    const r = checks.checkGrid(g, []);
    expect(r.problems).toContain("visit 'Screening': rows add up to $1,926.00 but the printed subtotal is $1,746.00.");
    expect(r.problems).toContain("row 'Labs': the cells add up to $2,245.00 but the printed row total is $2,065.00.");
    expect(r.unproven).toEqual([{ row: 1, col: 0 }]);
  });

  it("proves a total-row-only grid by its total row", () => {
    const flat = grid({ rows: [{ name: "Visit fee", code: null, unitCostCents: null, cells: [10000, 25000], printedRowTotalCents: null }], total: [10000, 25000] });
    expect(checks.checkGrid(flat, [])).toEqual({ problems: [], unproven: [] });
  });

  it("leaves a cell the total row contradicts unproven unless its amount is printed on a text page", () => {
    const flat = grid({ rows: [{ name: "Visit fee", code: null, unitCostCents: null, cells: [10000, 25000], printedRowTotalCents: null }], total: [10000, 26000] });
    const r = checks.checkGrid(flat, [doc("A.pdf", page(1, "text", "Visit fee  $100.00"))]);
    expect(r.problems).toHaveLength(1);
    expect(r.unproven).toEqual([{ row: 0, col: 1 }]);
    expect(checks.checkGrid(flat, [doc("A.pdf", page(1, "text", "Visit fee  $100.00  $250.00"))]).unproven).toEqual([]);
    expect(checks.checkGrid(flat, [doc("A.pdf", page(2, "text", "$100.00 $250.00"))]).unproven).toEqual([{ row: 0, col: 1 }]);
  });

  it("keeps cells unproven on an image page even when its layout has the amounts", () => {
    const flat = grid({ rows: [{ name: "Visit fee", code: null, unitCostCents: null, cells: [10000, 25000], printedRowTotalCents: null }], total: [11000, 26000] });
    expect(checks.checkGrid(flat, [doc("A.pdf", page(1, "image", "$100.00 $250.00"))]).unproven).toHaveLength(2);
  });

  it("returns only shape problems when lengths differ", () => {
    const g = cbt({ subtotal: [174600], additions: [{ name: "Stipend", cells: [1, 2, 3] }] });
    g.rows[0]!.cells = [50000];
    const r = checks.checkGrid(g, []);
    expect(r.problems).toHaveLength(3);
    expect(r.problems.every((p) => p.includes("2 visits"))).toBe(true);
    expect(r.unproven).toHaveLength(3);
  });

  it("accepts overhead within 50 cents and flags it beyond", () => {
    const base = { overheadPct: 10, rows: [{ name: "Fee", code: null, unitCostCents: null, cells: [100000, null], printedRowTotalCents: null }], subtotal: [100000, null] };
    expect(checks.checkGrid(grid({ ...base, overhead: [10050, null] }), []).problems).toEqual([]);
    expect(checks.checkGrid(grid({ ...base, overhead: [9950, null] }), []).problems).toEqual([]);
    expect(checks.checkGrid(grid({ ...base, overhead: [10051, null] }), []).problems).toEqual([
      "visit 'V1': overhead is printed as $100.51 but 10% of the $1,000.00 subtotal is $100.00.",
    ]);
  });

  it("checks the grand total against all rows when there is no total row", () => {
    const rows = [{ name: "Fee", code: null, unitCostCents: null, cells: [10000, "Invoice"], printedRowTotalCents: null }];
    expect(checks.checkGrid(grid({ rows, grandTotalCents: 10000 }), [])).toEqual({ problems: [], unproven: [] });
    const bad = checks.checkGrid(grid({ rows, grandTotalCents: 12000 }), []);
    expect(bad.problems).toEqual(["all the rows add up to $100.00 but the printed grand total is $120.00."]);
    expect(bad.unproven).toEqual([{ row: 0, col: 0 }]);
  });

  it("flags visit totals that do not add to the grand total and totals that do not add up", () => {
    const r = checks.checkGrid(cbt({ total: [245710, 174000], grandTotalCents: 420275 }), []);
    expect(r.problems).toEqual([
      "visit 'Baseline': subtotal, overhead and added lines come to $1,745.65 but the printed total is $1,740.00.",
      "the visit totals add up to $4,197.10 but the printed grand total is $4,202.75.",
    ]);
  });

  it("asks for printed totals when none were captured", () => {
    const g = grid({ rows: [{ name: "Fee", code: null, unitCostCents: null, cells: [100, 200], printedRowTotalCents: null }] });
    const r = checks.checkGrid(g, []);
    expect(r.problems).toEqual(["nothing printed proves these cells: capture the printed subtotal/total rows."]);
    expect(r.unproven).toHaveLength(2);
  });
});

describe("checkQuote", () => {
  const d = [doc("A.pdf", page(1, "text", "The Site shall be paid\n  “Net  45”—days", "unrelated"), page(2, "image", ""))];
  const src = (quote: string, p = 1, name = "A.pdf") => ({ doc: name, page: p, quote });

  it("finds a quote across line breaks, curly quotes and dashes", () => {
    expect(checks.checkQuote(src('site shall be paid "net 45"-days'), d)).toBeNull();
    expect(checks.checkQuote(src("sitesha llbepaid"), d)).toBeNull();
  });

  it("reports a missing quote, document, page and empty quote", () => {
    expect(checks.checkQuote(src("net 60"), d)).toBe("quote not found on p.1 of A.pdf");
    expect(checks.checkQuote(src("x", 1, "B.pdf"), d)).toContain("B.pdf");
    expect(checks.checkQuote(src("x", 9), d)).toContain("p.9");
    expect(checks.checkQuote(src("  "), d)).toContain("no quote");
  });

  it("cannot check a quote on an image page", () => {
    expect(checks.checkQuote(src("anything", 2), d)).toBeNull();
  });
});

describe("a grid accepted as printed", () => {
  it("has no arithmetic problems, and its cells count as proven by a person", () => {
    const wrong = cbt({ subtotal: [174600, 999] });
    expect(checks.checkGrid(wrong, []).problems).not.toEqual([]);
    expect(checks.checkGrid({ ...wrong, acceptedAsPrinted: true }, [])).toEqual({ problems: [], unproven: [] });
  });

  it("still reports a row that doesn't have one value per visit", () => {
    const short = cbt({ acceptedAsPrinted: true, rows: [{ name: "Labs", code: null, unitCostCents: null, cells: [1], printedRowTotalCents: null }] });
    expect(checks.checkGrid(short, []).problems).toHaveLength(1);
  });
});

describe("checkQuote on a scanned page", () => {
  const d = [doc("A.pdf", scan(1, "The Site shal1 pay $1,2OO.00 within 45 days of the invoice.\nSchedu1e B"))];
  const src = (quote: string) => ({ doc: "A.pdf", page: 1, quote });

  it("finds a quote despite reading slips on either side", () => {
    expect(checks.checkQuote(src("The Site shall pay $1,200.00 within 45 days"), d)).toBeNull();
    expect(checks.checkQuote(src("the site shal1 pay $1200.OO within 4S days of the invoice"), d)).toBeNull();
    expect(checks.checkQuote(src("Schedule B"), d)).toBeNull();
  });

  it("still reports a quote that isn't there, and keeps text pages exact", () => {
    expect(checks.checkQuote(src("The Sponsor shall pay $9,999.00 within 90 days"), d)).toBe("quote not found on p.1 of A.pdf");
    expect(checks.checkQuote(src("Schedule C"), d)).toBe("quote not found on p.1 of A.pdf");
    const text = [doc("A.pdf", page(1, "text", "The Site shal1 pay within 45 days"))];
    expect(checks.checkQuote(src("The Site shall pay within 45 days"), text)).toBe("quote not found on p.1 of A.pdf");
  });
});

describe("an amount on a scanned page", () => {
  const docs = [doc("A.pdf", scan(1, "Startup fee $1,200.00"), page(2, "text", "Startup fee $1,200.00"))];
  const at = (page: number, over: Partial<Term> = {}) => term({ id: `t${page}`, amountCents: 120000, source: { doc: "A.pdf", page, quote: "Startup fee" }, ...over });

  it("needs arithmetic, two reads or a person; an amount on a text page is as before", () => {
    const rb = rulebook({
      terms: [at(1, { evidence: "quote" }), at(1, { id: "m", evidence: "math" }), at(1, { id: "r", evidence: "two_reads" }), at(1, { id: "p", evidence: "person" }), at(1, { id: "n", amountCents: null }), at(2, { evidence: "quote" })],
    });
    const { quotes } = checks.runChecks(rb, docs);
    expect(Object.keys(quotes)).toEqual(["t1"]);
    expect(quotes.t1).toMatch(/^scanned page.*closer second read/);
  });
});

describe("unaccounted", () => {
  const d = [doc("A.pdf", page(1, "text", "Startup fee  $2,500.00\nVisit  $100.00  $100.00"), page(2, "text", "Late fee $2,500.00"))];
  const withDocs = (over: Partial<Rulebook["study"]["documents"][number]> = {}) =>
    ({ doc: "A.pdf", role: "cta" as const, hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null, ...over });

  it("reports a stray amount once per page, with its line", () => {
    const rb = rulebook({ terms: [term({ amountCents: 10000 })] });
    expect(checks.unaccounted(rb, d)).toEqual([
      { doc: "A.pdf", page: 1, amountCents: 250000, context: "Startup fee $2,500.00" },
      { doc: "A.pdf", page: 2, amountCents: 250000, context: "Late fee $2,500.00" },
    ]);
  });

  it("counts amounts in rulebook values and in text fields as accounted", () => {
    expect(checks.unaccounted(rulebook({ terms: [term({ amountCents: 250000 }), term({ id: "t2", amountCents: 10000 })] }), d)).toEqual([]);
    expect(checks.unaccounted(rulebook({ terms: [term({ formula: "$100 per visit, plus $2,500 once" })] }), d)).toEqual([]);
    expect(checks.unaccounted(rulebook({ grids: [grid({ grandTotalCents: 250000, subtotal: [10000] })] }), d)).toEqual([]);
  });

  it("honours accounted pages and amounts, and documents without money", () => {
    const base = rulebook({ terms: [term({ amountCents: 10000 })] });
    const accounted = (a: object) => ({ ...base, accounted: [{ doc: "A.pdf", reason: "superseded", ...a }] });
    expect(checks.unaccounted(accounted({ pages: [1, 2] }), d)).toEqual([]);
    expect(checks.unaccounted(accounted({ pages: [1] }), d).map((u) => u.page)).toEqual([2]);
    expect(checks.unaccounted(accounted({ page: 1, amountCents: 250000 }), d)).toEqual([]);
    expect(checks.unaccounted({ ...base, study: { ...base.study, documents: [withDocs({ hasMoney: false })] } }, d)).toEqual([]);
    expect(checks.unaccounted({ ...base, study: { ...base.study, documents: [withDocs()] } }, d)).toHaveLength(2);
  });
});

describe("requiredDecisions", () => {
  it("asks how a single payable term with unknown billing is paid", () => {
    const [q, ...rest] = checks.requiredDecisions(rulebook({ terms: [term({ billing: "unknown" })] }));
    expect(rest).toEqual([]);
    expect(q).toMatchObject({ id: "rule:billing", kind: "decision", origin: "rule", state: "open", about: { target: "term", id: "t1" } });
    expect(q!.options.map((o) => o.patches)).toEqual([
      [{ target: "term", id: "t1", set: { billing: "auto_paid" } }],
      [{ target: "term", id: "t1", set: { billing: "invoice" } }],
    ]);
  });

  it("groups every unclear term of a kind into one question, with a per-item way out", () => {
    const terms = [term({ billing: "unknown" }), term({ id: "t2", name: "Archiving", billing: "unknown" })];
    const [q, ...rest] = checks.requiredDecisions(rulebook({ terms }));
    expect(rest).toEqual([]);
    expect(q!.about).toBeNull();
    expect(q!.context).toContain("Items: Startup fee; Archiving.");
    expect(q!.options[1]!.patches.map((p) => p.id)).toEqual(["t1", "t2"]);
    expect(q!.options.at(-1)).toEqual({ label: "It differs: I'll say for each", patches: [] });
  });

  it("asks item by item once the group was answered \"It differs\"", () => {
    const terms = [term({ billing: "unknown" }), term({ id: "t2", name: "Archiving", billing: "unknown" })];
    const group = checks.requiredDecisions(rulebook({ terms }))[0]!;
    const qs = checks.requiredDecisions(rulebook({ terms, questions: [{ ...group, state: "answered" }] }));
    expect(qs.map((q) => [q.id, q.about?.id])).toEqual([["rule:billing:t1", "t1"], ["rule:billing:t2", "t2"]]);
    expect(qs.every((q) => q.options.every((o) => o.patches.length === 1))).toBe(true);
  });

  it("never asks about contract rules that aren't payments", () => {
    const rules = [term({ category: "other", billing: "unknown", overheadApplies: "unclear" }), term({ id: "t2", category: "payment_terms", billing: "unknown" })];
    expect(checks.requiredDecisions(rulebook({ terms: rules }))).toEqual([]);
  });

  it("asks about the holdback only when a holdback clause exists, citing that clause", () => {
    const unclear = term({ holdbackApplies: "unclear" });
    expect(checks.requiredDecisions(rulebook({ terms: [unclear] }))).toEqual([]);
    const clause = term({ id: "h", category: "holdback", name: "Holdback", source: { doc: "A.pdf", page: 4, quote: "5% withheld" } });
    const qs = checks.requiredDecisions(rulebook({ terms: [clause, unclear] }));
    expect(qs.map((q) => q.id)).toEqual(["rule:holdback"]);
    expect(qs[0]!.source).toEqual(clause.source);
  });

  it("asks how overhead relates to unclear terms only", () => {
    const qs = checks.requiredDecisions(rulebook({ terms: [term({ overheadApplies: "unclear" }), term({ id: "t2", overheadApplies: "added" })] }));
    expect(qs.map((q) => q.id)).toEqual(["rule:overhead"]);
    expect(qs[0]!.options.map((o) => o.patches[0]?.set)).toEqual([{ overheadApplies: "included" }, { overheadApplies: "added" }, { overheadApplies: "no" }]);
  });

  it("asks for an amendment's start date only when it has none", () => {
    const study = (effectiveFrom: string | null) => ({
      ...rulebook().study,
      documents: [{ doc: "Amend1.pdf", role: "amendment" as const, hasMoney: true, supersedes: [], effectiveFrom, retroactive: false, notes: null }],
    });
    const [q] = checks.requiredDecisions(rulebook({ study: study(null) }));
    expect(q).toMatchObject({ id: "rule:effective:Amend1.pdf", about: { target: "study", id: "Amend1.pdf" }, source: { doc: "Amend1.pdf", page: 1, quote: "" } });
    expect(q!.options.every((o) => o.patches.length === 0)).toBe(true);
    expect(checks.requiredDecisions(rulebook({ study: study("2026-01-01") }))).toEqual([]);
  });

  it("asks nothing when nothing is unclear", () => {
    expect(checks.requiredDecisions(rulebook({ terms: [term({})] }))).toEqual([]);
  });
});

describe("runChecks", () => {
  it("collects grid, quote, image-page and unaccounted problems", () => {
    const docs = [doc("A.pdf", page(1, "text", "Fee $100.00\nStray $9.99"), page(2, "image", ""))];
    const rb = rulebook({
      terms: [
        term({ id: "ok", amountCents: 10000, source: { doc: "A.pdf", page: 1, quote: "Fee $100.00" } }),
        term({ id: "bad", source: { doc: "A.pdf", page: 1, quote: "nowhere" } }),
        term({ id: "scan", amountCents: 500, source: { doc: "A.pdf", page: 2, quote: "q" } }),
        term({ id: "scan-math", amountCents: 500, evidence: "math", source: { doc: "A.pdf", page: 2, quote: "q" } }),
      ],
      grids: [cbt({ doc: "A.pdf" })],
    });
    rb.grids[0]!.rows[0]!.cells[0] = 1;
    const r = checks.runChecks(rb, docs);
    expect(Object.keys(r.quotes)).toEqual(["bad", "scan"]);
    expect(r.quotes.scan).toMatch(/^scanned page/);
    expect(r.unaccounted.map((u) => u.amountCents)).toEqual([999]);
    expect(r.grids.g1!.problems.length).toBeGreaterThan(0);
    expect(r.problems.map((p) => p.check).sort()).toEqual(["grid", "grid", "quote", "quote", "unaccounted"]);
  });

  it("reports unproven cells as a problem when nothing else is wrong", () => {
    const partly = grid({
      rows: [
        { name: "Fee", code: null, unitCostCents: null, cells: [100, 200], printedRowTotalCents: 300 },
        { name: "Other", code: null, unitCostCents: null, cells: [400, 500], printedRowTotalCents: null },
      ],
    });
    const r = checks.runChecks(rulebook({ grids: [partly] }), [doc("A.pdf", page(1, "text", ""))]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ check: "grid", id: "g1" });
  });
});
