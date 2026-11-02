import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { CONFIG, extractWith } from "../src/extract";
import { readTextGrids } from "../src/gridtext";
import type { LlmClient, LlmRequest } from "../src/llm";
import type { AiTerms } from "../src/prompts";
import { readTextLayer, type TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// The text grid replaces the model's read of its pages, so whatever it drops is lost: a table it can't read whole must fail.
// Synthetic pages only, built word by word: [text, x-centre] per cell, one line per row.

type Cell = [text: string, x: number];
const page = (rows: Cell[][]): TextPage => {
  let n = 0;
  const words = rows.flatMap((r, i) =>
    r.flatMap(([t, x]) => t.split(" ").filter(Boolean).map((s, k) => ({ text: s, rect: [x - 18 + k * 20, 100 + i * 14, x + 2 + k * 20, 108 + i * 14] as [number, number, number, number], dir: 0 as const, block: 0, line: n++, hidden: false }))),
  );
  return { documentId: "d", page: 1, width: 612, height: 792, source: "text", words, hidden: 0, largePicture: false };
};
const L = 40, U = 200, A = 280, B = 340, C = 400;
const read = (rows: Cell[][]) => readTextGrids([page(rows)], "d");

describe("readTextGrids fails a table it can't read whole", () => {
  it("a word in a visit cell ('X', 'as needed') fails the grid, though its sums close without it", () => {
    const rows = (cell: string): Cell[][] => [
      [["Procedure", L], ["Unit", U], ["Screening", A], ["Day1", B], ["Day8", C]],
      [["Exam", L], ["100.00", U], ["100.00", A], [cell, B], ["100.00", C]],
      [["ECG", L], ["50.00", U], ["50.00", A], ["50.00", B], ["50.00", C]],
      [["Subtotal", L], ["150.00", A], ["50.00", B], ["150.00", C]],
      [["Total", L], ["150.00", A], ["50.00", B], ["150.00", C]],
    ];
    expect(read(rows("")).map((g) => g.failed)).toEqual([[]]); // a truly empty cell is just empty
    expect(read(rows("X"))[0]!.failed).toContain("page 1: a visit cell that isn't a price");
    expect(read(rows("as needed"))[0]!.failed).toContain("page 1: a visit cell that isn't a price");
  });

  it("a label wrapped onto its own line, left of the figure columns, is no cell", () => {
    const [g] = read([
      [["Procedure", L], ["Unit", U], ["Screening", A], ["Day1", B], ["Day8", C]],
      [["Physical", L], ["exam,", L + 40]],
      [["full", L], ["100.00", U], ["100.00", A], ["100.00", B], ["100.00", C]],
      [["ECG", L], ["50.00", U], ["50.00", A], ["50.00", B], ["50.00", C]],
      [["Subtotal", L], ["150.00", A], ["150.00", B], ["150.00", C]],
      [["Total", L], ["150.00", A], ["150.00", B], ["150.00", C]],
    ]);
    expect(g!.failed).toEqual([]);
    expect(g!.grid.procedures.map((p) => p.name)).toEqual(["Physical exam, full", "ECG"]);
  });

  it("a column of figures with no header is never left out", () => {
    const [g] = read([
      [["Procedure", L], ["Unit", U], ["Screening", A], ["Day1", B]],
      [["Exam", L], ["100.00", U], ["100.00", A], ["100.00", B], ["100.00", C]],
      [["ECG", L], ["50.00", U], ["50.00", A], ["50.00", B], ["50.00", C]],
      [["Subtotal", L], ["150.00", A], ["150.00", B], ["150.00", C]],
      [["Total", L], ["150.00", A], ["150.00", B], ["150.00", C]],
    ]);
    expect(g!.failed).toContain("page 1: column 4 holds figures that are no quantity, unit price, visit or total");
  });

  it("two visit columns of one name fail, even when their figures are the same", () => {
    const [g] = read([
      [["Procedure", L], ["Unit", U], ["Unscheduled", A], ["Day1", B], ["Unscheduled", C]],
      [["Exam", L], ["100.00", U], ["100.00", A], ["100.00", B], ["100.00", C]],
      [["Subtotal", L], ["100.00", A], ["100.00", B], ["100.00", C]],
      [["Total", L], ["100.00", A], ["100.00", B], ["100.00", C]],
    ]);
    expect(g!.failed).toContain("page 1: two visit columns with one name");
  });

  it("two columns that could each be the unit price fail when no quantity tells them apart", () => {
    const [g] = read([
      [["Procedure", L], ["Unit", U - 60], ["Fee", U], ["Screening", A], ["Day1", B], ["Day8", C]],
      [["Exam", L], ["80.00", U - 60], ["100.00", U], ["100.00", A], ["100.00", B], ["100.00", C]],
      [["ECG", L], ["40.00", U - 60], ["50.00", U], ["50.00", A], ["50.00", B], ["50.00", C]],
      [["Subtotal", L], ["150.00", A], ["150.00", B], ["150.00", C]],
      [["Total", L], ["150.00", A], ["150.00", B], ["150.00", C]],
    ]);
    expect(g!.failed).toContain("page 1: more than one column could be the unit price");
  });

  it("quantity × unit price is compared in whole cents, exactly: no rounding lets a row close", () => {
    const rows = (cell: string): Cell[][] => [
      [["Procedure", L], ["Qty", U - 60], ["Unit", U], ["Screening", A], ["Day1", B], ["Day8", C]],
      [["Exam", L], ["1.5", U - 60], ["0.33", U], [cell, A], ["", B], ["", C]],
      [["ECG", L], ["3", U - 60], ["50.00", U], ["50.00", A], ["50.00", B], ["50.00", C]],
      [["Subtotal", L], [String((Number(cell) + 50).toFixed(2)), A], ["50.00", B], ["50.00", C]],
      [["Total", L], [String((Number(cell) + 50).toFixed(2)), A], ["50.00", B], ["50.00", C]],
    ];
    expect(read(rows("0.50"))[0]!.failed).toEqual(["row 1: cells ≠ quantity × unit price"]); // 1.5 × $0.33 is 49.5 cents
    expect(read(rows("0.50")).map((g) => g.qty)).toEqual([[1.5, 3]]);
  });
});

describe("in a read (extractWith)", () => {
  /** A page with a budget that closes and, below it, a second table (other visits) with a word in a visit cell. */
  function pdf(): string {
    const doc = new mupdf.PDFDocument();
    const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
    const at = (x: number, y: number, t: string) => (t ? `BT /F1 8 Tf ${x} ${y} Td (${t}) Tj ET\n` : "");
    const lines = [
      ["Procedure", "Budget", "V1", "V2", "V3"],
      ["Blood draw", "55", "55", "55", "55"],
      ["Procedures Sub Total", "", "$55", "$55", "$55"],
      ["Total Cost Per Visit", "", "$55", "$55", "$55"],
      ["", "", "", "", ""],
      ["Optional procedure", "Budget", "U1", "U2", "U3"],
      ["Biopsy", "200", "200", "X", "200"],
      ["Procedures Sub Total", "", "$200", "", "$200"],
      ["Total Cost Per Visit", "", "$200", "", "$200"],
    ];
    let c = at(40, 760, "Attachment A to the work order: study budget");
    lines.forEach((l, i) => (c += at(40, 720 - 16 * i, l[0]!) + l.slice(1).map((v, k) => at(320 + 60 * k, 720 - 16 * i, v)).join("")));
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, c));
    const path = join(mkdtempSync(join(tmpdir(), "dct-gridtext-guards-")), "budget.pdf");
    writeFileSync(path, doc.saveToBuffer("").asUint8Array());
    return path;
  }
  function mock(calls: string[]): LlmClient {
    const rb = makeRulebook();
    return {
      provider: "anthropic",
      model: "mock",
      cost: () => ({ provider: "anthropic", model: "mock", inputTokens: 0, outputTokens: 0, usd: 0 }),
      async call<T>(req: LlmRequest<T>): Promise<T> {
        calls.push(req.name);
        const { schemaVersion: _s, budgetGrids: _b, governingGridId: _g, ...t } = rb;
        const out =
          req.name === "classify" ? { pages: [{ page: 1, kind: "budget_grid", readable: true, rotation: 0, gridGroup: "A" }] }
          : req.name.startsWith("terms") ? ({ ...t, notes: [] } satisfies AiTerms)
          : { grids: [] };
        return req.schema.parse(out);
      },
    };
  }

  it("a page a failed table sits on goes to the model, though another grid on it closes", async () => {
    const path = pdf();
    const grids = readTextGrids(await readTextLayer(path, "d1"), "d1");
    expect(grids.map((g) => g.failed.length > 0)).toEqual([false, true]);
    const saved = CONFIG.maxUsd;
    CONFIG.maxUsd = 100;
    try {
      const calls: string[] = [];
      const out = await extractWith({ documents: [{ id: "d1", filename: "budget.pdf", path, kind: null }] }, { primary: mock(calls), cross: null });
      expect(calls).toContain("grid");
      expect(out.gridsFromText).toBe(0);
    } finally {
      CONFIG.maxUsd = saved;
    }
  });
});
