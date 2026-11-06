import type { Grid, Relation, Rulebook } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { checks } from "../src/checks";
import { coverage } from "../src/checks/coverage";
import { withRelationProof } from "../src/checks/relations";
import type { Reader } from "../src/models/reader";
import { buildPage } from "../src/pdf/page";
import { resolve } from "../src/resolve";
import { withScans } from "../src/scan";
import { parseTranscription, type Transcription } from "../src/scan/transcribe";
import { verifyVersion } from "../src/scan/verify";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";

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
