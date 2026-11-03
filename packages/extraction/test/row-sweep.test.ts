import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { gateSweep } from "../src/sweep";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// A fee row printing quantity × unit price = total: once its price is the master's, the row's other figures are that fee's own
// arithmetic and are not asked as money terms the master lacks (`row_arithmetic`, counted). Synthetic PDF only.

const at = (x: number, y: number, s: string) => `BT /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`;
const X = [40, 250, 320, 390, 460];
const ROWS = [
  ["Records retrieval", "25", "$75.00", "$1,875.00"],
  ["Archive handling", "1", "$500.00", "$500.00"],
  ["Courier pickups", "10", "$20.00", "$200.00", "$333.00"],
  ["Lab shipping", "25", "$75.00", "$1,875.00"],
  ["Dry ice", "4", "$60.00", "$240.00"],
];

function pdf(): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const rows = ROWS.map((r, i) => r.map((s, c) => at(X[c]!, 60 + 22 * i, s)).join("")).join("");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, rows + at(40, 700, "This schedule sets out the fees the sponsor pays the site, each billed as the rows above state.") + at(40, 720, "Fees are invoiced monthly and the sponsor pays each invoice in full once the study has started.")));
  const path = join(mkdtempSync(join(tmpdir(), "dct-rowsweep-")), "fees.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

const pages = await readTextLayer(pdf(), "d1");
const prov = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const };
const fee = (name: string, amountCents: number | null): Rulebook["invoiceables"][number] => ({
  code: null, name, amountCents, amountWithOverheadCents: null, basis: "fixed", frequency: "per occurrence", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov,
});

/** Bind these fees, run the sweep as the review does, and say which printed amounts are still asked and what was dropped by row arithmetic. */
function sweep(invoiceables: Rulebook["invoiceables"], siteFees: Rulebook["siteFees"] = []) {
  const rb = makeRulebook();
  rb.budgetGrids = [];
  rb.screenFail = null;
  rb.invoiceables = invoiceables;
  rb.siteFees = siteFees;
  const bound = bindEvidence(rb, pages);
  const { kept, dropped, report } = gateSweep(bound.unaccounted, { evidence: bound.evidence, pages, rb, rows: bound.rows, itemRows: bound.itemRows });
  const text = (s: { words: { text: string }[] }) => s.words.map((w) => w.text).join(" ");
  return {
    asked: kept.filter((s) => s.kind === "amount").map(text),
    arithmetic: dropped.filter((d) => d.reason === "row_arithmetic").map((d) => text(d.span)),
    report,
  };
}

describe("a fee's row arithmetic in the sweep", () => {
  it("a price the master holds consumes the row's total, counted", () => {
    const r = sweep([fee("Dry ice", 6000)]);
    expect(r.arithmetic).toEqual(["$240.00"]);
    expect(r.asked).not.toContain("$240.00");
    expect(r.report.arithmetic).toBe(1);
  });

  it("a row printing 1 × X = X: the second X is the fee's own", () => {
    const r = sweep([fee("Archive handling", 50000)]);
    expect(r.arithmetic).toHaveLength(1);
    expect(r.asked).not.toContain("$500.00");
  });

  it("a second fee on the same line that fits no product stays asked", () => {
    const r = sweep([fee("Courier pickups", 2000)]);
    expect(r.arithmetic).toEqual(["$200.00"]);
    expect(r.asked).toContain("$333.00");
  });

  it("another item's row stays asked: the master's price printed on it too does not consume it", () => {
    // "Lab shipping" prints the same figures as "Records retrieval", but is no fee of the master: its figures are still asked
    const r = sweep([fee("Records retrieval", 7500)]);
    expect(r.asked.filter((s) => s === "$1,875.00")).toHaveLength(1);
    expect(r.asked).toContain("$240.00");
    expect(r.report.arithmetic).toBe(1);
  });

  it("a conflict on the row keeps it asked", () => {
    // the same row read twice: the invoiceable's price is the page's, the site fee of that name says another
    const r = sweep([fee("Records retrieval", 7500)], [{ code: null, name: "Records retrieval", amountCents: 7600, trigger: "one_time", dueDays: null, prov }]);
    expect(r.arithmetic).toEqual([]);
    expect(r.asked).toContain("$1,875.00");
  });
});
