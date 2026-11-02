import type { Rulebook, ValueEvidence } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import type { TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/**
 * Cells the read calls "invoiceable" where a drawn table prints nothing: one group per table (`blankChecks`), not one
 * question per cell. A cell that prints anything, an unclear OCR page and a cell with unread ink in it never join one.
 * Built straight as TextPages (our OCR's words and a ruled table); synthetic only.
 */

type Printed = string | null;
const U = [40, 160, 220, 280, 340, 400, 460];
const V0 = 80;
const RH = 20;
const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;

function drawn(table: Printed[][], source: TextPage["source"] = "ocr", conf = 0.99): TextPage {
  const words: TextPage["words"] = [];
  table.forEach((row, r) =>
    row.forEach((c, k) => {
      if (!c) return;
      let u = U[k]! + 4;
      for (const t of c.split(" ")) {
        const [u0, u1, v0, v1] = [u, u + 5 * t.length, V0 + RH * r + 5, V0 + RH * r + 15];
        words.push({ text: t, rect: [u0, v0, u1, v1], dir: 0, block: words.length, line: words.length, hidden: false, ...(source === "ocr" ? { conf } : {}) });
        u = u1 + 4;
      }
    }),
  );
  const ys = table.map((_, r) => V0 + RH * r).concat(V0 + RH * table.length);
  const rules = { xs: U, ys };
  return { documentId: "d1", page: 1, width: 612, height: 792, source, words, hidden: 0, largePicture: false, grids: [{ box: [40, ys[0]!, 460, ys.at(-1)!], ...rules }] };
}

const HEAD: Printed[] = ["Procedure", "Cost", "Week 4", "Week 8", "Week 12", "Total"];
const INV = "invoiceable" as const;
const TABLE: Printed[][] = [
  HEAD,
  ["Venipuncture", "100.00", null, null, "100.00", null],
  ["ECG tracing", "50.00", null, null, "50.00", null],
  ["Urine screen", "25.00", "25.00", "25.00", "25.00", "75.00"],
];
/** The read: the first two rows' scheduled visits "invoiceable" (the table prints nothing there), the third priced. */
function read(): Rulebook {
  const rb = makeRulebook();
  const g = rb.budgetGrids[0]!;
  g.prov = { ...on };
  g.statedOverheadPct = null;
  g.perPatientTotals = [];
  g.visits = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"]].map(([code, name], i) => ({ code: code!, name: name!, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: { ...on } }));
  const rows: [string, number, Record<string, number | typeof INV>][] = [
    ["Venipuncture", 100, { T4: INV, T8: INV, T12: 10000 }],
    ["ECG tracing", 50, { T4: INV, T8: INV, T12: 5000 }],
    ["Urine screen", 25, { T4: 2500, T8: 2500, T12: 2500 }],
  ];
  g.procedures = rows.map(([name, unit, cells]) => ({ code: null, name, unitCents: unit * 100, overheadApplied: true, category: "procedure" as const, cells, prov: { ...on } }));
  return rb;
}
const path = (row: number, visit: string) => `/budgetGrids/0/procedures/${row}/cells/${visit}`;
const ev = (list: ValueEvidence[], p: string) => list.find((e) => e.path === p);

describe("blank cells the read calls invoiceable", () => {
  it("are one group per table: the cells marked blank, still not confirmed, no per-cell mark on anything else", () => {
    const b = bindEvidence(read(), [drawn(TABLE)]);
    expect(b.blankChecks).toHaveLength(1);
    const c = b.blankChecks[0]!;
    expect(c).toMatchObject({ grid: 0, page: 1, rows: [0, 1], cells: [path(0, "T4"), path(0, "T8"), path(1, "T4"), path(1, "T8")] });
    expect(c.table.box).not.toBeNull();
    for (const p of c.cells) expect(ev(b.evidence, p), p).toMatchObject({ blank: c.id, status: "ungrounded" });
    // the priced cells are confirmed by the page as ever, and carry no mark
    for (const p of [path(0, "T12"), path(1, "T12"), path(2, "T4"), path(2, "T8"), path(2, "T12")]) (expect(ev(b.evidence, p)!.status, p).toBe("confirmed"), expect(ev(b.evidence, p)!.blank).toBeUndefined());
    // each cell's spot is its row, so the question can show the rows
    for (const p of c.cells) expect(ev(b.evidence, p)!.where[0]!.box).not.toBeNull();
  });

  it("wait for the table's check where the columns are only held, and for nothing where the headers agree", () => {
    const agreed = bindEvidence(read(), [drawn(TABLE)]);
    expect(agreed.tableChecks).toEqual([]);
    expect(agreed.blankChecks[0]!.after).toBeUndefined();
    // headers that don't name the visits, though the columns line up with them by count and order: held
    const held = bindEvidence(read(), [drawn([["Procedure", "Cost", "Col 1", "Col 2", "Col 3", "Total"], ...TABLE.slice(1)])]);
    expect(held.tableChecks).toHaveLength(1);
    expect(held.blankChecks).toHaveLength(1);
    expect(held.blankChecks[0]!.after).toBe(held.tableChecks[0]!.id);
    expect(held.blankChecks[0]!.cells).toHaveLength(4);
  });

  it("are grouped on a text page too (there a blank cell is a real blank, so the cell is in conflict, not unread)", () => {
    const b = bindEvidence(read(), [drawn(TABLE, "text")]);
    expect(b.blankChecks).toHaveLength(1);
    expect(b.blankChecks[0]!.cells).toHaveLength(4);
    expect(ev(b.evidence, path(0, "T4"))).toMatchObject({ status: "conflict", blank: b.blankChecks[0]!.id });
  });

  it("never include a cell that prints the word, a price, or anything else: it keeps its own rule and its own question", () => {
    const table: Printed[][] = [...TABLE];
    table[1] = ["Venipuncture", "100.00", "Inv", null, "100.00", null]; // prints the word: confirmed by it
    table[2] = ["ECG tracing", "50.00", "77.00", null, "50.00", null]; // prints another price
    const b = bindEvidence(read(), [drawn(table)]);
    const c = b.blankChecks[0]!;
    expect(c.cells).toEqual([path(0, "T8"), path(1, "T8")]);
    expect(c.cells).not.toContain(path(1, "T4"));
    expect(ev(b.evidence, path(1, "T4"))!.blank).toBeUndefined();
    expect(ev(b.evidence, path(1, "T4"))!.status).not.toBe("confirmed");
    expect(ev(b.evidence, path(0, "T8"))!.blank).toBe(c.id);
    expect(ev(b.evidence, path(1, "T8"))!.blank).toBe(c.id);
  });

  it("never include a cell with unread ink in it, whatever the rest of the table does", () => {
    const page = drawn(TABLE);
    // ink the OCR couldn't read, over the first row's Week 4 cell (a fraction of the page)
    page.unread = [{ documentId: "d1", page: 1, box: [(U[2]! + 5) / 612, (V0 + RH + 5) / 792, 40 / 612, 8 / 792] }];
    const b = bindEvidence(read(), [page]);
    expect(b.blankChecks[0]!.cells).not.toContain(path(0, "T4"));
    expect(ev(b.evidence, path(0, "T4"))!.blank).toBeUndefined();
    expect(b.blankChecks[0]!.cells).toEqual([path(0, "T8"), path(1, "T4"), path(1, "T8")]);
  });

  it("are not grouped on an OCR page that isn't clear (under 70% of its words read with confidence)", () => {
    const b = bindEvidence(read(), [drawn(TABLE, "ocr", 0.5)]);
    expect(b.blankChecks).toEqual([]);
    expect(ev(b.evidence, path(0, "T4"))!.blank).toBeUndefined();
  });

  it("are not grouped where the read's cell is a price, or there is no drawn table", () => {
    // the table prints nothing where the read has a price: that's a conflict, never a blank "invoiceable"
    const rb = read();
    rb.budgetGrids[0]!.procedures[0]!.cells = { T4: 10000, T8: INV, T12: 10000 };
    const b = bindEvidence(rb, [drawn(TABLE)]);
    expect(b.blankChecks[0]!.cells).not.toContain(path(0, "T4"));
    expect(bindEvidence(read(), [{ ...drawn(TABLE), grids: undefined }]).blankChecks).toEqual([]);
  });
});
