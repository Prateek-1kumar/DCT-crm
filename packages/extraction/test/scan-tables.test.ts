import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook, ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence, reviewFromEvidence } from "../src/binder";
import { readTextLayer, type TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/**
 * Budget tables as scans print them (ADR-001 addendum 2026-10-29): headers stacked over lines or naming visits
 * differently from the read, a label printed twice, and our own OCR's reading (source "ocr"), where a blank, garbled or
 * unsure cell says nothing. Synthetic PDFs only.
 */

type Text = [x: number, y: number, s: string];
const at = ([x, y, s]: Text) => `BT /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`;

async function pages(...each: Text[][]): Promise<TextPage[]> {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const filler: Text[] = [[40, 700, "This page continues the agreement between the parties and the site, as set out in full above."], [40, 720, "A second line of ordinary words keeps the page well above the threshold for a real text layer."], [40, 740, "A third line, because a page with fewer than two hundred characters of text is treated as a scan."]];
  for (const texts of each) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, [...texts, ...filler].map(at).join("")));
  const path = join(mkdtempSync(join(tmpdir(), "dct-scan-")), "table.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(path, "d1");
}
const page = async (texts: Text[]) => (await pages(texts))[0]!;

/** The page as our OCR would give it: every word with a confidence; `edit` changes words by their text. */
const asOcr = (p: TextPage, edit: (w: TextPage["words"][number]) => Partial<TextPage["words"][number]> = () => ({})): TextPage => ({
  ...p,
  source: "ocr",
  words: p.words.map((w) => ({ ...w, conf: 0.99, ...edit(w) })),
});

const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;
/** One grid on page 1: visits by code and name, rows by name with unit price and cells (dollars). */
function grid(visits: [code: string, name: string][], rows: [name: string, unit: number, cells: Record<string, number>][]): Rulebook {
  const rb = makeRulebook();
  const g = rb.budgetGrids[0]!;
  g.prov = { ...on };
  g.statedOverheadPct = null;
  g.perPatientTotals = [];
  g.visits = visits.map(([code, name], i) => ({ code, name, order: i + 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: { ...on } }));
  g.procedures = rows.map(([name, unit, cells]) => ({
    code: null,
    name,
    unitCents: unit * 100,
    overheadApplied: true,
    category: "procedure" as const,
    cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v * 100])),
    prov: { ...on },
  }));
  return rb;
}
const cellStatus = (ev: ValueEvidence[], row: number, visit: string) => ev.find((e) => e.path === `/budgetGrids/0/procedures/${row}/cells/${visit}`)?.status;

const X = { name: 90, unit: 220, c1: 280, c2: 340, c3: 400, c4: 460 };
const rowAt = (y: number, name: string, unit: string, cells: (string | null)[]): Text[] => [
  [X.name, y, name],
  [X.unit, y, unit],
  ...cells.flatMap((c, i): Text[] => (c ? [[[X.c1, X.c2, X.c3, X.c4][i]!, y, c]] : [])),
];

describe("visit columns run in visit order", () => {
  it("a visit's label printed again out of order (over the unit price) never makes that price the visit's", async () => {
    // "V3" also printed over the unit column: matched there, the row's unit price would confirm a V3 cell the row leaves blank
    const p = await page([[X.name, 100, "Procedure"], [X.unit + 2, 100, "V3"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"], ...rowAt(120, "Blood draw", "200.00", ["200.00", "200.00", null])]);
    const rb = grid([["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"]], [["Blood draw", 200, { V1: 200, V2: 200, V3: 200 }]]);
    const ev = bindEvidence(rb, [p]).evidence;
    expect([cellStatus(ev, 0, "V1"), cellStatus(ev, 0, "V2")]).toEqual(["confirmed", "confirmed"]);
    expect(cellStatus(ev, 0, "V3")).toBe("conflict");
  });
});

describe("headers stacked over two lines", () => {
  const head: Text[] = [[X.name, 96, "Procedure"], [X.c1, 92, "Visit"], [X.c1, 101, "1"], [X.c2, 92, "Visit"], [X.c2, 101, "2"], [X.c3, 92, "Visit"], [X.c3, 101, "3"]];
  const visits: [string, string][] = [["A", "Visit 1"], ["B", "Visit 2"], ["C", "Visit 3"]];

  it("join per column, so the visit names match and the cells confirm", async () => {
    const p = await page([...head, ...rowAt(120, "Physical exam", "300.00", ["300.00", "300.00", "300.00"])]);
    const ev = bindEvidence(grid(visits, [["Physical exam", 300, { A: 300, B: 300, C: 300 }]]), [p]).evidence;
    expect(["A", "B", "C"].map((v) => cellStatus(ev, 0, v))).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("a name with one letter misread still matches; a different visit number never does", async () => {
    const misread = head.map(([x, y, s]): Text => [x, y, s === "Visit" && x === X.c1 ? "Vislt" : s]);
    const p = await page([...misread, ...rowAt(120, "Physical exam", "300.00", ["300.00", "300.00", "300.00"])]);
    expect(cellStatus(bindEvidence(grid(visits, [["Physical exam", 300, { A: 300, B: 300, C: 300 }]]), [p]).evidence, 0, "A")).toBe("confirmed");
    // "Visit 7" printed where the read says "Visit 1": the digits differ, so it isn't that visit's column
    const other = head.map(([x, y, s]): Text => [x, y, x === X.c1 && s === "1" ? "7" : s]);
    const q = await page([...other, ...rowAt(120, "Physical exam", "300.00", ["300.00", "300.00", "300.00"])]);
    expect(cellStatus(bindEvidence(grid(visits, [["Physical exam", 300, { A: 300, B: 300, C: 300 }]]), [q]).evidence, 0, "A")).not.toBe("confirmed");
  });
});

describe("visit names the table doesn't print as such", () => {
  it("a column whose header carries every tag of the name (week 4) is that visit's, phase heading or not", async () => {
    const p = await page([
      [X.c1 + 20, 84, "Treatment Phase"],
      [X.name, 100, "Procedure"],
      [X.c1, 100, "Week 4"],
      [X.c2, 100, "Week 8"],
      [X.c3, 100, "Week 12"],
      ...rowAt(120, "Physical exam", "300.00", ["300.00", "300.00", "300.00"]),
      ...rowAt(134, "Blood draw", "200.00", ["200.00", null, "200.00"]),
    ]);
    const rb = grid([["T4", "Treatment Week 4"], ["T8", "Treatment Week 8"], ["T12", "Treatment Week 12"]], [["Physical exam", 300, { T4: 300, T8: 300, T12: 300 }], ["Blood draw", 200, { T4: 200, T12: 200 }]]);
    const ev = bindEvidence(rb, [p]).evidence;
    expect(["T4", "T8", "T12"].map((v) => cellStatus(ev, 0, v))).toEqual(["confirmed", "confirmed", "confirmed"]);
    // a price put at the visit next door, where the row prints nothing, is never confirmed
    const wrong = structuredClone(rb);
    wrong.budgetGrids[0]!.procedures[1]!.cells = { T4: 20000, T8: 20000 };
    expect(cellStatus(bindEvidence(wrong, [p]).evidence, 1, "T8")).toBe("conflict");
  });
});

describe("visits between two found ones", () => {
  const visits: [string, string][] = [["V1", "Screening"], ["V2", "Day 1"], ["V3", "Day 8"], ["V4", "Day 15"]];
  const rb = grid(visits, [["Physical exam", 300, { V1: 300, V2: 310, V3: 320, V4: 330 }]]);

  it("take the price columns between them in order when exactly as many lie between", async () => {
    const p = await page([[X.name, 100, "Procedure"], [X.c1, 100, "V1"], [X.c2, 100, "Vx?"], [X.c3, 100, "V#"], [X.c4, 100, "V4"], ...rowAt(120, "Physical exam", "300.00", ["300.00", "310.00", "320.00", "330.00"])]);
    const ev = bindEvidence(rb, [p]).evidence;
    expect(["V1", "V2", "V3", "V4"].map((v) => cellStatus(ev, 0, v))).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
  });

  it("stay without a column when the count differs (an extra column between): their cells are asked", async () => {
    const xs = [280, 325, 370, 415, 460];
    const p = await page([
      [X.name, 100, "Procedure"],
      [xs[0]!, 100, "V1"],
      [xs[4]!, 100, "V4"],
      [X.name, 120, "Physical exam"],
      [X.unit, 120, "300.00"],
      ...["300.00", "999.00", "310.00", "320.00", "330.00"].map((s, i): Text => [xs[i]!, 120, s]),
    ]);
    const ev = bindEvidence(rb, [p]).evidence;
    expect(["V2", "V3"].map((v) => cellStatus(ev, 0, v))).toEqual(["ungrounded", "ungrounded"]);
  });
});

describe("our OCR's reading of a cell", () => {
  const texts: Text[] = [[X.name, 100, "Procedure"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"], ...rowAt(120, "Blood draw", "200.00", ["200.00", "250.00", null])];
  const rb = grid([["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"]], [["Blood draw", 200, { V1: 200, V2: 250, V3: 200 }]]);

  it("confirms digits that agree, when it is sure of them", async () => {
    const ev = bindEvidence(rb, [asOcr(await page(texts))]).evidence;
    expect([cellStatus(ev, 0, "V1"), cellStatus(ev, 0, "V2")]).toEqual(["confirmed", "confirmed"]);
  });

  it("an unsure word confirms nothing, even when its digits agree", async () => {
    const p = asOcr(await page(texts), (w) => (w.text === "250.00" ? { conf: 0.5 } : {}));
    expect(cellStatus(bindEvidence(rb, [p]).evidence, 0, "V2")).toBe("ungrounded");
  });

  it("a blank or garbled cell on a scan says nothing (asked, or the totals decide); on a PDF's own text it contradicts", async () => {
    const p = await page(texts);
    expect(cellStatus(bindEvidence(rb, [p]).evidence, 0, "V3")).toBe("conflict");
    expect(cellStatus(bindEvidence(rb, [asOcr(p)]).evidence, 0, "V3")).toBe("ungrounded");
    const garbled = asOcr(p, (w) => (w.text === "250.00" ? { text: "25O.OE" } : {}));
    expect(cellStatus(bindEvidence(rb, [garbled]).evidence, 0, "V2")).toBe("ungrounded");
  });

  it("a clean number that differs is still a conflict, and every one-digit change of a confirmed cell is caught", async () => {
    const p = asOcr(await page(texts));
    const wrong = structuredClone(rb);
    wrong.budgetGrids[0]!.procedures[0]!.cells.V2 = 26000;
    expect(cellStatus(bindEvidence(wrong, [p]).evidence, 0, "V2")).toBe("conflict");
    for (const d of [15000, 20100, 20010, 2000, 200000, 28000]) {
      const m = structuredClone(rb);
      m.budgetGrids[0]!.procedures[0]!.cells.V1 = d;
      expect(cellStatus(bindEvidence(m, [p]).evidence, 0, "V1")).not.toBe("confirmed");
    }
  });
});

describe("a continuation page that prints no header", () => {
  it("takes the columns of the page before, moved by the shift that lines them up (a scan sits differently on each page)", async () => {
    const visits: [string, string][] = [["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"]];
    const head: Text[] = [[X.name, 100, "Procedure"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"]];
    // page 2 sits 30 points to the right (half a column), and its rows print nothing under V2
    const moved = (y: number, name: string, cells: (string | null)[]): Text[] => rowAt(y, name, "100.00", cells).map(([x, yy, s]): Text => [x + 30, yy, s]);
    const [p1, p2] = await pages([...head, ...rowAt(120, "Physical exam", "300.00", ["300.00", "300.00", "300.00"])], [...moved(120, "Blood draw", ["100.00", null, "100.00"]), ...moved(134, "Urine test", ["100.00", null, "100.00"])]);
    const rb = grid(visits, [["Physical exam", 300, { V1: 300, V2: 300, V3: 300 }], ["Blood draw", 100, { V1: 100, V3: 100 }], ["Urine test", 100, { V1: 100, V3: 100 }]]);
    for (const pr of [rb.budgetGrids[0]!.procedures[1]!, rb.budgetGrids[0]!.procedures[2]!]) pr.prov = { ...on, source: { documentId: "d1", page: 2 } };
    const ev = bindEvidence(rb, [asOcr(p1!), asOcr(p2!)]).evidence;
    expect(["V1", "V3"].map((v) => cellStatus(ev, 1, v))).toEqual(["confirmed", "confirmed"]);
    // a price put under V2, which this page leaves blank, is never confirmed
    const wrong = structuredClone(rb);
    wrong.budgetGrids[0]!.procedures[1]!.cells.V2 = 10000;
    expect(cellStatus(bindEvidence(wrong, [asOcr(p1!), asOcr(p2!)]).evidence, 1, "V2")).not.toBe("confirmed");
  });
});

describe("an invoiceable cell on a scan", () => {
  it("is there when the cell prints the row's price, or the word; a blank or another price says it isn't", async () => {
    // tables print a price only under the visits it applies to
    const p = asOcr(await page([[X.name, 100, "Procedure"], [X.unit, 100, "Unit"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"], [X.c4, 100, "V4"], ...rowAt(120, "Imaging", "400.00", ["400.00", "Invoiceable", null, "390.00"])]));
    const rb = grid([["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"], ["V4", "Week 6"]], [["Imaging", 400, {}]]);
    rb.budgetGrids[0]!.procedures[0]!.cells = { V1: "invoiceable", V2: "invoiceable", V3: "invoiceable", V4: "invoiceable" };
    const ev = bindEvidence(rb, [p]).evidence;
    expect(["V1", "V2", "V3", "V4"].map((v) => cellStatus(ev, 0, v))).toEqual(["confirmed", "confirmed", "ungrounded", "ungrounded"]);
  });
});

describe("a table that prints two costs before its visits", () => {
  it("takes as the unit price the one its own visit cells print, wherever the unit column's header is", async () => {
    // "Cost" heads the right-hand column too (cost with overhead): the row's visit cells print the left one
    const p = asOcr(await page([[X.name, 100, "Procedure"], [160, 100, "Cost"], [X.unit, 100, "Cost with OH"], [X.c1, 100, "V1"], [X.c2, 100, "V2"], [X.c3, 100, "V3"], [X.name, 120, "Imaging"], [160, 120, "400.00"], [X.unit, 120, "532.00"], [X.c1, 120, "400.00"], [X.c3, 120, "400.00"]]));
    const rb = grid([["V1", "Screening"], ["V2", "Week 2"], ["V3", "Week 4"]], [["Imaging", 400, { V1: 400, V3: 400 }]]);
    const unit = () => bindEvidence(rb, [p]).evidence.find((e) => e.path === "/budgetGrids/0/procedures/0/unitCents")?.status;
    expect(unit()).toBe("confirmed");
    rb.budgetGrids[0]!.procedures[0]!.unitCents = 53200;
    expect(unit()).toBe("conflict");
  });
});

/**
 * A table's drawn grid (TextPage.grids): rows lined up with the read's rows by what they print, visits by their columns'
 * headers. Built straight as a TextPage (our OCR's words and a ruled table), upright (dir 0) or sideways (dir 3, text
 * reading bottom to top). Row names are printed differently from the read's on purpose: only the grid path can then find them.
 */
type Printed = string | [text: string, conf: number] | null;
const U = [40, 160, 220, 280, 340, 400, 460];
const V0 = 80;
const RH = 20;

function drawn(table: Printed[][], dir: 0 | 3 = 0, source: TextPage["source"] = "ocr", cut: number[] = [], skew = 0): TextPage {
  const words: TextPage["words"] = [];
  table.forEach((row, r) =>
    row.forEach((c, k) => {
      if (!c) return;
      const [text, conf] = typeof c === "string" ? [c, 0.99] : c;
      let u = U[k]! + 4;
      for (const t of text.split(" ")) {
        const [u0, u1, v0, v1] = [u, u + 5 * t.length, V0 + RH * r + 5, V0 + RH * r + 15];
        // sideways: the reading frame's u runs up the page (y = 700 - u), v across it (x)
        const rect: TextPage["words"][number]["rect"] = dir === 0 ? [u0, v0, u1, v1] : [v0, 700 - u1, v1, 700 - u0];
        words.push({ text: t, rect, dir, block: words.length, line: words.length, hidden: false, conf });
        u = u1 + 4;
      }
    }),
  );
  const ys = table.map((_, r) => V0 + RH * r).concat(V0 + RH * table.length);
  // `cut`: rows where the table is drawn as a new piece (a header strip, a body in two); `skew` moves the first piece's column rules
  const ends = [0, ...cut, table.length];
  const grids = ends.slice(1).map((end, i) => {
    const [seg, us] = [ys.slice(ends[i]!, end + 1), U.map((u) => u + (i === 0 ? skew : 0))];
    const rules = dir === 0 ? { xs: us, ys: seg } : { xs: seg, ys: us.map((u) => 700 - u).reverse() };
    return { box: [Math.min(...rules.xs), Math.min(...rules.ys), Math.max(...rules.xs), Math.max(...rules.ys)] as [number, number, number, number], ...rules };
  });
  return { documentId: "d1", page: 1, width: 612, height: 792, source, words, hidden: 0, largePicture: false, grids };
}

const HEAD: Printed[] = ["Procedure", "Cost", "Week 4", "Week 8", "Week 12", "Total"];
const TABLE: Printed[][] = [
  HEAD,
  ["Venipuncture", "100.00", "100.00", "200.00", "300.00", "600.00"],
  ["ECG tracing", "50.00", "50.00", null, "150.00", "200.00"],
  ["Urine screen", "25.00", null, "25.00", "25.00", "50.00"],
];
const VISITS: [string, string][] = [["T4", "Week 4"], ["T8", "Week 8"], ["T12", "Week 12"]];
const read = (): Rulebook =>
  grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }], ["Electrocardiogram", 50, { T4: 50, T12: 150 }], ["Urinalysis", 25, { T8: 25, T12: 25 }]]);
const bind = (rb: Rulebook, p: TextPage) => bindEvidence(rb, [p]).evidence;
const statuses = (ev: ValueEvidence[], row: number, visits: string[]) => visits.map((v) => cellStatus(ev, row, v));
const unit = (ev: ValueEvidence[], row: number) => ev.find((e) => e.path === `/budgetGrids/0/procedures/${row}/unitCents`)?.status;

describe.each([0, 3] as const)("the drawn grid, text reading direction %i", (dir) => {
  const page = (t: Printed[][] = TABLE) => drawn(t, dir);

  it("confirms a clean table, rows the read worded differently included", () => {
    const ev = bind(read(), page());
    expect(statuses(ev, 0, ["T4", "T8", "T12"])).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(statuses(ev, 1, ["T4", "T12"])).toEqual(["confirmed", "confirmed"]);
    expect(statuses(ev, 2, ["T8", "T12"])).toEqual(["confirmed", "confirmed"]);
    expect([0, 1, 2].map((r) => unit(ev, r))).toEqual(["confirmed", "confirmed", "confirmed"]);
    // without the drawn grid the label path can't find those rows: it is the grid that did it
    expect(cellStatus(bind(read(), { ...page(), grids: undefined }), 0, "T8")).not.toBe("confirmed");
  });

  it("never confirms a one-digit change in any cell", () => {
    for (const [row, visit] of [[0, "T4"], [0, "T8"], [0, "T12"], [1, "T4"], [1, "T12"], [2, "T8"], [2, "T12"]] as const) {
      for (const d of [10, -10, 1, -1, 100, 1000]) {
        const rb = read();
        const cells = rb.budgetGrids[0]!.procedures[row]!.cells;
        cells[visit] = (cells[visit] as number) + d * 100;
        expect(cellStatus(bind(rb, page()), row, visit)).not.toBe("confirmed");
      }
    }
  });

  it("never confirms a price moved to the neighbouring visit where the row prints nothing", () => {
    const rb = read();
    rb.budgetGrids[0]!.procedures[1]!.cells = { T8: 5000, T12: 15000 };
    const ev = bind(rb, page());
    expect(cellStatus(ev, 1, "T8")).not.toBe("confirmed");
    // a price at the visit before the printed one, and the printed one left out, is the same mistake
    const early = read();
    early.budgetGrids[0]!.procedures[2]!.cells = { T4: 2500, T8: 2500 };
    expect(cellStatus(bind(early, page()), 2, "T4")).not.toBe("confirmed");
  });

  it("never confirms a whole row shifted one visit over", () => {
    const rb = read();
    rb.budgetGrids[0]!.procedures[0]!.cells = { T8: 10000, T12: 20000 };
    expect(statuses(bind(rb, page()), 0, ["T8", "T12"])).not.toContain("confirmed");
  });

  it("never confirms two rows whose prices were swapped", () => {
    const rb = grid(VISITS, [["Blood draw", 40, { T4: 40, T8: 80, T12: 90 }], ["Physical exam", 100, { T4: 100, T8: 200, T12: 300 }]]);
    const table: Printed[][] = [HEAD, ["Blood draw", "100.00", "100.00", "200.00", "300.00", "600.00"], ["Physical exam", "40.00", "40.00", "80.00", "90.00", "210.00"]];
    const ev = bind(rb, page(table));
    expect([...statuses(ev, 0, ["T4", "T8", "T12"]), ...statuses(ev, 1, ["T4", "T8", "T12"])]).not.toContain("confirmed");
  });

  it("falls back when the read's visits are one fewer or one more than the grid's visit columns", () => {
    const table: Printed[][] = [["Procedure", "Cost", "Visit 1", "Visit 2", "Visit 3", "Total"], ["Blood draw", "100.00", "100.00", "200.00", "300.00", "600.00"]];
    // fewer: the read dropped Visit 1, and put the first column's price where Visit 2 is
    const fewer = grid([["V2", "Visit 2"], ["V3", "Visit 3"]], [["Blood draw", 100, { V2: 100, V3: 200 }]]);
    expect(statuses(bind(fewer, page(table)), 0, ["V2", "V3"])).not.toContain("confirmed");
    // more: an extra first visit, and Visit 1 given Visit 2's price
    const more = grid([["S", "Screening"], ["V1", "Visit 1"], ["V2", "Visit 2"], ["V3", "Visit 3"]], [["Blood draw", 100, { V1: 200, V2: 300 }]]);
    expect(statuses(bind(more, page(table)), 0, ["V1", "V2"])).not.toContain("confirmed");
  });

  it("falls back when a header tag contradicts its visit (Week 16 over the Week 12 column)", () => {
    const rb = grid([["T4", "Week 4"], ["T8", "Week 8"], ["T16", "Week 16"]], [["Blood draw", 100, { T4: 100, T8: 200, T16: 300 }]]);
    const ev = bind(rb, page([HEAD, ["Blood draw", "100.00", "100.00", "200.00", "300.00", "600.00"]]));
    expect(cellStatus(ev, 0, "T16")).not.toBe("confirmed");
  });

  it("does not ask about a blank cell the read has no value for", () => {
    const ev = bind(read(), page());
    expect(ev.some((e) => e.path === "/budgetGrids/0/procedures/1/cells/T8" || e.path === "/budgetGrids/0/procedures/2/cells/T4")).toBe(false);
  });

  describe("the row's printed total", () => {
    const row = (t4: Printed, t8: Printed, total = "600.00"): Printed[][] => [HEAD, ["Blood draw", "100.00", t4, t8, "300.00", total]];
    const rb = grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }]]);

    it("confirms the one cell the scan is unsure of when the printed total needs the read's value", () => {
      const ev = bind(rb, page(row("100.00", ["200.00", 0.5])));
      expect(statuses(ev, 0, ["T4", "T8", "T12"])).toEqual(["confirmed", "confirmed", "confirmed"]);
      expect(ev.find((e) => e.path === "/budgetGrids/0/procedures/0/cells/T8")?.note).toMatch(/total confirms it/);
    });

    it("confirms nothing when the total doesn't add up", () => {
      const off = grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 250, T12: 300 }]]);
      expect(cellStatus(bind(off, page(row("100.00", ["250.00", 0.5]))), 0, "T8")).toBe("ungrounded");
    });

    it("confirms nothing when two cells are unconfirmed, though the total adds up", () => {
      const ev = bind(rb, page(row(["100.00", 0.5], ["200.00", 0.5])));
      expect(statuses(ev, 0, ["T4", "T8"])).toEqual(["ungrounded", "ungrounded"]);
      // nor when the total happens to equal the confirmed cell plus either one of them
      const other = bind(rb, page(row(["100.00", 0.5], ["200.00", 0.5], "500.00")));
      expect(statuses(other, 0, ["T4", "T8"])).toEqual(["ungrounded", "ungrounded"]);
    });

    it("confirms nothing when the cell the read left out prints something", () => {
      const left = grid(VISITS, [["Blood draw", 100, { T8: 200, T12: 300 }]]);
      expect(cellStatus(bind(left, page(row("100.00", ["200.00", 0.5], "500.00"))), 0, "T8")).toBe("ungrounded");
    });
  });
});

/**
 * The same planted errors over tables the plain grid path can't read: prices without cents ("150", "45.5") and a table
 * drawn in pieces (its header strip apart from the body, the body in two). The row names the read uses differ from the
 * page's, so only the grid path finds them.
 */
const WHOLE: Printed[][] = [
  HEAD,
  ["Venipuncture", "100", "100", "200", "300", "600"],
  ["ECG tracing", "45.5", "45.5", null, "136.5", "182"],
  ["Urine screen", "25", null, "25", "25", "50"],
];
const layouts: { name: string; table: Printed[][]; cut?: number[] }[] = [
  { name: "prices without cents", table: WHOLE },
  { name: "a header strip drawn apart from the body", table: TABLE, cut: [1] },
  { name: "a body drawn in two pieces", table: TABLE, cut: [2] },
  { name: "whole-dollar prices in a table drawn in three pieces", table: WHOLE, cut: [1, 3] },
];
const dollars = (c: Printed) => (c === null ? null : Number(typeof c === "string" ? c : c[0]));
const VISIT_CODES = ["T4", "T8", "T12"];
const rowOf = (r: Printed[]): [number, Record<string, number>] => [dollars(r[1]!)!, Object.fromEntries(VISIT_CODES.flatMap((v, k) => (dollars(r[2 + k]!) === null ? [] : [[v, dollars(r[2 + k]!)!]])))];

describe.each(layouts)("$name", ({ table, cut }) => {
  const dollarRead = (): Rulebook => grid(VISITS, table.slice(1).map((r, i): [string, number, Record<string, number>] => [["Blood draw", "Electrocardiogram", "Urinalysis"][i]!, ...rowOf(r)]));
  const cases = [[0, "T4"], [0, "T8"], [0, "T12"], [1, "T4"], [1, "T12"], [2, "T8"], [2, "T12"]] as const;
  const cellsOf = (rb: Rulebook, row: number) => rb.budgetGrids[0]!.procedures[row]!.cells;

  describe.each([0, 3] as const)("text reading direction %i", (dir) => {
    const page = (t: Printed[][] = table, c = cut) => drawn(t, dir, "ocr", c);

    it("confirms every cell and unit price of a clean table", () => {
      const ev = bind(dollarRead(), page());
      for (const [row, visit] of cases) expect(cellStatus(ev, row, visit)).toBe("confirmed");
      expect([0, 1, 2].map((r) => unit(ev, r))).toEqual(["confirmed", "confirmed", "confirmed"]);
      // outside a drawn table the page's whole-number prices still prove nothing
      expect(cellStatus(bind(dollarRead(), { ...page(), grids: undefined }), 0, "T8")).not.toBe("confirmed");
    });

    it("never confirms a one-digit change in any cell", () => {
      for (const [row, visit] of cases)
        for (const d of [10, -10, 1, -1, 100, 1000]) {
          const rb = dollarRead();
          cellsOf(rb, row)[visit] = (cellsOf(rb, row)[visit] as number) + d * 100;
          expect(cellStatus(bind(rb, page()), row, visit)).not.toBe("confirmed");
        }
      // a decimal point moved ("45.5" read as 455.0, or 4.55)
      for (const wrong of [455, 4.55]) {
        const rb = dollarRead();
        cellsOf(rb, 1).T4 = Math.round(wrong * 100);
        expect(cellStatus(bind(rb, page()), 1, "T4")).not.toBe("confirmed");
      }
    });

    it("never confirms a price moved to a neighbouring visit where the row prints nothing", () => {
      const rb = dollarRead();
      rb.budgetGrids[0]!.procedures[1]!.cells = { T8: rowOf(table[2]!)[1].T4! * 100, T12: rowOf(table[2]!)[1].T12! * 100 };
      expect(cellStatus(bind(rb, page()), 1, "T8")).not.toBe("confirmed");
      const early = dollarRead();
      early.budgetGrids[0]!.procedures[2]!.cells = { T4: rowOf(table[3]!)[1].T8! * 100, T8: rowOf(table[3]!)[1].T8! * 100 };
      expect(cellStatus(bind(early, page()), 2, "T4")).not.toBe("confirmed");
    });

    it("never confirms a whole row shifted one visit over", () => {
      const rb = dollarRead();
      const row = cellsOf(rb, 0);
      rb.budgetGrids[0]!.procedures[0]!.cells = { T8: row.T4!, T12: row.T8! };
      expect(statuses(bind(rb, page()), 0, ["T8", "T12"])).not.toContain("confirmed");
    });

    it("never confirms two rows whose prices were swapped", () => {
      const [a, b] = [table[1]!, table[2]!];
      const rb = grid(VISITS, [[String(a[0]), ...rowOf(b)], [String(b[0]), ...rowOf(a)]]);
      const ev = bind(rb, page([HEAD, a, b], cut?.filter((c) => c < 3)));
      expect([...statuses(ev, 0, VISIT_CODES), ...statuses(ev, 1, VISIT_CODES)]).not.toContain("confirmed");
    });
  });
});

describe("a table drawn in pieces", () => {
  const read = (): Rulebook => grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }]]);

  it("is one table only where the pieces share their column rules", () => {
    expect(cellStatus(bind(read(), drawn(TABLE, 0, "ocr", [1])), 0, "T8")).toBe("confirmed");
    // the header strip's columns don't line up with the body's: its words are in no column of the body
    expect(cellStatus(bind(read(), drawn(TABLE, 0, "ocr", [1], 12)), 0, "T8")).not.toBe("confirmed");
  });
});

describe("a row the prices fit only by chance", () => {
  const same: Printed[][] = [HEAD, ["Venipuncture", "100", "100", "100", "100", "300"]];

  it("is no match when the row prints a price at a visit the read leaves empty and its label isn't the read's", () => {
    const rb = grid(VISITS, [["Physical exam", 100, { T4: 100, T12: 100 }]]);
    expect(statuses(bind(rb, drawn(same)), 0, ["T4", "T12"])).not.toContain("confirmed");
    // the label vouching for it makes it the row
    const named = grid(VISITS, [["Venipuncture", 100, { T4: 100, T12: 100 }]]);
    expect(cellStatus(bind(named, drawn(same)), 0, "T4")).not.toBe("conflict");
  });

  it("is no match when a value the read has sits on a blank cell", () => {
    const rb = grid(VISITS, [["Physical exam", 100, { T4: 100, T8: 100 }]]);
    expect(statuses(bind(rb, drawn([HEAD, ["Venipuncture", "100", "100", null, "100", "200"]])), 0, ["T4", "T8"])).not.toContain("confirmed");
  });
});

/**
 * A held mapping: the table's columns line up with the read's visits by count and order, but its headers don't say which
 * is which. Every check still applies; what would be confirmed is held by one table check, and a person says which visit
 * each column is. Headers here name no visit ("Alpha"), so only the count and order can map them.
 */
describe.each([0, 3] as const)("a held mapping, text reading direction %i", (dir) => {
  const NAMELESS: Printed[] = ["Procedure", "Cost", "Alpha", "Beta", "Gamma"];
  const body: Printed[][] = [["Venipuncture", "100.00", "100.00", "200.00", "300.00"], ["ECG tracing", "50.00", "50.00", null, "150.00"]];
  const rb = (): Rulebook => grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }], ["Electrocardiogram", 50, { T4: 50, T12: 150 }]]);
  const heldOf = (ev: ValueEvidence[], row: number, visit: string) => ev.find((e) => e.path === `/budgetGrids/0/procedures/${row}/cells/${visit}`)?.held;
  const cell = (ev: ValueEvidence[], row: number, visit: string) => ev.find((e) => e.path === `/budgetGrids/0/procedures/${row}/cells/${visit}`);

  it("headers that don't match: the cells are held, never confirmed, and there is one table check", () => {
    const { evidence: ev, tableChecks } = bindEvidence(rb(), [drawn([NAMELESS, ...body], dir)]);
    expect(tableChecks).toHaveLength(1);
    expect(tableChecks[0]!.columns.map((c) => c.visit)).toEqual(["T4", "T8", "T12"]);
    expect(tableChecks[0]).toMatchObject({ grid: 0, page: 1 });
    for (const [row, visit] of [[0, "T4"], [0, "T8"], [0, "T12"], [1, "T4"], [1, "T12"]] as const) {
      expect(heldOf(ev, row, visit)).toBe(tableChecks[0]!.id);
      // not confirmed, and not showing what the page prints
      expect(cell(ev, row, visit)).toMatchObject({ status: "ungrounded", printed: null });
    }
    expect(ev.find((e) => e.path === "/budgetGrids/0/procedures/0/unitCents")?.held).toBe(tableChecks[0]!.id);
    // the same table with headers that do say the visits is simply confirmed
    const named = bindEvidence(rb(), [drawn(TABLE.slice(0, 3), dir)]);
    expect(named.tableChecks).toEqual([]);
    expect(cell(named.evidence, 0, "T8")).toMatchObject({ status: "confirmed" });
  });

  it("no question of its own for a held cell: one placeholder for the table", () => {
    const { evidence, tableChecks } = bindEvidence(rb(), [drawn([NAMELESS, ...body], dir)]);
    const items = reviewFromEvidence(evidence, [], rb(), tableChecks);
    expect(items.filter((i) => i.reason === "TABLE_CHECK")).toHaveLength(1);
    expect(items.find((i) => i.reason === "TABLE_CHECK")).toMatchObject({ path: null, where: [tableChecks[0]!.table], blocking: true });
    expect(items.filter((i) => i.path?.startsWith("/budgetGrids/0/procedures/"))).toEqual([]);
  });

  it("a count that doesn't line up is not held", () => {
    // the read has a fourth visit the table has no column for
    const more = grid([...VISITS, ["T16", "Week 16"]], [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }], ["Electrocardiogram", 50, { T4: 50, T12: 150 }]]);
    const r = bindEvidence(more, [drawn([NAMELESS, ...body], dir)]);
    expect(r.tableChecks).toEqual([]);
    expect(r.evidence.some((e) => e.held)).toBe(false);
    // fewer
    const fewer = grid(VISITS.slice(0, 2), [["Blood draw", 100, { T4: 100, T8: 200 }], ["Electrocardiogram", 50, { T4: 50 }]]);
    expect(bindEvidence(fewer, [drawn([NAMELESS, ...body], dir)]).tableChecks).toEqual([]);
  });

  it("a planted digit in a held cell is not held", () => {
    for (const [row, visit] of [[0, "T4"], [0, "T8"], [0, "T12"], [1, "T4"], [1, "T12"]] as const)
      for (const d of [10, -10, 1, -1, 100, 1000]) {
        const bad = rb();
        const cells = bad.budgetGrids[0]!.procedures[row]!.cells;
        cells[visit] = (cells[visit] as number) + d * 100;
        const { evidence } = bindEvidence(bad, [drawn([NAMELESS, ...body], dir)]);
        expect(heldOf(evidence, row, visit)).toBeUndefined();
        expect(cell(evidence, row, visit)?.status).not.toBe("confirmed");
      }
  });

  it("a visit's cell read one column over is not held", () => {
    const shifted = rb();
    shifted.budgetGrids[0]!.procedures[0]!.cells = { T8: 10000, T12: 20000 };
    const ev = bindEvidence(shifted, [drawn([NAMELESS, ...body], dir)]).evidence;
    expect(heldOf(ev, 0, "T8")).toBeUndefined();
    expect(heldOf(ev, 0, "T12")).toBeUndefined();
  });

  describe("a continuation page that prints no header", () => {
    const more: Printed[][] = [["Tracing", "50.00", "50.00", null, "150.00"], ["Screen", "25.00", null, "25.00", "25.00"]];
    const two = (): Rulebook => {
      const r = grid(VISITS, [["Blood draw", 100, { T4: 100, T8: 200, T12: 300 }], ["Electrocardiogram", 50, { T4: 50, T12: 150 }], ["Urinalysis", 25, { T8: 25, T12: 25 }]]);
      for (const i of [1, 2]) r.budgetGrids[0]!.procedures[i]!.prov = { ...on, source: { documentId: "d1", page: 2 } };
      return r;
    };
    const first = (): TextPage => drawn([NAMELESS, ...body.slice(0, 1)], dir);
    const second = (skew = 0): TextPage => ({ ...drawn(more, dir, "ocr", [], skew), page: 2 });

    it("rides on the same check when its column rules line up with the header page's", () => {
      const { evidence, tableChecks } = bindEvidence(two(), [first(), second()]);
      expect(tableChecks).toHaveLength(1);
      expect(heldOf(evidence, 2, "T8")).toBe(tableChecks[0]!.id);
      expect(heldOf(evidence, 0, "T8")).toBe(tableChecks[0]!.id);
    });

    it("has its own check when its columns sit elsewhere", () => {
      const { evidence, tableChecks } = bindEvidence(two(), [first(), second(10)]);
      expect(tableChecks).toHaveLength(2);
      expect(heldOf(evidence, 2, "T8")).toBe(tableChecks[1]!.id);
      expect(heldOf(evidence, 0, "T8")).toBe(tableChecks[0]!.id);
      expect(tableChecks[1]).toMatchObject({ page: 2 });
    });

    it("confirms an invoiceable cell only by the word, since the page has no header of its own", () => {
      const r = two();
      r.budgetGrids[0]!.procedures[2]!.cells = { T8: "invoiceable", T12: 2500 };
      const ev = bindEvidence(r, [first(), second()]).evidence;
      expect(heldOf(ev, 2, "T8")).toBeUndefined();
      expect(heldOf(ev, 2, "T12")).toBeDefined();
    });
  });
});
