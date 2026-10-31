import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { CONFIG, extractWith } from "../src/extract";
import { readTextGrids } from "../src/gridtext";
import type { LlmClient, LlmRequest } from "../src/llm";
import type { AiTerms } from "../src/prompts";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// ADR-003 P2: budget grids read by code from a PDF's own text. A synthetic budget, printed with mupdf: no real contract.

const X = { code: 40, name: 85, qty: 250, oh: 285, unit: 320, v: [380, 440, 500] };
type Line = [label: string, code: string, qty: string, oh: string, unit: string, cells: string[]];
const HEAD = (section: string): Line => [section, "Code", "Qty", "OH", "Budget", ["V1", "V2", "V3"]];
/** Whole dollars; each row's cells add up to quantity × unit price, and each visit's sums close. */
const BUDGET: (Line | "sum")[] = [
  HEAD("Procedure"),
  ["Blood draw", "99000", "3", "X", "55", ["55", "55", "55"]],
  ["Biomarkers, collection", "T0299", "4", "X", "81", ["162", "", "162"]],
  ["Procedures Sub Total", "", "", "", "", ["$217", "$55", "$217"]],
  HEAD("Non Procedure"),
  ["Coordinator visit", "NP021", "3", "X", "150", ["150", "150", "150"]],
  ["Non Procedures Sub Total", "", "", "", "", ["$150", "$150", "$150"]],
  ["Overhead (all costs) 40%", "", "", "", "", ["$147", "$82", "$147"]],
  ["Total Cost Per Visit", "", "", "", "", ["$514", "$287", "$514"]],
  ["Total Cost Per Patient", "", "", "", "", ["$1,315", "", ""]],
];

function budgetPdf(lines = BUDGET, extraPage = false): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const at = (x: number, y: number, t: string) => (t ? `BT /F1 8 Tf ${x} ${y} Td (${t}) Tj ET\n` : "");
  let c = at(40, 760, "Attachment A to the work order: study budget") + at(40, 748, "Amounts are in US dollars and are paid per completed visit as set out below.");
  lines.forEach((l, i) => {
    if (l === "sum") return;
    const [label, code, qty, oh, unit, cells] = l;
    const y = 720 - 16 * i;
    c += at(X.code, y, code) + at(X.name, y, label) + at(X.qty, y, qty) + at(X.oh, y, oh) + at(X.unit, y, unit) + cells.map((v, k) => at(X.v[k]!, y, v)).join("");
  });
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, c));
  if (extraPage) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, at(40, 700, "The site is paid within forty five days of an accepted invoice, and the sponsor keeps no holdback on any payment.")));
  const path = join(mkdtempSync(join(tmpdir(), "dct-gridtext-")), "budget.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

describe("readTextGrids", () => {
  it("reads the grid exactly from the page's text, and its own arithmetic closes", async () => {
    const [g] = readTextGrids(await readTextLayer(budgetPdf(), "d"), "d");
    expect(g!.failed).toEqual([]);
    expect(g!.checked).toBeGreaterThanOrEqual(3 + 3 * 3 + 1);
    expect(g!.grid.visits.map((v) => [v.code, v.procedureSubtotalCents, v.nonProcedureCents, v.overheadCents, v.totalCents])).toEqual([
      ["V1", 21700, 15000, 14700, 51400],
      ["V2", 5500, 15000, 8200, 28700],
      ["V3", 21700, 15000, 14700, 51400],
    ]);
    expect(g!.grid.procedures.map((p) => [p.code, p.name, p.unitCents, p.category, p.overheadApplied, p.cells])).toEqual([
      ["99000", "Blood draw", 5500, "procedure", true, { V1: 5500, V2: 5500, V3: 5500 }],
      ["T0299", "Biomarkers, collection", 8100, "procedure", true, { V1: 16200, V3: 16200 }],
      ["NP021", "Coordinator visit", 15000, "non_procedure", true, { V1: 15000, V2: 15000, V3: 15000 }],
    ]);
    expect(g!.qty).toEqual([3, 4, 3]); // a quantity that counts units: the second row's 4 is two cells of two
    expect([g!.grid.statedOverheadPct, g!.grid.perPatientTotals.map((t) => t.cents)]).toEqual([40, [131500]]);
    expect(g!.grid.procedures.every((p) => p.prov.method === "text" && p.prov.source?.page === 1)).toBe(true);
  });

  it("a figure that doesn't add up is said, so the grid is never used as read", async () => {
    const wrong = BUDGET.map((l) => (l !== "sum" && l[0] === "Total Cost Per Visit" ? ([...l.slice(0, 5), ["$514", "$288", "$514"]] as Line) : l));
    expect(readTextGrids(await readTextLayer(budgetPdf(wrong), "d"), "d")[0]!.failed).toEqual(["visit 2: subtotals + overhead ≠ total", "visit totals ≠ per-patient total"]);
    const row = BUDGET.map((l) => (l !== "sum" && l[1] === "T0299" ? ([...l.slice(0, 5), ["162", "81", "162"]] as Line) : l));
    expect(readTextGrids(await readTextLayer(budgetPdf(row), "d"), "d")[0]!.failed).toEqual(expect.arrayContaining(["row 2: cells ≠ quantity × unit price"]));
  });

  it("a table with no unit price column is no grid: the model's read is kept", async () => {
    const noUnit = BUDGET.map((l) => (l === "sum" ? l : ([l[0], l[1], l[2], l[3], "", l[5]] as Line)));
    expect(readTextGrids(await readTextLayer(budgetPdf(noUnit), "d"), "d")).toEqual([]);
  });
});

describe("in a read (extractWith)", () => {
  /** The terms from the synthetic rulebook; the classifier calls page 1 a grid; the grid read is counted, never needed. */
  function mock(rb: Rulebook, calls: string[]): LlmClient {
    return {
      provider: "anthropic",
      model: "mock",
      cost: () => ({ provider: "anthropic", model: "mock", inputTokens: 0, outputTokens: 0, usd: 0 }),
      async call<T>(req: LlmRequest<T>): Promise<T> {
        calls.push(req.name);
        const { schemaVersion: _s, budgetGrids: _b, governingGridId: _g, ...t } = rb;
        const out =
          req.name === "classify" ? { pages: [{ page: 1, kind: "budget_grid", readable: true, rotation: 0, gridGroup: "A" }, { page: 2, kind: "terms", readable: true, rotation: 0, gridGroup: null }] }
          : req.name.startsWith("terms") ? ({ ...t, notes: [] } satisfies AiTerms)
          : { grids: [] };
        return req.schema.parse(out);
      },
    };
  }

  it("a native grid that closes is the read's, and no image of its page goes to a model", async () => {
    const saved = CONFIG.maxUsd;
    CONFIG.maxUsd = 100;
    try {
      const calls: string[] = [];
      const out = await extractWith({ documents: [{ id: "d1", filename: "budget.pdf", path: budgetPdf(BUDGET, true), kind: null }] }, { primary: mock(makeRulebook(), calls), cross: null });
      expect(calls).not.toContain("grid");
      expect(out.gridsFromText).toBe(1);
      expect(out.rulebook.budgetGrids.map((g) => [g.id, g.procedures.length, g.procedures[0]!.prov.method])).toEqual([["t1", 3, "text"]]);
    } finally {
      CONFIG.maxUsd = saved;
    }
  });
});
