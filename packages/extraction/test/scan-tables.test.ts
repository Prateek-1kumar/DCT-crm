import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook, ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
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
