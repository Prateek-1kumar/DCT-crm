import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { reviewFromEvidence } from "../src/binder";
import { runContractChecks } from "../src/checks";
import { centsOf, inventory, readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// Regressions for the review findings of 2026-10-29 that live in the extraction package: each failed before its fix.

/** A one-page text PDF of these lines ([y from the top, text]), 8 pt type, read back. */
async function textPdf(lines: [number, string][]) {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const filler: [number, string][] = [
    [600, "This page continues the agreement between the parties and the site, as set out above in full detail."],
    [620, "A second ordinary line of words keeps this page well above the threshold for a real text layer."],
  ];
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, [...lines, ...filler].map(([y, t]) => `BT /F1 8 Tf 40 ${792 - y} Td (${t}) Tj ET\n`).join("")));
  const file = join(mkdtempSync(join(tmpdir(), "dct-findings-")), "page.pdf");
  writeFileSync(file, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(file, "d1");
}

describe("2. a money term's sentence over two lines", () => {
  it("keeps where each of its lines is printed, so blind entry can check them all (`quoted`)", async () => {
    const pages = await textPdf([
      [80, "The Administrative fee is due within 45 days of study initiation, and late"],
      [92, "payments by the Sponsor accrue interest at 1.5% per month until they are paid."],
    ]);
    const pct = inventory(pages).find((s) => s.kind === "percent")!;
    expect(pct.lines).toHaveLength(2);
    expect(pct.lines[0]!.box![1]).toBeLessThan(pct.where.box![1]); // the sentence's first line is above the figure's
    const [term] = reviewFromEvidence([], [pct], makeRulebook());
    expect(term!.quoted).toEqual(pct.lines);
  });
});

describe("8. one reading of amounts (parseCents, @dct/shared)", () => {
  it("centsOf is it, with the word before deciding a bracket", () => {
    expect([centsOf("(1,500.00)"), centsOf("($3,000.00)", "Dollars"), centsOf("($500.00"), centsOf("$7,455.00"), centsOf("0.585")]).toEqual([-150000, 300000, 50000, 745500, null]);
  });
});

describe("9. two grids for one arm", () => {
  it("that agree on every total but price a procedure differently are a GRID_CONFLICT; identical ones aren't", () => {
    const rb = makeRulebook();
    const copy = structuredClone(rb.budgetGrids[0]!);
    rb.budgetGrids.push({ ...copy, id: "g2", label: "Detailed budget" });
    expect(runContractChecks(rb).map((a) => a.code)).not.toContain("GRID_CONFLICT");
    // $10 moved between the exam and the blood draw at Screening: every total still agrees
    const p = rb.budgetGrids[1]!.procedures;
    p[0]!.cells.V1 = 31000;
    p[1]!.cells.V1 = 19000;
    expect(runContractChecks(rb).filter((x) => x.code === "GRID_CONFLICT").map((x) => x.detail.gridIds)).toEqual([["g1", "g2"]]);
  });
});
