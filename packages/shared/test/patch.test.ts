import { describe, expect, it } from "vitest";
import { applyPatches, cellProofPatches, citationPatches, isLockedField, type Patch, type Rulebook, type Term } from "../src/index.js";

const term: Term = {
  id: "t1", category: "site_fee", name: "Startup fee", amountCents: 100000, unit: null, billing: "auto_paid", trigger: null, cap: null,
  formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
  source: { doc: "A.pdf", page: 1, quote: "Startup fee" }, evidence: "quote", houseRuleIds: [], notes: null,
};

const rulebook: Rulebook = {
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [term],
  grids: [{
    id: "g1", name: "Budget", arm: null, doc: "A.pdf", pages: [1], visits: ["V1", "V2"], overheadPct: null,
    rows: [{ name: "Exam", code: null, unitCostCents: null, cells: [100, 200], printedRowTotalCents: 300 }],
    subtotal: [100, 200], overhead: null, additions: [], total: null, grandTotalCents: 300, cellsReadTwice: [], acceptedAsPrinted: false,
  }],
  accounted: [], questions: [],
};

const termPatch = (id: string, set: Record<string, unknown>): Patch => ({ target: "term", id, set });
const gridPatch = (set: Record<string, unknown>): Patch => ({ target: "grid", id: "g1", set });

describe("applyPatches", () => {
  it("sets fields on an existing term without touching the input", () => {
    const before = structuredClone(rulebook);
    const next = applyPatches(rulebook, [termPatch("t1", { amountCents: 150000, evidence: "two_reads" })]);
    expect(next.terms[0]).toMatchObject({ amountCents: 150000, evidence: "two_reads", name: "Startup fee" });
    expect(rulebook).toEqual(before);
  });

  it("creates a term that doesn't exist when the patch is a complete term", () => {
    const { id: _id, ...whole } = term;
    const next = applyPatches(rulebook, [termPatch("t2", { ...whole, name: "Archive fee" })]);
    expect(next.terms.map((t) => [t.id, t.name])).toEqual([["t1", "Startup fee"], ["t2", "Archive fee"]]);
  });

  it("creates a term with no proof when the patch gives none", () => {
    const { id: _id, evidence: _evidence, ...whole } = term;
    expect(applyPatches(rulebook, [termPatch("t2", whole)]).terms[1]!.evidence).toBe("none");
  });

  it("refuses to create a term from a partial patch, and says what is missing", () => {
    expect(() => applyPatches(rulebook, [termPatch("t2", { name: "Archive fee" })])).toThrow(/Term 't2' doesn't exist yet.*category/);
  });

  it("refuses to add a term again over one that already exists", () => {
    expect(() => applyPatches(rulebook, [termPatch("t1", { ...term, name: "Other" })])).toThrow(/already exists/);
  });

  it.each([null, "p.1"])("refuses a source of %s in plain words", (source) => {
    expect(() => applyPatches(rulebook, [termPatch("t1", { source })])).toThrow("That answer would leave the term without a page to point to, so it wasn't applied.");
  });

  it("refuses a field a term doesn't have", () => {
    expect(() => applyPatches(rulebook, [termPatch("t1", { amount: 5 })])).toThrow("A term has no field called 'amount'");
  });

  it("sets grid cells, printed lines, the grand total and cellsReadTwice by dotted path", () => {
    const next = applyPatches(rulebook, [gridPatch({ "rows.0.cells.1": 250, "subtotal.1": 250, grandTotalCents: 350, cellsReadTwice: [[0, 1]] })]);
    expect(next.grids[0]).toMatchObject({ rows: [{ cells: [100, 250] }], subtotal: [100, 250], grandTotalCents: 350, cellsReadTwice: [[0, 1]] });
    expect(rulebook.grids[0]!.rows[0]!.cells).toEqual([100, 200]);
  });

  it("sets acceptedAsPrinted on a grid stored before the field existed", () => {
    const old = structuredClone(rulebook);
    delete (old.grids[0] as Partial<Rulebook["grids"][number]>).acceptedAsPrinted;
    expect(applyPatches(old, [gridPatch({ acceptedAsPrinted: true })]).grids[0]!.acceptedAsPrinted).toBe(true);
  });

  it("lists the cells a patch sets as proven, adding to the ones already proven", () => {
    const proven = { ...rulebook, grids: [{ ...rulebook.grids[0]!, cellsReadTwice: [[0, 0]] as [number, number][] }] };
    const patches = [gridPatch({ "rows.0.cells.1": 250 }), gridPatch({ "subtotal.1": 250 }), termPatch("t1", { amountCents: 1 })];
    expect(cellProofPatches(proven, patches)).toEqual([gridPatch({ cellsReadTwice: [[0, 0], [0, 1]] })]);
    expect(cellProofPatches(rulebook, [gridPatch({ "rows.0.cells.1": 250 })])).toEqual([gridPatch({ cellsReadTwice: [[0, 1]] })]);
  });

  it("applies several patches in order", () => {
    const next = applyPatches(rulebook, [gridPatch({ "rows.0.cells.0": 1 }), gridPatch({ "rows.0.cells.0": 2 })]);
    expect(next.grids[0]!.rows[0]!.cells[0]).toBe(2);
  });

  it.each(["rows.3.cells.0", "rows.0.cells.2", "overhead.0", "rows.0.cells.length", "nothing", "__proto__.x"])("rejects the path %s, which isn't in the grid", (path) => {
    expect(() => applyPatches(rulebook, [gridPatch({ [path]: 1 })])).toThrow(`Grid 'g1' has no place called '${path}'`);
  });

  it("rejects an unknown grid", () => {
    expect(() => applyPatches(rulebook, [{ target: "grid", id: "nope", set: {} }])).toThrow("There is no grid 'nope'");
  });

  it("rejects a result that isn't a valid rulebook", () => {
    expect(() => applyPatches(rulebook, [termPatch("t1", { amountCents: 1.5 })])).toThrow(/would leave the rulebook invalid: terms\.0\.amountCents/);
  });
});

describe("a scanned value's citation", () => {
  it("of a term is set, re-pointed and cleared only by source.cell and source.capCell; a new source keeps them", () => {
    const cited = applyPatches(rulebook, [termPatch("t1", { "source.cell": "p1.t1.r1.c1", "source.capCell": "p1.l2" })]);
    expect(cited.terms[0]!.source).toEqual({ ...term.source, cell: "p1.t1.r1.c1", capCell: "p1.l2" });
    const quoted = applyPatches(cited, [termPatch("t1", { source: { ...term.source, quote: "Startup", cell: "p9.l1" } })]);
    expect(quoted.terms[0]!.source).toEqual({ ...term.source, quote: "Startup", cell: "p1.t1.r1.c1", capCell: "p1.l2" });
    expect(applyPatches(cited, [termPatch("t1", { "source.cell": "p1.t1.r1.c2", "source.capCell": null })]).terms[0]!.source).toEqual({ ...term.source, cell: "p1.t1.r1.c2" });
  });

  it("is a locked field, so an option an agent or the reviewer writes can't set or clear it", () => {
    expect(["source.cell", "source.capCell", "cellIds", "cellIds.rows.0.cells.1"].filter(isLockedField)).toHaveLength(4);
    expect(["source", "amountCents", "rows.0.cells.1"].filter(isLockedField)).toEqual([]);
  });

  it("of a grid value is set, re-pointed and cleared at the value's path under cellIds", () => {
    const cited = applyPatches(rulebook, [gridPatch({ "cellIds.rows.0.cells.1": "p1.t1.r1.c2", "cellIds.grandTotalCents": "p1.t1.r3.c1" })]);
    expect(cited.grids[0]!.cellIds).toEqual({ "rows.0.cells.1": "p1.t1.r1.c2", grandTotalCents: "p1.t1.r3.c1" });
    const next = applyPatches(cited, [gridPatch({ "rows.0.cells.1": 250, "cellIds.rows.0.cells.1": "p2.t1.r1.c1", "cellIds.grandTotalCents": null })]);
    expect(next.grids[0]!.cellIds).toEqual({ "rows.0.cells.1": "p2.t1.r1.c1", grandTotalCents: null });
    expect(cellProofPatches(rulebook, [gridPatch({ "cellIds.rows.0.cells.1": "p1.t1.r1.c2" })])).toEqual([]);
  });

  it("is dropped when a change gives a scanned amount another value, unless the change cites it again", () => {
    const cited: Rulebook = {
      ...rulebook,
      terms: [{ ...term, source: { ...term.source, cell: "p1.t1.r1.c1", capCell: "p1.l2" }, cap: { kind: "amount", value: 500000, period: null, text: "" } }],
      grids: [{ ...rulebook.grids[0]!, cellIds: { "rows.0.cells.1": "p1.t1.r1.c2", "subtotal.1": "p1.t1.r2.c2", grandTotalCents: "p1.t1.r3.c1" } }],
    };
    expect(citationPatches(cited, [termPatch("t1", { amountCents: 150000 })])).toEqual([termPatch("t1", { "source.cell": null })]);
    expect(citationPatches(cited, [termPatch("t1", { cap: { kind: "amount", value: 1, period: null, text: "" } })])).toEqual([termPatch("t1", { "source.capCell": null })]);
    expect(citationPatches(cited, [termPatch("t1", { amountCents: 100000, notes: "same amount" })])).toEqual([]);
    expect(citationPatches(cited, [termPatch("t1", { amountCents: 1, "source.cell": "p1.t1.r1.c2" })])).toEqual([]);
    expect(citationPatches(cited, [termPatch("t1", { amountCents: 1, source: { ...term.source, cell: "p1.t1.r1.c2" } })])).toEqual([termPatch("t1", { "source.cell": null })]);

    expect(citationPatches(cited, [gridPatch({ "rows.0.cells.1": 250, "subtotal.1": 200 })])).toEqual([gridPatch({ "cellIds.rows.0.cells.1": null })]);
    expect(citationPatches(cited, [gridPatch({ subtotal: [100, 250] })])).toEqual([gridPatch({ "cellIds.subtotal.1": null })]);
    expect(citationPatches(cited, [gridPatch({ grandTotalCents: 9, "cellIds.grandTotalCents": "p1.t1.r4.c1" })])).toEqual([]);
    const next = applyPatches(cited, [gridPatch({ "rows.0.cells.1": 250 }), ...citationPatches(cited, [gridPatch({ "rows.0.cells.1": 250 })])]);
    expect(next.grids[0]!.cellIds).toEqual({ "rows.0.cells.1": null, "subtotal.1": "p1.t1.r2.c2", grandTotalCents: "p1.t1.r3.c1" });
  });

  it("of a grid value must be an id", () => {
    expect(() => applyPatches(rulebook, [gridPatch({ "cellIds.rows.0.cells.1": 5 })])).toThrow(/would leave the rulebook invalid: grids\.0\.cellIds/);
  });
});
