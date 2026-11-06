import { describe, expect, it } from "vitest";
import type { Rulebook } from "@dct/shared";
import { checks } from "../src/checks";
import { checkCitations } from "../src/checks/cells";
import { cellKey, checkRelations, withRelationProof } from "../src/checks/relations";
import { withScans } from "../src/scan";
import { parseTranscription } from "../src/scan/transcribe";
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

describe("checkCitations", () => {
  const scanned = (...pages: string[]): LoadedDoc =>
    withScans(
      doc("A.pdf", ...pages.map((_, i) => page(i + 1, "image", ""))),
      pages.map((text, i) => ({ page: i + 1, version: "v", rotation: 0, transcription: parseTranscription({ rotation: 0, text }) })),
    );
  const fees = scanned(
    [
      "T 0.3-0.6 | Fees",
      "H | Item | Fee | Fee with overhead",
      "R 0.31-0.32 | Exam | $100.00 | $130.00",
      "R 0.33-0.34 | Labs | $900.00{x} $1,050.00{hw} | $1,365.00",
      "R 0.35-0.36 | Visit fee | $100.00 | $130.00",
      "R 0.37-0.38 | Bundle | $100.00 $130.00 |",
      "R 0.39-0.40 | Per visit | $1,500.00 per visit |",
      "L 0.7-0.72 | Startup fee $2,000.00 payable on signature{in}",
      "L 0.8-0.82 | Closeout fee $500.00, at most $5,000.00 a year",
    ].join("\n"),
    "L 0.1-0.12 | Exam $100.00",
  );
  const cited = (cents: number, cell?: string, quote = "Exam", over: Partial<Term> = {}) =>
    term({ amountCents: cents, evidence: "none", source: { doc: "A.pdf", page: 1, quote, ...(cell && { cell }) }, ...over });
  const citations = (over: Partial<Rulebook>, docs = [fees]) => checkCitations(rulebook(over), docs);
  const messages = (over: Partial<Rulebook>, docs = [fees]) => citations(over, docs).problems.map((p) => p.message);

  it("passes a term whose amount is the one its cell prints, in a table or a line", () => {
    expect(citations({ terms: [cited(10000, "p1.t1.r1.c1"), cited(13000, "p1.t1.r1.c2", "Exam", { id: "t2" }), cited(50000, "p1.l2", "Closeout fee", { id: "t3" })] })).toEqual({ problems: [], marked: [] });
  });

  it("refuses an amount its cited cell doesn't print, a missing citation and an unknown id, in plain words", () => {
    const { problems } = citations({ terms: [cited(10100, "p1.t1.r1.c1"), cited(10000, undefined, "Exam", { id: "t2" }), cited(10000, "p1.t1.r9.c1", "Exam", { id: "t3" })] });
    expect(problems).toEqual([
      { check: "cell", id: "t1", doc: "A.pdf", page: 1, message: 'the amount is $101.00, but cell p1.t1.r1.c1 prints "$100.00": write the amount as the cited cell prints it, or cite the cell it is printed in.' },
      { check: "cell", id: "t2", doc: "A.pdf", page: 1, message: "the amount is on a scanned page, so it has to cite the cell or line it is printed in (source.cell), with its id as read_pages shows it, e.g. p7.t1.r5.c3." },
      { check: "cell", id: "t3", doc: "A.pdf", page: 1, message: "the amount cites p1.t1.r9.c1, but A.pdf has no cell or line with that id: copy the id as read_pages shows it." },
    ]);
  });

  it("takes either amount of a struck cell with its handwritten replacement, and always reports the cell as marked", () => {
    const { problems, marked } = citations({ terms: [cited(105000, "p1.t1.r2.c1", "Labs"), cited(90000, "p1.t1.r2.c1", "Labs", { id: "t2" }), cited(200000, "p1.l1", "Startup fee", { id: "t3" })] });
    expect(problems).toEqual([]);
    expect(marked).toEqual([
      { target: "term", id: "t1", path: "amountCents", cell: "p1.t1.r2.c1", doubts: ["struck_out", "handwritten"] },
      { target: "term", id: "t2", path: "amountCents", cell: "p1.t1.r2.c1", doubts: ["struck_out", "handwritten"] },
      { target: "term", id: "t3", path: "amountCents", cell: "p1.l1", doubts: ["initialed"] },
    ]);
    expect(citations({ terms: [cited(100000, "p1.t1.r2.c1", "Labs")] }).problems).toHaveLength(1);
  });

  it("an unmarked table cell has to print just the amount", () => {
    expect(messages({ terms: [cited(10000, "p1.t1.r4.c1", "Bundle")] })).toEqual([
      'the amount is $100.00, but cell p1.t1.r4.c1 prints "$100.00 $130.00": write the amount as the cited cell prints it, or cite the cell it is printed in.',
    ]);
  });

  it("a cell printing one amount with words can be cited", () => {
    expect(messages({ terms: [cited(150000, "p1.t1.r5.c1", "Per visit")] })).toEqual([]);
    expect(messages({ terms: [cited(15000, "p1.t1.r5.c1", "Per visit")] })).toHaveLength(1);
  });

  it("a term citing another row that prints the same amount is refused", () => {
    expect(messages({ terms: [cited(10000, "p1.t1.r3.c1")] })).toEqual([
      `the amount cites p1.t1.r3.c1, but the quote "Exam" is not on that row ("Visit fee $100.00 $130.00"): cite the cell on the row the quote is from, and quote that row's own words.`,
    ]);
    expect(messages({ terms: [cited(50000, "p1.l2", "Startup fee")] })[0]).toMatch(/^the amount cites p1\.l2, but the quote "Startup fee" is not on that line/);
  });

  it("a scanned cap value must equal its cited cell", () => {
    const capped = (value: number, capCell?: string, evidence: Term["evidence"] = "none") =>
      cited(50000, "p1.l2", "Closeout fee", { evidence, cap: { kind: "amount", value, period: "year", text: "" }, source: { doc: "A.pdf", page: 1, quote: "Closeout fee", cell: "p1.l2", ...(capCell && { capCell }) } });
    expect(messages({ terms: [capped(500000, "p1.l2")] })).toEqual([]);
    expect(messages({ terms: [capped(600000, "p1.l2")] })).toEqual([
      "the cap is $6,000.00, but cell p1.l2 prints \"Closeout fee $500.00, at most $5,000.00 a year\": write the amount as the cited cell prints it, or cite the cell it is printed in.",
    ]);
    expect(messages({ terms: [capped(500000)] })[0]).toMatch(/^the cap is on a scanned page, so it has to cite .*\(source\.capCell\)/);
    expect(messages({ terms: [capped(600000, undefined, "person")] })).toEqual([]);
    const elsewhere = cited(50000, "p1.l2", "Closeout fee", { cap: { kind: "amount", value: 10000, period: null, text: "" }, source: { doc: "A.pdf", page: 1, quote: "Closeout fee", cell: "p1.l2", capCell: "p2.l1" } });
    expect(messages({ terms: [elsewhere] })).toEqual([]);
  });

  it("a citation must be on the term's page, or one of the grid's pages", () => {
    expect(messages({ terms: [cited(10000, "p2.l1")] })).toEqual(["the amount cites p2.l1, which is on p.2: cite a cell on p.1, the term's page."]);
    const onPage2 = grid({ rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, null], printedRowTotalCents: null }], cellIds: { "rows.0.cells.0": "p2.l1" } });
    expect(messages({ grids: [onPage2] })).toEqual(["row 'Exam' at visit 'V1' cites p2.l1, which is on p.2: cite a cell on the grid's pages (1)."]);
  });

  it("lets a person's decision stand without a citation, but still checks one that is given", () => {
    expect(citations({ terms: [cited(77700, undefined, "Exam", { evidence: "person" })] }).problems).toEqual([]);
    expect(citations({ terms: [cited(77700, "p1.t1.r1.c1", "Exam", { evidence: "person" })] }).problems).toHaveLength(1);
  });

  it("needs no citation on a text page, or for a term with no amount", () => {
    const text = doc("A.pdf", page(1, "text", "Exam $100.00"));
    expect(citations({ terms: [cited(10000)] }, [text]).problems).toEqual([]);
    expect(citations({ terms: [term({ source: { doc: "A.pdf", page: 1, quote: "Exam" } })] }).problems).toEqual([]);
  });

  const exam = (cellIds: Record<string, string | null>, over: Partial<Grid> = {}) =>
    grid({ rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, null], printedRowTotalCents: 10000 }], grandTotalCents: 10000, cellIds, ...over });

  it("checks every amount of a grid on a scanned page against its cell, naming the place", () => {
    expect(citations({ grids: [exam({ "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.printedRowTotalCents": "p1.t1.r1.c1", grandTotalCents: "p1.t1.r1.c1" })] }).problems).toEqual([]);
    expect(messages({ grids: [exam({ "rows.0.cells.0": "p1.t1.r1.c2", grandTotalCents: "p1.t1.r1.c1" })] })).toEqual([
      `row 'Exam' at visit 'V1' is $100.00, but cell p1.t1.r1.c2 prints "$130.00": write the amount as the cited cell prints it, or cite the cell it is printed in.`,
      "the printed total of row 'Exam' is on a scanned page, so it has to cite the cell or line it is printed in (write it as {value, cell}), with its id as read_pages shows it, e.g. p7.t1.r5.c3.",
    ]);
  });

  it("a grid row citing cells from two different printed rows is refused", () => {
    const g = grid({ rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, 13000], printedRowTotalCents: null }], cellIds: { "rows.0.cells.0": "p1.t1.r3.c1", "rows.0.cells.1": "p1.t1.r1.c2" } });
    expect(messages({ grids: [g] })).toEqual([
      "row 'Exam' cites cells of different printed rows of table p1.t1 (p1.t1.r3, p1.t1.r1): in each printed table, every amount of one row comes from one printed row, and every amount of one visit from one printed column (or the other way round in a table printed sideways).",
    ]);
  });

  const layout = (...lines: string[]) => scanned(lines.join("\n"));
  const row = (name: string, cells: (number | null)[]) => ({ name, code: null, unitCostCents: null, cells, printedRowTotalCents: null });

  it("two grid rows with the same name cite their own printed rows", () => {
    const page1 = layout("T 0.1-0.5 | Budget", "H | Item | V1 | V2", "R 0.11-0.12 | Exam | $100.00 |", "R 0.13-0.14 | Exam | | $120.00");
    const g = grid({ rows: [row("Exam", [10000, null]), row("Exam", [null, 12000])], cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.1.cells.1": "p1.t1.r2.c2" } });
    expect(messages({ grids: [g] }, [page1])).toEqual([]);
  });

  it("a budget printed as two stacked tables on one page is accepted", () => {
    const page1 = layout("T 0.1-0.3 | Budget", "H | Item | V1 | V2", "R 0.11-0.12 | Exam | $100.00 | $200.00", "T 0.4-0.6 | Budget (continued)", "H | Item | V3 | V4", "R 0.41-0.42 | Exam | $300.00 | $400.00");
    const g = grid({
      visits: ["V1", "V2", "V3", "V4"], rows: [row("Exam", [10000, 20000, 30000, 40000])],
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.cells.1": "p1.t1.r1.c2", "rows.0.cells.2": "p1.t2.r1.c1", "rows.0.cells.3": "p1.t2.r1.c2" },
    });
    expect(messages({ grids: [g] }, [page1])).toEqual([]);
  });

  it("a transposed budget table is accepted", () => {
    const page1 = layout("T 0.1-0.5 | Budget", "H | Visit | Exam | Labs", "R 0.11-0.12 | V1 | $100.00 | $50.00", "R 0.13-0.14 | V2 | $250.00 | $50.00");
    const g = grid({
      rows: [row("Exam", [10000, 25000]), row("Labs", [5000, 5000])],
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.cells.1": "p1.t1.r2.c1", "rows.1.cells.0": "p1.t1.r1.c2", "rows.1.cells.1": "p1.t1.r2.c2" },
    });
    expect(messages({ grids: [g] }, [page1])).toEqual([]);
  });

  it("a visit citing cells from two different printed columns is refused", () => {
    const g = grid({
      rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, null], printedRowTotalCents: null }, { name: "Visit fee", code: null, unitCostCents: null, cells: [13000, null], printedRowTotalCents: null }],
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.1.cells.0": "p1.t1.r3.c2" },
    });
    expect(messages({ grids: [g] })).toEqual([
      "visit 'V1' cites cells of different printed columns of table p1.t1 (p1.t1.c1, p1.t1.c2): in each printed table, every amount of one row comes from one printed row, and every amount of one visit from one printed column (or the other way round in a table printed sideways).",
    ]);
  });

  it("a grid value a person settled may drop its citation, or have it cleared", () => {
    expect(citations({ grids: [exam({ "rows.0.printedRowTotalCents": "p1.t1.r1.c1", grandTotalCents: "p1.t1.r1.c1" }, { cellsReadTwice: [[0, 0]] })] }).problems).toEqual([]);
    expect(citations({ grids: [exam({ "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.printedRowTotalCents": null, grandTotalCents: null })] }).problems).toEqual([]);
  });

  it("listing a text page in a scanned grid doesn't excuse its scanned values from citing", () => {
    const mixed = doc("A.pdf", fees.pages[0]!, page(2, "text", "Exam $100.00"));
    expect(citations({ grids: [exam({}, { pages: [1, 2] })] }, [mixed]).problems).toEqual([]);
    const scannedToo = exam({}, { pages: [1, 2], rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [10000, 13000], printedRowTotalCents: 10000 }] });
    expect(messages({ grids: [scannedToo] }, [mixed])).toEqual([
      "row 'Exam' at visit 'V2' is on a scanned page, so it has to cite the cell or line it is printed in (write it as {value, cell}), with its id as read_pages shows it, e.g. p7.t1.r5.c3.",
    ]);
    expect(citations({ grids: [exam({ "rows.0.cells.0": "p1.t1.r1.c2" }, { pages: [1, 2] })] }, [mixed]).problems).toHaveLength(1);
  });

  it("reports a marked cell a grid cites", () => {
    const g = exam({ "rows.0.cells.0": "p1.t1.r1.c1", "rows.0.printedRowTotalCents": "p1.t1.r1.c1", grandTotalCents: "p1.t1.r1.c1", "rows.1.cells.0": "p1.t1.r2.c1" });
    g.rows.push({ name: "Labs", code: null, unitCostCents: null, cells: [105000, null], printedRowTotalCents: null });
    expect(citations({ grids: [g] }).marked).toEqual([{ target: "grid", id: "g1", path: "rows.1.cells.0", cell: "p1.t1.r2.c1", doubts: ["struck_out", "handwritten"] }]);
  });

  it("goes into runChecks", () => {
    expect(checks.runChecks(rulebook({ terms: [cited(10100, "p1.t1.r1.c1", "Exam", { evidence: "person" })] }), [fees]).problems.map((p) => p.check)).toContain("cell");
  });
});

describe("relations", () => {
  type Relation = NonNullable<Rulebook["relations"]>[number];
  const scanned = (...texts: string[]): LoadedDoc =>
    withScans(
      doc("A.pdf", ...texts.map((_, i) => page(i + 1, "image", ""))),
      texts.map((text, i) => ({ page: i + 1, version: "v", rotation: 0, transcription: parseTranscription({ rotation: 0, text }) })),
    );
  const fees = scanned(
    [
      "L 0.1-0.12 | Institutional overhead of 30% is added to every fee",
      "T 0.3-0.6 | Fees",
      "H | Item | Fee | Fee with overhead",
      "R 0.31-0.32 | Exam | $100.00 | $130.00",
      "R 0.33-0.34 | Visit | $123.45 | $160.49",
      "R 0.35-0.36 | Labs | $1,050.00 | $1,370.00",
      "R 0.37-0.38 | Recheck | $900.00{hw} | $1,170.00",
      "L 0.7-0.72 | Exam fee $100.00 per visit",
    ].join("\n"),
  );
  const procedures = scanned(["T 0.3-0.6 | Procedures", "H | Item | Unit | Qty | Total", "R 0.31-0.32 | ECG | $150.00 | 8.00 | $1,200.00", "R 0.33-0.34 | Exam | $100.00 | | $100.00"].join("\n"));
  const rel = (over: Partial<Relation>): Relation => ({ kind: "sum", doc: "A.pdf", result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], ...over });
  const cited = (id: string, cents: number, cell: string, quote: string) => term({ id, amountCents: cents, evidence: "none", source: { doc: "A.pdf", page: 1, quote, cell } });
  const proven = (relations: Relation[], docs: LoadedDoc[], over: Partial<Rulebook> = {}) => [...checkRelations(rulebook({ relations, ...over }), docs).proven].sort();
  const problems = (relations: Relation[], docs: LoadedDoc[], over: Partial<Rulebook> = {}) => checkRelations(rulebook({ relations, ...over }), docs).problems.map((p) => p.message);
  const keys = (...ids: string[]) => ids.map((id) => cellKey("A.pdf", id)).sort();

  it("fee and fee-with-overhead cells are proven by a cited overhead rate", () => {
    const exam = cited("exam", 10000, "p1.t1.r1.c1", "Exam");
    const overhead = rel({ rate: "p1.l1" });
    expect(proven([overhead], [fees])).toEqual(keys("p1.t1.r1.c1", "p1.t1.r1.c2", "p1.l1"));
    expect(problems([overhead], [fees])).toEqual([]);
    // $123.45 plus 30% is $160.485: rounding to the printed cent holds
    expect(proven([rel({ result: "p1.t1.r2.c2", operands: ["p1.t1.r2.c1"], rate: "p1.l1" })], [fees])).toEqual(keys("p1.t1.r2.c1", "p1.t1.r2.c2", "p1.l1"));

    const rb = withRelationProof(rulebook({ terms: [exam, cited("visit", 12345, "p1.t1.r2.c1", "Visit")], relations: [overhead] }), [fees]);
    expect(rb.terms.map((t) => t.evidence)).toEqual(["math", "none"]);
    const report = checks.runChecks(rb, [fees]);
    expect(report.quotes.exam).toBeUndefined();
    expect(report.quotes.visit).toMatch(/^scanned page/);
  });

  it("a relation that doesn't hold proves nothing and goes back to the agent", () => {
    const labs = rel({ result: "p1.t1.r3.c2", operands: ["p1.t1.r3.c1"], rate: "p1.l1" });
    expect(proven([labs], [fees])).toEqual([]);
    expect(problems([labs], [fees])).toEqual(["p1.t1.r3.c2 = p1.t1.r3.c1 plus p1.l1 on top doesn't hold: the cells it is made of come to $1,365.00, but p1.t1.r3.c2 prints $1,370.00."]);
    const rb = withRelationProof(rulebook({ terms: [cited("labs", 105000, "p1.t1.r3.c1", "Labs")], relations: [labs] }), [fees]);
    expect(rb.terms[0]!.evidence).toBe("none");
  });

  it("a marked cell is left to a person, never proven by arithmetic", () => {
    expect(proven([rel({ result: "p1.t1.r4.c2", operands: ["p1.t1.r4.c1"], rate: "p1.l1" })], [fees])).toEqual([]);
  });

  it("unit × quantity = total proves all three", () => {
    const ecg = rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "p1.t1.r1.c2" });
    expect(proven([ecg], [procedures])).toEqual(keys("p1.t1.r1.c1", "p1.t1.r1.c2", "p1.t1.r1.c3"));
    expect(problems([ecg], [procedures])).toEqual([]);

    // a grid cell citing a proven cell needs no second read
    const g = grid({
      rows: [
        { name: "ECG", code: null, unitCostCents: null, cells: [15000, null], printedRowTotalCents: null },
        { name: "Exam", code: null, unitCostCents: null, cells: [10000, null], printedRowTotalCents: 10000 },
      ],
      cellIds: { "rows.0.cells.0": "p1.t1.r1.c1", "rows.1.cells.0": "p1.t1.r2.c1", "rows.1.printedRowTotalCents": "p1.t1.r2.c3" },
    });
    expect(checks.runChecks(rulebook({ grids: [g] }), [procedures]).grids.g1!.unproven).toEqual([{ row: 0, col: 0 }]);
    const report = checks.runChecks(rulebook({ grids: [g], relations: [ecg] }), [procedures]);
    expect(report.grids.g1!.unproven).toEqual([]);
    expect(report.problems.filter((p) => p.check !== "unaccounted")).toEqual([]);
  });

  it("a relation over a typed number proves nothing", () => {
    const typed = [
      rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "8" }),
      rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["$150.00"], rate: "p1.t1.r1.c2" }),
      rel({ kind: "sum", result: "$1,200.00", operands: ["p1.t1.r1.c1", "p1.t1.r1.c1"] }),
    ];
    expect(proven(typed, [procedures])).toEqual([]);
    expect(problems(typed, [procedures])).toEqual([
      "p1.t1.r1.c3 = p1.t1.r1.c1 × 8: A.pdf has no cell or line called 8. A relation is made of cell ids as read_pages shows them, never typed numbers.",
      "p1.t1.r1.c3 = $150.00 × p1.t1.r1.c2: A.pdf has no cell or line called $150.00. A relation is made of cell ids as read_pages shows them, never typed numbers.",
      "$1,200.00 = p1.t1.r1.c1 + p1.t1.r1.c1: A.pdf has no cell or line called $1,200.00. A relation is made of cell ids as read_pages shows them, never typed numbers.",
    ]);
  });

  it("a product by 1, or a sum that adds nothing, is not arithmetic", () => {
    const one = scanned(["T 0.3-0.6 | Fees", "H | Item | Fee | Qty | Total | Extra", "R 0.31-0.32 | Exam | $100.00 | 1 | $100.00 | $0.00"].join("\n"));
    expect(proven([rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "p1.t1.r1.c2" })], [one])).toEqual([]);
    expect(proven([rel({ result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1", "p1.t1.r1.c4"] })], [one])).toEqual([]);
  });

  it("'same' over one cell twice proves nothing", () => {
    const exam = cited("exam", 10000, "p1.t1.r1.c1", "Exam");
    expect(proven([rel({ kind: "same", result: "p1.t1.r1.c1", operands: ["p1.t1.r1.c1"] })], [fees], { terms: [exam] })).toEqual([]);
    expect(problems([rel({ kind: "same", result: "p1.t1.r1.c1", operands: ["p1.t1.r1.c1"] })], [fees], { terms: [exam] })).toEqual([
      "p1.t1.r1.c1 = p1.t1.r1.c1: a relation needs different cells; 'same' is for one fee printed in two different places.",
    ]);
  });

  const exam = cited("exam", 10000, "p1.t1.r1.c1", "Exam");
  const twoPages = scanned(["T 0.3-0.6 | Fees", "H | Item | Fee", "R 0.31-0.32 | Exam | $100.00", "L 0.7-0.72 | Exam fee $100.00 per visit"].join("\n"), "L 0.1-0.12 | Exam fee $100.00 per visit");

  it("same on one page proves nothing; on two pages it proves both", () => {
    const onePage = rel({ kind: "same", result: "p1.t1.r1.c1", operands: ["p1.l1"] });
    expect(proven([onePage], [twoPages], { terms: [exam] })).toEqual([]);
    expect(problems([onePage], [twoPages], { terms: [exam] })).toEqual([
      "p1.t1.r1.c1 = p1.l1: both cells are on p.1, which was read in one go, so one misread could repeat in both: 'same' proves only one value printed on two different pages.",
    ]);
    expect(proven([rel({ kind: "same", result: "p1.t1.r1.c1", operands: ["p2.l1"] })], [twoPages], { terms: [exam] })).toEqual(keys("p1.t1.r1.c1", "p2.l1"));
  });

  it("'same' never proves two different values that print one amount", () => {
    const twice = rel({ kind: "same", result: "p1.t1.r1.c1", operands: ["p2.l1"] });
    const fee = term({ id: "fee", amountCents: 10000, evidence: "none", source: { doc: "A.pdf", page: 2, quote: "Exam fee", cell: "p2.l1" } });
    const both = { terms: [exam, fee] };
    expect(proven([twice], [twoPages], both)).toEqual([]);
    expect(problems([twice], [twoPages], both)).toEqual([
      "p1.t1.r1.c1 = p2.l1: these cells are cited by different rulebook values (term exam, term fee); 'same' only shows one value printed twice.",
    ]);
    expect(problems([twice], [twoPages])).toEqual(["p1.t1.r1.c1 = p2.l1: no rulebook value cites either cell; 'same' proves the one value that cites one of them, so write that first."]);
  });

  it("a cents misread doesn't pass a percent relation", () => {
    const misread = scanned(
      ["L 0.1-0.12 | Overhead of 30% is added to every fee", "T 0.3-0.6 | Fees", "H | Item | Fee | Fee with overhead", "R 0.31-0.32 | Visit | $123.75 | $160.49", "R 0.33-0.34 | Exam | $123.45 | $160.00", "R 0.35-0.36 | Labs | $123.75 | $160.00"].join("\n"),
    );
    const row = (r: number) => rel({ result: `p1.t1.r${r}.c2`, operands: [`p1.t1.r${r}.c1`], rate: "p1.l1" });
    expect(proven([row(1)], [misread])).toEqual([]);
    expect(problems([row(1)], [misread])).toEqual(["p1.t1.r1.c2 = p1.t1.r1.c1 plus p1.l1 on top doesn't hold: the cells it is made of come to $160.88, but p1.t1.r1.c2 prints $160.49."]);
    // $160.485 printed in whole dollars holds, but a fee a few cents off would round to the same dollar, so the fee isn't proven
    expect(proven([row(2)], [misread])).toEqual(keys("p1.t1.r2.c2", "p1.l1"));
    expect(proven([row(3)], [misread])).toEqual([]);
  });

  it("a zero rate proves nothing", () => {
    const zero = scanned(["T 0.3-0.6 | Fees", "H | Item | Fee | Qty | Total", "R 0.31-0.32 | Visit | $123.75 | 0 | $0.00", "R 0.33-0.34 | Exam | $100.00 | 0% | $50.00"].join("\n"));
    const zeroed = [
      rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "p1.t1.r1.c2" }),
      rel({ kind: "product", result: "p1.t1.r2.c3", operands: ["p1.t1.r2.c1"], rate: "p1.t1.r2.c2" }),
    ];
    expect(proven(zeroed, [zero])).toEqual([]);
    expect(problems(zeroed, [zero])).toEqual([
      "p1.t1.r1.c3 = p1.t1.r1.c1 × p1.t1.r1.c2: p1.t1.r1.c3 prints $0.00, and a zero total proves nothing.",
      "p1.t1.r2.c3 = p1.t1.r2.c1 × p1.t1.r2.c2: p1.t1.r2.c2 prints \"0%\", and a rate has to be above zero.",
    ]);
  });

  it("a sum over cells from different columns proves nothing", () => {
    const lab = scanned(
      ["T 0.3-0.6 | Fees", "H | Item | Fee | Fee with overhead | Extra | Total", "R 0.31-0.32 | Lab | Invoice | $1,500.00 | $150.00 | $1,650.00", "R 0.33-0.34 | Visit | $1.00 | $2.00 | $1,500.00 | $3.00"].join("\n"),
      "L 0.1-0.12 | Total $3.00",
    );
    const across = [
      rel({ result: "p1.t1.r1.c4", operands: ["p1.t1.r1.c2", "p1.t1.r2.c3"] }),
      rel({ result: "p2.l1", operands: ["p1.t1.r2.c1", "p1.t1.r2.c2"] }),
      // unrelated cells of one row that happen to add up, the "total" printed before them
      rel({ result: "p1.t1.r1.c1", operands: ["p1.t1.r1.c2", "p1.t1.r1.c3"] }),
    ];
    const ALIGNED = "the result and the cells it is made of have to be in one printed row or one printed column of one table, with the result after them (a row total, a column total, or a fee followed by the fee with overhead).";
    expect(proven(across, [lab])).toEqual([]);
    expect(problems(across, [lab])).toEqual([`p1.t1.r1.c4 = p1.t1.r1.c2 + p1.t1.r2.c3: ${ALIGNED}`, `p2.l1 = p1.t1.r2.c1 + p1.t1.r2.c2: ${ALIGNED}`, `p1.t1.r1.c1 = p1.t1.r1.c2 + p1.t1.r1.c3: ${ALIGNED}`]);
    // along one printed row it is a row total, and every cell in it is proven
    expect(proven([rel({ result: "p1.t1.r1.c4", operands: ["p1.t1.r1.c2", "p1.t1.r1.c3"] })], [lab])).toEqual(keys("p1.t1.r1.c4", "p1.t1.r1.c2", "p1.t1.r1.c3"));
  });

  it("×30% proves the overhead cell, not the fee", () => {
    const overhead = scanned(["L 0.1-0.12 | Overhead is 30% of the subtotal", "T 0.3-0.6 | Budget", "H | Item | Subtotal | Overhead", "R 0.31-0.32 | Visit | $1,000.00 | $300.00"].join("\n"), "L 0.1-0.12 | Overhead is 30%");
    expect(proven([rel({ kind: "product", result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], rate: "p1.l1" })], [overhead])).toEqual(keys("p1.t1.r1.c2", "p1.l1"));
    expect(problems([rel({ kind: "product", result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], rate: "p2.l1" })], [overhead])).toEqual([
      "p1.t1.r1.c2 = p1.t1.r1.c1 × p2.l1: the rate p2.l1 is on p.2: use one printed on p.1, the page of the result.",
    ]);
  });

  it("a sum can't use a count as its rate", () => {
    const count = scanned(["T 0.3-0.6 | Fees", "H | Item | Unit | Qty | Total", "R 0.31-0.32 | Scan | $100.00 | 2 | $300.00"].join("\n"));
    const r = rel({ result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "p1.t1.r1.c2" });
    expect(proven([r], [count])).toEqual([]);
    expect(problems([r], [count])).toEqual(['p1.t1.r1.c3 = p1.t1.r1.c1 plus p1.t1.r1.c2 on top: p1.t1.r1.c2 prints "2", not a percent: a sum adds a percent on top; for a quantity use a product.']);
  });

  it("a count from another row can't prove a product", () => {
    const rows = scanned(
      ["L 0.1-0.12 | Overhead is 25%", "T 0.3-0.6 | Fees", "H | Item | Unit | Qty | Total", "R 0.31-0.32 | Scan | $300.00 | 3 | $2,400.00", "R 0.33-0.34 | Other | $10.00 | 8 | $80.00", "R 0.35-0.36 | Lab | $80.00 | | $20.00"].join("\n"),
    );
    const borrowed = rel({ kind: "product", result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1"], rate: "p1.t1.r2.c2" });
    expect(proven([borrowed], [rows])).toEqual([]);
    expect(problems([borrowed], [rows])).toEqual(["p1.t1.r1.c3 = p1.t1.r1.c1 × p1.t1.r2.c2: the rate p1.t1.r2.c2 has to be printed in the result's own row (or its column, in a table printed sideways), in its column's heading, or in a line of text on the page."]);
    expect(proven([rel({ kind: "product", result: "p1.t1.r2.c3", operands: ["p1.t1.r2.c1"], rate: "p1.t1.r2.c2" })], [rows])).toEqual(keys("p1.t1.r2.c1", "p1.t1.r2.c2", "p1.t1.r2.c3"));
    // a percent may be printed anywhere on the result's page
    expect(proven([rel({ kind: "product", result: "p1.t1.r3.c3", operands: ["p1.t1.r3.c1"], rate: "p1.l1" })], [rows])).toEqual(keys("p1.t1.r3.c3", "p1.l1"));
  });

  it("a percent from another row of the table can't prove an amount", () => {
    const milestones = scanned(
      ["T 0.3-0.6 | Milestones", "H | Milestone | Percent | Amount (5% of the contract)", "R 0.31-0.32 | Contract value | | $10,000.00", "R 0.33-0.34 | Start-up | 10% | $1,000.00", "R 0.35-0.36 | Enrollment | 15% | $1,000.00", "R 0.37-0.38 | Closeout | | $500.00"].join("\n"),
    );
    const borrowed = rel({ kind: "product", result: "p1.t1.r3.c2", operands: ["p1.t1.r1.c2"], rate: "p1.t1.r2.c1" });
    expect(proven([borrowed], [milestones])).toEqual([]);
    expect(problems([borrowed], [milestones])).toEqual([
      "p1.t1.r3.c2 = p1.t1.r1.c2 × p1.t1.r2.c1: the rate p1.t1.r2.c1 has to be printed in the result's own row (or its column, in a table printed sideways), in its column's heading, or in a line of text on the page.",
    ]);
    expect(problems([rel({ kind: "product", result: "p1.t1.r3.c2", operands: ["p1.t1.r1.c2"], rate: "p1.t1.r3.c1" })], [milestones])[0]).toMatch(/doesn't hold: the cells it is made of come to \$1,500\.00/);
    expect(proven([rel({ kind: "product", result: "p1.t1.r2.c2", operands: ["p1.t1.r1.c2"], rate: "p1.t1.r2.c1" })], [milestones])).toEqual(keys("p1.t1.r2.c1", "p1.t1.r2.c2"));
    // the result's column heading prints its own rate
    expect(proven([rel({ kind: "product", result: "p1.t1.r4.c2", operands: ["p1.t1.r1.c2"], rate: "p1.t1.h2" })], [milestones])).toEqual(keys("p1.t1.h2", "p1.t1.r4.c2"));
  });

  it("a total must cover every amount before it in its row", () => {
    const rows = scanned(["T 0.3-0.6 | Fees", "H | Item | A | B | C | Total", "R 0.31-0.32 | ECG | $150.00 | $150.00 | $300.00 | $600.00", "R 0.33-0.34 | Lab | $150.00 | $300.00 | $150.00 | $450.00"].join("\n"));
    const partial = [rel({ result: "p1.t1.r1.c3", operands: ["p1.t1.r1.c1", "p1.t1.r1.c2"] }), rel({ result: "p1.t1.r2.c4", operands: ["p1.t1.r2.c2", "p1.t1.r2.c3"] })];
    const TOTAL = "a total has to add up every amount printed before it in its row or column, and be the last amount there; otherwise the cells may only happen to add up.";
    expect(proven(partial, [rows])).toEqual([]);
    expect(problems(partial, [rows])).toEqual([`p1.t1.r1.c3 = p1.t1.r1.c1 + p1.t1.r1.c2: ${TOTAL}`, `p1.t1.r2.c4 = p1.t1.r2.c2 + p1.t1.r2.c3: ${TOTAL}`]);
    expect(proven([rel({ result: "p1.t1.r1.c4", operands: ["p1.t1.r1.c1", "p1.t1.r1.c3", "p1.t1.r1.c2"] })], [rows])).toEqual(keys("p1.t1.r1.c1", "p1.t1.r1.c2", "p1.t1.r1.c3", "p1.t1.r1.c4"));
  });

  it("a whole-dollar table never proves an operand by a round cent match", () => {
    const rounding = scanned(["L 0.1-0.12 | Overhead of 30% is added to every fee", "T 0.3-0.6 | Fees", "H | Item | Fee | Fee with overhead", "R 0.31-0.32 | Fee | $100.00 | $130.00", "R 0.33-0.34 | Fee2 | $100.30 | $130.00"].join("\n"));
    const exact = rel({ result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], rate: "p1.l1" });
    const toTheDollar = rel({ result: "p1.t1.r2.c2", operands: ["p1.t1.r2.c1"], rate: "p1.l1" });
    expect(proven([exact], [rounding])).toEqual(keys("p1.t1.r1.c1", "p1.t1.r1.c2", "p1.l1"));
    expect(proven([exact, toTheDollar], [rounding])).toEqual(keys("p1.t1.r1.c2", "p1.t1.r2.c2", "p1.l1"));
  });

  it("a rate printed as .5 is read as 0.5 everywhere", () => {
    const half = scanned(["L 0.1-0.12 | Overhead of .5% is added to every fee", "T 0.3-0.6 | Fees", "H | Item | Fee | With overhead | Qty | Total", "R 0.31-0.32 | Visit | $1,000.00 | $1,005.00 | | ", "R 0.33-0.34 | Half | $100.00 | | .5 | $50.00"].join("\n"));
    expect(proven([rel({ result: "p1.t1.r1.c2", operands: ["p1.t1.r1.c1"], rate: "p1.l1" })], [half])).toEqual(keys("p1.t1.r1.c1", "p1.t1.r1.c2", "p1.l1"));
    expect(proven([rel({ kind: "product", result: "p1.t1.r2.c4", operands: ["p1.t1.r2.c1"], rate: "p1.t1.r2.c3" })], [half])).toEqual(keys("p1.t1.r2.c3", "p1.t1.r2.c4"));
  });
});
