import type { Rulebook } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { solveGrids } from "../src/solver";
import type { TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/**
 * What a drawn table prints as each row's total (`bindEvidence(...).rows`, ADR-002): a total column that is the sum of the
 * row's printed cells, or a quantity column; the row boxes the sweep consumes. Built straight as TextPages (a ruled table and
 * its words); synthetic only.
 */

type Printed = string | null;
const U0 = [40, 160, 220, 280, 340, 400, 460];
const V0 = 80;
const RH = 20;
const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;

function drawn(table: Printed[][], opts: { source?: TextPage["source"]; unsure?: string[]; u?: number[] } = {}): TextPage {
  const source = opts.source ?? "ocr";
  const U = opts.u ?? U0;
  const words: TextPage["words"] = [];
  table.forEach((row, r) =>
    row.forEach((text, k) => {
      if (!text) return;
      const [u0, v0] = [U[k]! + 4, V0 + RH * r + 5];
      words.push({ text, rect: [u0, v0, u0 + 5 * text.length, v0 + 10], dir: 0, block: words.length, line: words.length, hidden: false, ...(source === "ocr" ? { conf: opts.unsure?.includes(`${r}:${k}`) ? 0.5 : 0.99 } : {}) });
    }),
  );
  const ys = table.map((_, r) => V0 + RH * r).concat(V0 + RH * table.length);
  return { documentId: "d1", page: 1, width: 612, height: 792, source, words, hidden: 0, largePicture: false, grids: [{ box: [40, ys[0]!, 460, ys.at(-1)!], xs: U, ys }] };
}

const visits: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"]];
/** The read: rows by name with unit price and cells, in dollars. */
function read(rows: [name: string, unit: number, cells: Record<string, number>][]): Rulebook {
  const rb = makeRulebook();
  const g = rb.budgetGrids[0]!;
  g.prov = { ...on };
  g.statedOverheadPct = null;
  g.perPatientTotals = [];
  g.visits = visits.map(([code, name], i) => ({ code, name, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: { ...on } }));
  g.procedures = rows.map(([name, unit, cells]) => ({ code: null, name, unitCents: unit * 100, overheadApplied: true, category: "procedure" as const, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v * 100])), prov: { ...on } }));
  return rb;
}
const READ: Parameters<typeof read>[0] = [
  ["Venipuncture", 100, { T4: 100, T8: 100, T12: 100 }],
  ["ECG tracing", 50, { T4: 50, T12: 50 }],
  ["Urine screen", 25, { T4: 25, T8: 25, T12: 25 }],
];
const HEAD: Printed[] = ["Procedure", "Cost", "Week 4", "Week 8", "Week 12", "Total"];
const WITH_TOTALS: Printed[][] = [
  HEAD,
  ["Venipuncture", "100.00", "100.00", "100.00", "100.00", "300.00"],
  ["ECG tracing", "50.00", "50.00", null, "50.00", "100.00"],
  ["Urine screen", "25.00", "25.00", "25.00", "25.00", "75.00"],
];
const totals = (t: Printed[][], rb = read(READ), opts?: Parameters<typeof drawn>[1]) => bindEvidence(rb, [drawn(t, opts)]).rows.map((r) => [r.procedure, r.total, r.by]);

describe("a table's printed row totals", () => {
  it("a total column that is the sum of each row's printed cells gives every mapped row its printed total", () => {
    const { rows } = bindEvidence(read(READ), [drawn(WITH_TOTALS)]);
    expect(rows.map((r) => [r.procedure, r.total, r.by])).toEqual([[0, 30000, "row_total"], [1, 10000, "row_total"], [2, 7500, "row_total"]]);
    for (const r of rows) {
      expect(r).toMatchObject({ grid: 0, documentId: "d1", page: 1 });
      expect(r.cells.map((c) => c.visit)).toEqual(["T4", "T8", "T12"]);
      // the row's band spans the table's width, and its cells lie inside it, one per visit column, left to right
      const [x, y, w, h] = r.box;
      expect([x, w]).toEqual([40 / 612, 420 / 612]);
      expect(h).toBeCloseTo(RH / 792);
      for (const c of r.cells) expect(c.box[0] >= x && c.box[0] + c.box[2] <= x + w + 1e-9 && c.box[1] === y).toBe(true);
      expect(r.cells.map((c) => c.box[0])).toEqual([220 / 612, 280 / 612, 340 / 612]);
    }
  });

  it("is the page's figure, not the read's: a row the read gave fewer cells keeps the printed total", () => {
    const rows = bindEvidence(read([["Venipuncture", 100, { T4: 100, T8: 100 }], ...READ.slice(1)]), [drawn(WITH_TOTALS)]).rows;
    expect(rows.find((r) => r.procedure === 0)).toMatchObject({ total: 30000, by: "row_total" });
  });

  it("needs a column that is the sum on at least two rows and on most of the rows that print it", () => {
    // one row that sums: not a total column
    expect(totals([HEAD, ["Venipuncture", "100.00", "100.00", "100.00", "100.00", "300.00"], ["ECG tracing", "50.00", "50.00", null, "50.00", "9.00"], ["Urine screen", "25.00", "25.00", "25.00", "25.00", "8.00"]]).map((r) => r[1])).toEqual([null, null, null]);
    // two of four rows sum: not most
    const four = read([...READ, ["Chest x-ray", 40, { T4: 40, T8: 40, T12: 40 }]]);
    expect(totals([...WITH_TOTALS, ["Chest x-ray", "40.00", "40.00", "40.00", "40.00", "7.00"]].map((r, i) => (i === 3 ? ["Urine screen", "25.00", "25.00", "25.00", "25.00", "6.00"] : r)), four).map((r) => r[1])).toEqual([null, null, null, null]);
    // a column that is sums on every row but is left of the visits is no total
    expect(totals([["Procedure", "Total", "Cost", "Week 4", "Week 8", "Week 12"], ["Venipuncture", "300.00", "100.00", "100.00", "100.00", "100.00"], ["ECG tracing", "100.00", "50.00", "50.00", null, "50.00"], ["Urine screen", "75.00", "25.00", "25.00", "25.00", "25.00"]]).map((r) => r[1])).toEqual([null, null, null]);
  });

  it("is unmapped where the table prints no such column (most tables print neither): no total, so the solver has no row identity", () => {
    const plain: Printed[][] = WITH_TOTALS.map((r) => r.slice(0, 5));
    const b = bindEvidence(read(READ), [drawn(plain)]);
    expect(b.rows.map((r) => [r.procedure, r.total, r.by])).toEqual([[0, null, null], [1, null, null], [2, null, null]]);
    const solved = solveGrids(read(READ), b.evidence, { rows: b.rows });
    expect(solved.report.identities.row.checked).toBe(0);
  });

  it("a total the scan is unsure of is not read; the rows that are sure keep theirs", () => {
    expect(totals(WITH_TOTALS, read(READ), { unsure: ["3:5"] }).map((r) => r[1])).toEqual([30000, 10000, null]);
    // an unsure visit cell takes its row out of the count that finds the column, but once the column is found the row keeps the sure
    // total it prints: the total is then what says what the unreadable cell is
    expect(totals(WITH_TOTALS, read(READ), { unsure: ["1:2"] }).map((r) => r[1])).toEqual([30000, 10000, 7500]);
  });

  it("a totals row is no body row: it takes no part in finding the column, and gets no band", () => {
    const withTotalRow = [...WITH_TOTALS, ["Total", "175.00", "175.00", "175.00", "175.00", "525.00"]];
    const { rows } = bindEvidence(read(READ), [drawn(withTotalRow)]);
    expect(rows.map((r) => r.procedure)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.total)).toEqual([30000, 10000, 7500]);
  });

  describe("a quantity column", () => {
    const QTY_HEAD: Printed[] = ["Procedure", "Qty", "Cost", "Week 4", "Week 8", "Week 12"];
    const QTY: Printed[][] = [
      QTY_HEAD,
      ["Venipuncture", "2", "100.00", "100.00", "100.00", null],
      ["ECG tracing", "1", "50.00", null, "50.00", null],
      ["Urine screen", "3", "25.00", "25.00", "25.00", "25.00"],
    ];
    const qread = read([["Venipuncture", 100, { T4: 100, T8: 100 }], ["ECG tracing", 50, { T8: 50 }], ["Urine screen", 25, { T4: 25, T8: 25, T12: 25 }]]);

    it("is the count of populated visit cells on most rows: the row's total is its printed unit price times it", () => {
      expect(totals(QTY, qread)).toEqual([[0, 20000, "quantity"], [1, 5000, "quantity"], [2, 7500, "quantity"]]);
    });

    it("is not a quantity where the count of populated cells doesn't match", () => {
      const off = QTY.map((r, i) => (i === 1 || i === 2 ? [r[0]!, "5", ...r.slice(2)] : r));
      expect(totals(off, qread).map((r) => r[1])).toEqual([null, null, null]);
      // one row in agreement is not enough
      expect(totals(QTY.map((r, i) => (i === 2 ? [r[0]!, "5", ...r.slice(2)] : i === 3 ? [r[0]!, "9", ...r.slice(2)] : r)), qread).map((r) => r[1])).toEqual([null, null, null]);
    });

    it("keeps the printed total where the table has a total column too (the quantity would only repeat it)", () => {
      const U7 = [...U0, 520];
      const both: Printed[][] = QTY.map((r, i) => [...r, i === 0 ? "Total" : ["", "200.00", "50.00", "75.00"][i]!]);
      const page = drawn(both);
      page.grids = [{ ...page.grids![0]!, xs: U7, box: [40, 80, 520, 160] }];
      expect(bindEvidence(qread, [page]).rows.map((r) => [r.procedure, r.total, r.by])).toEqual([[0, 20000, "row_total"], [1, 5000, "row_total"], [2, 7500, "row_total"]]);
    });
  });

  it("feeds the solver: the read's cells against the printed total; a cell the read missed fails its row", () => {
    const good = read(READ);
    const b = bindEvidence(good, [drawn(WITH_TOTALS)]);
    expect(solveGrids(good, b.evidence, { rows: b.rows }).report.identities.row).toEqual({ checked: 3, passed: 3, failed: 0 });
    // the read has no T8 price for the first row: the page prints 300.00 for a row the read's cells add to 200.00
    const missed = read([["Venipuncture", 100, { T4: 100, T12: 100 }], ...READ.slice(1)]);
    const bm = bindEvidence(missed, [drawn(WITH_TOTALS)]);
    expect(bm.rows.find((r) => r.procedure === 0)?.total).toBe(30000);
    expect(solveGrids(missed, bm.evidence, { rows: bm.rows }).report.identities.row).toEqual({ checked: 3, passed: 2, failed: 1 });
  });
});

describe("the senior engineer's total column: quantity x unit price, and the read's own claim", () => {
  const U8 = [40, 140, 180, 230, 290, 350, 410, 470];
  // Procedure | Qty | Cost | Week 4 | Week 8 | Week 12 | Total: each total is quantity x cost, but it isn't the sum of the row's printed cells
  // (the quantity counts a visit the table's visit columns don't hold), so the cells-add-up test finds no total column
  const QTY: Printed[][] = [
    ["Procedure", "Qty", "Cost", "Week 4", "Week 8", "Week 12", "Total"],
    ["Venipuncture", "4.00", "100.00", "100.00", "100.00", "100.00", "400.00"],
    ["ECG tracing", "3.00", "50.00", "50.00", null, "50.00", "150.00"],
    ["Urine screen", "3.00", "25.00", "25.00", "25.00", "25.00", "75.00"],
  ];
  const at = (t: Printed[][], printedRows: Parameters<typeof bindEvidence>[2] = []) => bindEvidence(read(READ), [drawn(t, { u: U8 })], printedRows).rows.map((r) => [r.procedure, r.total, r.by]);

  it("finds a total column from quantity x unit price (a quantity printed 4.00), whatever the row's cells add up to", () => {
    expect(at(QTY)).toEqual([[0, 40000, "row_total"], [1, 15000, "row_total"], [2, 7500, "row_total"]]);
  });

  it("a column that is not quantity x unit price is no total", () => {
    expect(at(QTY.map((r, i) => (i && i < 3 ? [...r.slice(0, 6), "9.00"] : r))).map((r) => r[1])).toEqual([null, null, null]);
  });

  it("the read's claim of a row's total is taken only where the scan prints that figure in the row, right of the visits", () => {
    const NO_QTY = QTY.map((r) => [r[0]!, ...r.slice(2)]);
    const rows = (printed: Parameters<typeof bindEvidence>[2]) => bindEvidence(read(READ), [drawn(NO_QTY, { u: U8.slice(1) })], printed).rows;
    expect(rows([]).map((r) => r.total)).toEqual([null, null, null]);
    const claimed = rows([{ grid: 0, procedure: 0, qty: null, totalCents: 40000 }]).find((r) => r.procedure === 0)!;
    expect(claimed).toMatchObject({ total: 40000, by: "row_total" });
    expect(claimed.covers).toEqual(["T4", "T8", "T12"]);
    // a figure the scan doesn't print in that row is no claim
    expect(rows([{ grid: 0, procedure: 0, qty: null, totalCents: 41000 }]).find((r) => r.procedure === 0)!.total).toBeNull();
  });

  it("a claimed quantity needs the same number printed left of the visits and a sure unit price", () => {
    const NO_TOTAL = QTY.map((r) => r.slice(0, 6));
    const row = (qty: number) => bindEvidence(read(READ), [drawn(NO_TOTAL, { u: U8.slice(0, 7) })], [{ grid: 0, procedure: 0, qty, totalCents: null }]).rows.find((r) => r.procedure === 0)!;
    expect(row(4)).toMatchObject({ total: 40000, by: "quantity" });
    expect(row(5).total).toBeNull();
  });
});
