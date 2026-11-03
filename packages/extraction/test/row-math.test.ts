import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROW_ARITHMETIC, type Rulebook, type ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// A fee table's row printing quantity × unit price = total (ADR-001: a value is confirmed only where the page itself says it):
// the row's own arithmetic tells which of its amounts is the price, the total and the quantity, whatever the layout. Synthetic
// PDFs only. And white text on a dark box (a table's header bar) is visible text, while white on white stays hidden.

const at = (x: number, y: number, s: string, pre = "") => `BT ${pre} /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET 0 g\n`;
const X = [40, 250, 320, 390, 460, 530];
/** One printed row per entry: the label, then its cells, far enough apart to be a table's columns. No header anywhere. */
const ROWS: Record<string, string[]> = {
  standard: ["Medical records requests", "25", "75.00", "US$ 1,875.00"],
  totalFirst: ["Courier shipments", "$1,200.00", "16", "$75.00"],
  qtyCents: ["Re-consent visits", "400.00", "$17.50", "$7,000.00"],
  unsure: ["Archive boxes", "400.00", "175.00", "70,000.00"],
  noDollar: ["Chart review hours", "80", "85.00", "6,800.00"],
  overhead: ["Pharmacy dispensing", "10", "100.00", "130.00", "1,300.00"],
  twinA: ["Lab kit shipping", "25", "75.00", "1,875.00"],
  twinB: ["Ice pack shipping", "25", "75.00", "1,875.00"],
  twoWays: ["Visit reminders", "2", "50.00", "100.00", "200.00"],
  noProduct: ["Translation pages", "12", "40.00", "500.00"],
  meals: ["Meals at site meetings", "20", "35.00", "700.00"],
  fraction: ["Pregnancy tests", "1.50", "35.00", "52.50"],
};
const MEALS_RULE = "Meals are reimbursed not to exceed $35.00 per person.";

function pdf(): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const rows = Object.values(ROWS).map((r, i) => r.map((s, c) => at(X[c]!, 60 + 22 * i, s)).join("")).join("");
  const filler = at(40, 700, "This schedule sets out the fees the sponsor pays the site, each billed as the rows above state.") + at(40, 720, MEALS_RULE);
  // a dark header bar with white text on it, white text on the page, and white text on a light box
  const bar = (y: number, rgb: string) => `${rgb} rg 36 ${792 - y - 4} 540 14 re f 0 g\n`;
  const page2 =
    bar(80, "0.09 0.21 0.36") +
    ["Sponsor audit hours", "20", "100.00", "US$ 2,000.00"].map((s, c) => at(X[c]!, 80, s, "1 1 1 rg")).join("") +
    at(40, 120, "$9,999.00", "1 1 1 rg") +
    bar(160, "0.85 0.85 0.85") +
    at(40, 160, "$8,888.00", "1 1 1 rg") +
    at(40, 680, "Each fee on this page is billed on its own invoice, at the rate and up to the total its bar prints.") +
    filler;
  for (const content of [rows + filler, page2]) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));
  const path = join(mkdtempSync(join(tmpdir(), "dct-rowmath-")), "fees.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

const pages = await readTextLayer(pdf(), "d1");
const on = (page: number, quote?: string) => ({ source: { documentId: "d1", page, ...(quote ? { quote } : {}) }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const });
type Inv = Rulebook["invoiceables"][number];
const inv = (name: string, amountCents: number | null, cap: Inv["cap"] = { kind: "none", n: null, ratio: null }, extra: Partial<Inv> = {}): Inv => ({
  code: null, name, amountCents, amountWithOverheadCents: null, basis: "fixed", frequency: "per occurrence", cap, requiresPreApproval: false, requiredDocs: [], prov: on(1), ...extra,
});
const amount = (n: number) => ({ kind: "amount" as const, n, ratio: null });
const count = (n: number) => ({ kind: "count" as const, n, ratio: null });
/** Bind just these invoiceables (and site fees) against the synthetic page; the rest of the rulebook cites no page of it. */
function bind(invoiceables: Inv[], siteFees: Rulebook["siteFees"] = []): Map<string, ValueEvidence> {
  const rb = makeRulebook();
  rb.budgetGrids = [];
  rb.screenFail = null;
  rb.invoiceables = invoiceables;
  rb.siteFees = siteFees;
  return new Map(bindEvidence(rb, pages).evidence.map((e) => [e.path, e]));
}
const of = (ev: Map<string, ValueEvidence>, path: string) => {
  const e = ev.get(path)!;
  return { status: e.status, printed: e.printed, note: e.note };
};
const byRow = (printed: string) => ({ status: "confirmed", printed, note: ROW_ARITHMETIC });

describe("a row's own arithmetic (quantity × unit price = total)", () => {
  it("tells the price, the total and the quantity apart, in any column order, with or without $, the quantity printed 400 or 400.00", () => {
    const ev = bind([
      inv("Medical records requests", 7500, amount(187500)),
      inv("Courier shipments", 7500, amount(120000)),
      inv("Re-consent visits", 1750, count(400)),
      inv("Chart review hours", 8500, count(80)),
    ]);
    expect(of(ev, "/invoiceables/0/amountCents")).toEqual(byRow("75.00"));
    expect(of(ev, "/invoiceables/0/cap/n")).toEqual(byRow("US$ 1,875.00"));
    expect(of(ev, "/invoiceables/1/amountCents")).toEqual(byRow("$75.00"));
    expect(of(ev, "/invoiceables/1/cap/n")).toEqual(byRow("$1,200.00"));
    expect(of(ev, "/invoiceables/2/amountCents")).toEqual(byRow("$17.50"));
    expect(of(ev, "/invoiceables/2/cap/n")).toEqual(byRow("400.00"));
    expect(of(ev, "/invoiceables/3/amountCents")).toEqual(byRow("85.00"));
    expect(of(ev, "/invoiceables/3/cap/n")).toEqual(byRow("80"));
  });

  it("a site fee's price, and a price with overhead when the total is taken on it", () => {
    const ev = bind([inv("Pharmacy dispensing", 13000)], [{ code: null, name: "Chart review hours", amountCents: 8500, trigger: "one_time", dueDays: null, prov: on(1) }]);
    expect(of(ev, "/invoiceables/0/amountCents")).toEqual(byRow("130.00"));
    expect(of(ev, "/siteFees/0/amountCents")).toEqual(byRow("85.00"));
    // the price before overhead is in no product on that row: asked, as before
    expect(of(bind([inv("Pharmacy dispensing", 10000)]), "/invoiceables/0/amountCents")).toMatchObject({ status: "ungrounded", note: expect.stringMatching(/another amount/) });
  });

  it("two rows printing the same figures each confirm on their own row, found by its label", () => {
    const ev = bind([inv("Ice pack shipping", 7500, amount(187500)), inv("Lab kit shipping", 7500, amount(187500))]);
    const row = (path: string) => ev.get(path)!.where[0]!.box![1];
    expect([of(ev, "/invoiceables/0/amountCents").status, of(ev, "/invoiceables/1/amountCents").status]).toEqual(["confirmed", "confirmed"]);
    expect(row("/invoiceables/0/amountCents")).toBeGreaterThan(row("/invoiceables/1/amountCents"));
    expect(row("/invoiceables/0/cap/n")).toBeCloseTo(row("/invoiceables/0/amountCents"), 3);
  });

  it("says nothing when it can't tell: two products fit, a quantity printed like a whole price (or a whole price like a quantity), or no product at all", () => {
    const ev = bind([
      inv("Visit reminders", 5000, amount(10000)),
      inv("Archive boxes", 17500, amount(7000000)),
      inv("Translation pages", 4000, amount(50000)),
      inv("Pregnancy tests", 150, amount(5250)), // 1.50 tests at 35.00: "35.00" fits as the quantity too
    ]);
    for (const i of [0, 1, 2, 3]) {
      expect(of(ev, `/invoiceables/${i}/amountCents`)).toMatchObject({ status: "ungrounded", note: expect.stringMatching(/another amount/) });
      expect(of(ev, `/invoiceables/${i}/cap/n`).status).toBe("ungrounded");
    }
  });

  it("catches planted errors: a price's digits changed, quantity and price swapped, a cap that isn't the row's total", () => {
    const ev = bind([
      inv("Medical records requests", 7600, amount(187500)), // 75.00 printed
      inv("Courier shipments", 1600, count(75)), // the quantity read as the price, the price as the count
      inv("Chart review hours", 8500, amount(680001)), // the total is 6,800.00
      inv("Re-consent visits", 1750, count(40)), // the quantity is 400.00
    ]);
    expect(of(ev, "/invoiceables/0/amountCents").status).toBe("conflict");
    expect(of(ev, "/invoiceables/0/cap/n").status).toBe("ungrounded");
    expect(of(ev, "/invoiceables/1/amountCents").status).toBe("conflict");
    expect(of(ev, "/invoiceables/1/cap/n").status).toBe("ungrounded");
    // a value of the item that disagrees with the row: the row tells nothing about any of them
    for (const i of [2, 3]) {
      expect(of(ev, `/invoiceables/${i}/amountCents`)).toMatchObject({ status: "ungrounded", note: expect.stringMatching(/another amount/) });
      expect(of(ev, `/invoiceables/${i}/cap/n`).status).toBe("ungrounded");
    }
  });

  it("a cap whose quote states another limit stays a conflict", () => {
    const ev = bind([inv("Meals at site meetings", 3500, amount(70000), { prov: on(1, MEALS_RULE) })]);
    expect(of(ev, "/invoiceables/0/amountCents")).toEqual(byRow("35.00"));
    expect(of(ev, "/invoiceables/0/cap/n").status).toBe("conflict");
  });
});

describe("white text", () => {
  it("on a dark box is visible and confirms like any text; on the page or a light box it stays hidden", () => {
    const p = pages[1]!;
    expect(p.words.filter((w) => w.hidden).map((w) => w.text).sort()).toEqual(["$8,888.00", "$9,999.00"]);
    expect(p.words.find((w) => w.text === "2,000.00")!.hidden).toBe(false);
    const ev = bind([inv("Sponsor audit hours", 10000, amount(200000), { prov: on(2) })]);
    expect(of(ev, "/invoiceables/0/amountCents")).toEqual(byRow("100.00"));
    expect(of(ev, "/invoiceables/0/cap/n")).toEqual(byRow("US$ 2,000.00"));
  });
});
