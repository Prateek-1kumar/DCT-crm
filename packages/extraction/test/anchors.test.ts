import type { Rulebook } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { type Anchor, bindEvidence } from "../src/binder";
import { gateSweep } from "../src/sweep";
import type { TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/**
 * ADR-002 PR 3: the model's pointers (token ids resolved to a page word) place a row in a table row and a visit in a column,
 * and point at a visit's own sums; the total column may sit between the scheduled visits and conditional ones. Built straight as
 * TextPages (a ruled table and its words); synthetic only.
 */

type Printed = string | null;
const V0 = 80;
const RH = 20;
const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;

function drawn(table: Printed[][], U: number[], unsure: string[] = []): TextPage {
  const words: TextPage["words"] = [];
  table.forEach((row, r) =>
    row.forEach((text, k) => {
      if (!text) return;
      const [u0, v0] = [U[k]! + 4, V0 + RH * r + 5];
      words.push({ text, rect: [u0, v0, u0 + 5 * text.length, v0 + 10], dir: 0, block: words.length, line: words.length, hidden: false, conf: unsure.includes(`${r}:${k}`) ? 0.5 : 0.99 });
    }),
  );
  const ys = table.map((_, r) => V0 + RH * r).concat(V0 + RH * table.length);
  return { documentId: "d1", page: 1, width: 612, height: 792, source: "ocr", words, hidden: 0, largePicture: false, grids: [{ box: [U[0]!, ys[0]!, U.at(-1)!, ys.at(-1)!], xs: U, ys }] };
}
/** The index of the word printed in table row `r`, column `k`: what a token id names. */
const wordAt = (p: TextPage, U: number[], r: number, k: number) => p.words.findIndex((w) => w.rect[0] === U[k]! + 4 && w.rect[1] === V0 + RH * r + 5);

function read(visits: [string, string][], rows: [name: string, unit: number, cells: Record<string, number>][]): Rulebook {
  const rb = makeRulebook();
  const g = rb.budgetGrids[0]!;
  g.prov = { ...on };
  g.statedOverheadPct = null;
  g.perPatientTotals = [];
  g.visits = visits.map(([code, name], i) => ({ code, name, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: { ...on } }));
  g.procedures = rows.map(([name, unit, cells]) => ({ code: null, name, unitCents: unit * 100, overheadApplied: true, category: "procedure" as const, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v * 100])), prov: { ...on } }));
  return rb;
}
const cell = (grid: number, p: number, visit: string, word: number): Anchor => ({ grid, documentId: "d1", page: 1, word, field: "cell", visit, procedure: p });

describe("a total column between the scheduled visits and the conditional ones", () => {
  const U = [40, 160, 220, 280, 340, 400, 460, 520];
  const visits: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"], ["UNS", "Unsched"]];
  const rb = read(visits, [
    ["Venipuncture", 100, { T4: 100, T8: 100, T12: 100, UNS: 100 }],
    ["ECG tracing", 50, { T4: 50, T12: 50 }],
    ["Urine screen", 25, { T4: 25, T8: 25, T12: 25 }],
  ]);
  const table: Printed[][] = [
    ["Procedure", "Cost", "Week 4", "Week 8", "Week 12", "Sum", "Unsched"],
    ["Venipuncture", "100.00", "100.00", "100.00", "100.00", "300.00", "100.00"],
    ["ECG tracing", "50.00", "50.00", null, "50.00", "100.00", null],
    ["Urine screen", "25.00", "25.00", "25.00", "25.00", "75.00", null],
  ];

  it("is the row's total over the visits left of it, and is no visit; the column right of it is outside the sum", () => {
    const { rows } = bindEvidence(rb, [drawn(table, U)]);
    expect(rows.map((r) => [r.procedure, r.total, r.by])).toEqual([[0, 30000, "row_total"], [1, 10000, "row_total"], [2, 7500, "row_total"]]);
    // its visits are the page's four, the total column none of them
    expect(rows[0]!.cells.map((c) => c.box[0] * 612)).toEqual([220, 280, 340, 460]);
    expect(rows[0]!.covers).toEqual(["T4", "T8", "T12"]);
  });

  it("is found by quantity times the unit price too, whatever the row's own cells make of it", () => {
    const Q = [40, 100, 160, 220, 280, 340, 400, 460, 520];
    const qty: Printed[][] = [
      ["Procedure", "Qty", "Cost", "Week 4", "Week 8", "Week 12", "Sum", "Unsched"],
      ["Venipuncture", "3.00", "100.00", "100.00", "100.00", "100.00", "300.00", "100.00"],
      ["ECG tracing", "2.00", "50.00", "50.00", null, "50.00", "100.00", null],
      ["Urine screen", "3.00", "25.00", "25.00", "25.00", "25.00", "75.00", null],
    ];
    // a cell the scan is unsure of (row 1, Week 8) leaves the row's own sum unknown; the total is still the quantity times the price
    const { rows } = bindEvidence(rb, [drawn(qty, Q, ["1:4"])]);
    expect(rows.map((r) => [r.procedure, r.total, r.by])).toEqual([[0, 30000, "row_total"], [1, 10000, "row_total"], [2, 7500, "row_total"]]);
  });
});

describe("the model's pointers", () => {
  const U = [40, 160, 220, 280, 340, 400];
  const visits: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"]];
  const rb = read(visits, [
    ["Venipuncture", 100, { T4: 100, T8: 100, T12: 100 }],
    ["ECG tracing", 50, { T4: 50, T12: 50 }],
    ["Urine screen", 25, { T4: 25, T8: 25, T12: 25 }],
  ]);
  // the scan garbled the second row's label and every price in it, so nothing places the row by what it prints
  const garbled: Printed[][] = [
    ["Procedure", "Cost", "Week 4", "Week 8", "Week 12"],
    ["Venipuncture", "100.00", "100.00", "100.00", "100.00"],
    ["Zzqx wvut", "5O.OO", "5O.OO", null, "5O.OO"],
    ["Urine screen", "25.00", "25.00", "25.00", "25.00"],
  ];

  it("place a row in the table row its tokens are in, whatever the scan made of its label and prices", () => {
    const p = drawn(garbled, U);
    expect(bindEvidence(rb, [p]).rows.map((r) => r.procedure)).toEqual([0, 2]);
    const anchors = [cell(0, 1, "T4", wordAt(p, U, 2, 2)), cell(0, 1, "T12", wordAt(p, U, 2, 4))];
    const b = bindEvidence(rb, [p], [], anchors);
    expect(b.rows.map((r) => r.procedure)).toEqual([0, 1, 2]);
    // the placement says where, not what: the cells it cannot read stay asked, none is confirmed
    const status = (path: string) => b.evidence.find((e) => e.path === path)?.status;
    expect(status("/budgetGrids/0/procedures/1/cells/T4")).toBe("ungrounded");
    expect(status("/budgetGrids/0/procedures/0/cells/T4")).toBe("confirmed");
  });

  it("are ignored when they disagree about a row, or point at the same table row for two procedures", () => {
    const p = drawn(garbled, U);
    // two of three tokens in row 2, one in row 3: still row 2 (60%); an even split names no row
    const split = [cell(0, 1, "T4", wordAt(p, U, 2, 2)), cell(0, 1, "T8", wordAt(p, U, 3, 3))];
    expect(bindEvidence(rb, [p], [], split).rows.map((r) => r.procedure)).toEqual([0, 2]);
    // procedures 1 and 2 both pointed at row 3, the one that prints procedure 2's prices: the order check refuses it
    const twice = [cell(0, 1, "T4", wordAt(p, U, 3, 2)), cell(0, 2, "T4", wordAt(p, U, 3, 2))];
    expect(bindEvidence(rb, [p], [], twice).rows.map((r) => r.procedure)).toEqual([0, 2]);
  });

  it("never confirm a value the page does not print there: a pointer to a cell that prints another price is a conflict", () => {
    const p = drawn(garbled, U);
    const wrong = read(visits, [["Venipuncture", 100, { T4: 100, T8: 100, T12: 100 }], ["ECG tracing", 50, { T4: 50, T12: 50 }], ["Urine screen", 25, { T4: 99, T8: 25, T12: 25 }]]);
    const b = bindEvidence(wrong, [p], [], [cell(0, 2, "T4", wordAt(p, U, 3, 2))]);
    expect(b.evidence.find((e) => e.path === "/budgetGrids/0/procedures/2/cells/T4")?.status).toBe("conflict");
  });

  it("make the visit columns the pointed ones, not a count and order, so a table with an extra column is not held", () => {
    // an unlabelled extra column of prices between the unit price and the visits: count and order cannot tell, the pointers can
    const U2 = [40, 160, 220, 280, 340, 400, 460];
    const extra: Printed[][] = [
      ["Procedure", "Cost", "Notes", "Week 4", "Week 8", "Week 12"],
      ["Venipuncture", "100.00", "9.00", "100.00", "100.00", "100.00"],
      ["ECG tracing", "50.00", "9.00", "50.00", null, "50.00"],
      ["Urine screen", "25.00", "9.00", "25.00", "25.00", "25.00"],
    ];
    const p = drawn(extra, U2.slice(0, 7));
    const anchors = rb.budgetGrids[0]!.procedures.flatMap((pr, i) => Object.keys(pr.cells).map((v) => cell(0, i, v, wordAt(p, U2, i + 1, 3 + visits.findIndex(([c]) => c === v)))));
    const b = bindEvidence(rb, [p], [], anchors);
    expect(b.rows.map((r) => r.cells.map((c) => c.box[0] * 612))).toEqual([[280, 340, 400], [280, 340, 400], [280, 340, 400]]);
    expect(b.evidence.filter((e) => /cells/.test(e.path) && e.status === "confirmed")).toHaveLength(8);
    expect(b.tableChecks).toEqual([]);
  });
});

describe("a visit's own sum the model pointed at", () => {
  const U = [40, 160, 220, 280, 340, 400];
  const visits: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"]];
  const make = () => {
    const rb = read(visits, [["Venipuncture", 100, { T4: 100, T8: 100 }], ["ECG tracing", 50, { T4: 50, T8: 50 }]]);
    rb.budgetGrids[0]!.visits[0]!.procedureSubtotalCents = 15000;
    return rb;
  };
  // the scan lost the summary row's label
  const table: Printed[][] = [
    ["Procedure", "Cost", "Week 4", "Week 8"],
    ["Venipuncture", "100.00", "100.00", "100.00"],
    ["ECG tracing", "50.00", "50.00", "50.00"],
    ["Subtota1 xx", null, "150.00", "150.00"],
  ];
  const status = (b: ReturnType<typeof bindEvidence>) => b.evidence.find((e) => e.path === "/budgetGrids/0/visits/0/procedureSubtotalCents");
  const at = (p: TextPage): Anchor => ({ grid: 0, documentId: "d1", page: 1, word: wordAt(p, U, 3, 2), field: "procedureSubtotal", visit: "T4", procedure: null });

  it("is confirmed where the word says the amount, its parts are confirmed and add up to it", () => {
    const p = drawn(table, U);
    expect(status(bindEvidence(make(), [p]))?.status).not.toBe("confirmed");
    const e = status(bindEvidence(make(), [p], [], [at(p)]));
    expect(e).toMatchObject({ status: "confirmed", printed: "150.00" });
  });

  it("is not, when the word says another amount, or sits in another visit's column, or its parts do not add up", () => {
    const other: Printed[][] = table.map((r, i) => (i === 3 ? ["Subtota1 xx", null, "151.00", "150.00"] : r));
    const p = drawn(other, U);
    expect(status(bindEvidence(make(), [p], [], [at(p)]))?.status).not.toBe("confirmed");
    const q = drawn(table, U);
    const next: Anchor = { ...at(q), word: wordAt(q, U, 3, 3) };
    expect(status(bindEvidence(make(), [q], [], [next]))?.status).not.toBe("confirmed");
    const off = make();
    off.budgetGrids[0]!.visits[0]!.procedureSubtotalCents = 15100;
    expect(status(bindEvidence(off, [q], [], [{ ...at(q), word: wordAt(q, U, 3, 2) }]))?.status).not.toBe("confirmed");
  });
});

describe("amounts the read called no fee", () => {
  const U = [40, 160, 220, 280];
  // a row of the table the master holds nothing for: a code, and a price
  const table: Printed[][] = [["Procedure", "Cost", "Week 4"], ["Venipuncture", "100.00", "100.00"], ["Other", "99213", "$4,000.00"]];
  const rb = read([["T4", "Week 4"]], [["Venipuncture", 100, { T4: 100 }]]);
  const text = (s: { words: { text: string }[] }) => s.words.map((w) => w.text).join(" ");
  const p = drawn(table, U);
  const bound = bindEvidence(rb, [p]);
  const mark = (t: string, why: string) => ({ documentId: "d1", page: 1, word: p.words.findIndex((w) => w.text === t), why });
  const ctx = { evidence: bound.evidence, pages: [p], rb };

  it("are asked as before when the read says nothing", () => {
    expect(bound.unaccounted.map(text)).toEqual(expect.arrayContaining(["99213", "$4,000.00"]));
    expect(gateSweep(bound.unaccounted, ctx).kept.map(text)).toEqual(expect.arrayContaining(["99213", "$4,000.00"]));
  });

  it("are dropped only where a rule of ours agrees: a code with no currency mark and no cents; a price called a code stays asked, and is counted", () => {
    const said = gateSweep(bound.unaccounted, { ...ctx, nonFee: [mark("99213", "code"), mark("$4,000.00", "code")] });
    expect(said.kept.map(text)).not.toContain("99213");
    expect(said.kept.map(text)).toContain("$4,000.00");
    expect(said.report.modelNonFee).toEqual({ code: 1 });
    expect(said.report.modelKept).toBe(1);
  });

  it("a repeat is believed only when the master holds that price; an unknown reason is never believed", () => {
    const repeat = gateSweep(bound.unaccounted, { ...ctx, nonFee: [mark("$4,000.00", "repeat")] });
    expect(repeat.kept.map(text)).toContain("$4,000.00");
    const held = read([["T4", "Week 4"]], [["Venipuncture", 100, { T4: 100 }]]);
    held.invoiceables[0]!.amountCents = 400000;
    expect(gateSweep(bound.unaccounted, { ...ctx, rb: held, nonFee: [mark("$4,000.00", "repeat")] }).kept.map(text)).not.toContain("$4,000.00");
    expect(gateSweep(bound.unaccounted, { ...ctx, nonFee: [mark("99213", "other")] }).kept.map(text)).toContain("99213");
  });
});
