import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewItem, Rulebook, ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence, reviewFromEvidence } from "../src/binder";
import { inventory, readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/** Text at (x, y from the top) on a letter page; `up` draws it reading bottom→top (a sideways grid). */
const at = (x: number, y: number, s: string, opts: { size?: number; up?: boolean; pre?: string } = {}) =>
  `BT ${opts.pre ?? ""} /F1 ${opts.size ?? 8} Tf ${opts.up ? `0 1 -1 0 ${x} ${y} Tm` : `${x} ${792 - y} Td`} (${s}) Tj ET 0 g 0 Tr\n`;

const TERMS = [
  "Sponsor shall pay each invoice within forty-five (45) days of receipt of invoice.",
  "Overhead of 40% applies to all per-patient lines.",
  "Invoices must be submitted no later than 6 months after study close.",
  "Administrative fee $12,000.00 due at study initiation.",
  "Interest of 1.5% per month applies to late payments.",
  "Payee bank ABA routing 021000021, account 123456789.",
  "Lidocaine 2% cream is supplied by the site.",
  "Sponsor may withhold payment for incomplete records.",
  "Courier shipment   $50.00   $70.00   per shipment",
];

/** Grid rows in reading order: [code, name, unit, V1, V2]. */
const GRID = [
  ["Code", "Procedure", "Unit", "V1", "V2"],
  ["99205", "Physical exam", "300.00", "300.00", "300.00"],
  ["36415", "Blood draw", "200.00", "200.00", ""],
  ["VA", "Visual acuity", "55.00", "", "Invoiceable"],
  ["NP008", "Patient stipend", "100.00", "100.00", "100.00"],
  ["", "Procedure subtotal", "", "500.00", "300.00"],
  ["", "Overhead", "", "240.00", "160.00"],
  ["", "Non-procedure subtotal", "", "100.00", "100.00"],
  ["", "Visit total", "", "840.00", "560.00"],
  ["", "Total per patient", "", "$1,400.00", ""],
  ["11111", "Unbilled ECG", "75.00", "75.00", "75.00"],
];
const COLS = [40, 90, 220, 280, 340];
const grid = (up: boolean) => GRID.flatMap((r, i) => r.map((s, c) => (s ? (up ? at(80 + 14 * i, 100 + COLS[c]!, s, { up }) : at(COLS[c]!, 80 + 14 * i, s)) : ""))).join("");

/** 1 terms · 2 grid · 3 sideways grid · 4 hidden text · 5 image only · 6 scanner OCR layer. */
function syntheticPdf(): string {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
  pix.clear(230);
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) }, XObject: { Im1: doc.addImage(new mupdf.Image(pix)) } };
  const image = "q 612 0 0 792 0 0 cm /Im1 Do Q\n";
  const filler = at(40, 760, "This page continues the agreement between the parties and the site, as set out above in full detail.");
  const pages = [
    TERMS.map((t, i) => at(40, 60 + 20 * i, t)).join("") + filler,
    grid(false),
    grid(true),
    at(40, 60, "Hidden amounts follow on this page, which also carries enough ordinary words to count as text.") +
      at(40, 80, "$9,999.00", { pre: "1 1 1 rg" }) +
      at(40, 100, "$8,888.00", { size: 1 }) +
      at(40, 120, "$7,777.00", { pre: "3 Tr" }) +
      at(700, 140, "$6,666.00") +
      filler +
      at(40, 740, "A second ordinary line of words keeps this page well above the threshold for a real text layer."),
    image,
    image +
      [
        "Scanned page text from the scanner's character recognition, drawn invisibly over the image of the page.",
        "Fee $500.00 per visit, recognised from the image and not from the signed characters of the document.",
        "A third line of recognised words, so that the layer is long enough to look like the text of a page.",
      ]
        .map((t, i) => at(40, 60 + 20 * i, t, { pre: "3 Tr" }))
        .join(""),
  ];
  for (const content of pages) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));
  const path = join(mkdtempSync(join(tmpdir(), "dct-evidence-")), "synthetic.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

const pdf = syntheticPdf();
const pages = await readTextLayer(pdf, "d1");

/** makeRulebook() cited to the synthetic PDF: terms on page 1, the grid on `gridPage`. */
function rulebook(gridPage = 2): Rulebook {
  const rb = makeRulebook();
  const on = (page: number, quote?: string) => ({ source: { documentId: "d1", page, ...(quote && { quote }) }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const });
  const g = rb.budgetGrids[0]!;
  g.visits.forEach((v) => (v.prov = on(gridPage)));
  g.procedures.forEach((p) => (p.prov = on(gridPage)));
  g.perPatientTotals = [{ label: "Total per patient", cents: 140000, prov: on(gridPage) }];
  rb.invoiceables = [{ ...rb.invoiceables[0]!, code: null, name: "Courier shipment", amountCents: 5000, amountWithOverheadCents: 7000, prov: on(1) }];
  rb.screenFail = null;
  rb.payment.netDays.prov = on(1, "pay each invoice within forty-five (45) days of receipt of invoice");
  rb.overhead.pct.prov = on(1, "Overhead of 40% applies to all per‑patient lines");
  rb.deadlines[0]!.prov = on(1, "no later than 6 months after study close");
  rb.siteFees[0]!.prov = on(1);
  return rb;
}
const statuses = (ev: ValueEvidence[]) => Object.fromEntries(ev.map((e) => [e.path, e.status]));

describe("readTextLayer", () => {
  it("page sources: text, image only, scanner OCR layer", () => {
    expect(pages.map((p) => p.source)).toEqual(["text", "text", "text", "text", "image_only", "ocr_layer"]);
    expect(pages[0]).toMatchObject({ page: 1, documentId: "d1", width: 612, height: 792 });
  });

  it("word boxes are fractions of the page, in the page's own orientation", () => {
    const w = pages[1]!.words.find((x) => x.text === "Physical")!;
    expect(w.dir).toBe(0);
    expect(w.rect[0] / 612).toBeCloseTo(90 / 612, 2);
    expect(pages[2]!.words.find((x) => x.text === "Physical")!.dir).toBe(3);
  });

  it("white, tiny, invisible and off-page text is hidden and never swept", () => {
    const p = pages[3]!;
    const hidden = p.words.filter((w) => w.hidden).map((w) => w.text);
    expect(hidden.sort()).toEqual(["$6,666.00", "$7,777.00", "$8,888.00", "$9,999.00"]);
    expect(inventory([p]).filter((s) => s.kind === "amount")).toEqual([]);
  });
});

describe("inventory", () => {
  const kinds = (page: number) => inventory(pages).filter((s) => s.where.page === page).map((s) => `${s.kind}:${s.words.map((w) => w.text).join(" ")}`);

  it("money sentences only; drug strengths and bank instructions are left out", () => {
    const k = kinds(1);
    expect(k).toContain("amount:$12,000.00");
    expect(k).toContain("percent:40%");
    expect(k).toContain("percent:1.5%");
    expect(k.some((x) => x.includes("(45) days"))).toBe(true);
    expect(k.some((x) => x.startsWith("absence:Sponsor may withhold"))).toBe(true);
    expect(k.some((x) => x.includes("2%"))).toBe(false);
    expect(k.some((x) => /021000021|123456789/.test(x))).toBe(false);
  });

  it("every number in a table row; nothing from scans or OCR layers", () => {
    expect(kinds(2).filter((x) => x.startsWith("grid_number")).length).toBeGreaterThanOrEqual(20);
    expect(kinds(5)).toEqual([]);
    expect(kinds(6)).toEqual([]);
  });
});

describe("bindEvidence", () => {
  it("confirms each value at its own spot: grid cells, visit rows, fees, % and day rules", () => {
    const { evidence } = bindEvidence(rulebook(), pages);
    expect(evidence.every((e) => ValueEvidence.parse(e))).toBe(true);
    expect(evidence.filter((e) => e.status !== "confirmed").map((e) => e.path)).toEqual([]);
    const cell = evidence.find((e) => e.path === "/budgetGrids/0/procedures/0/cells/V2")!;
    expect(cell.printed).toBe("300.00");
    expect(cell.where[0]!.box![0]).toBeCloseTo(340 / 612, 2);
    expect(evidence.find((e) => e.path === "/payment/netDays/value")!.printed).toBe("(45)");
    expect(evidence.find((e) => e.path === "/budgetGrids/0/procedures/2/cells/V2")!.printed).toBe("Invoiceable");
  });

  it("a misread to an amount printed elsewhere on the page is a conflict, not a match", () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 20000; // 200.00 is printed on the page, in the blood draw row
    rb.budgetGrids[0]!.visits[1]!.totalCents = 84000; // the other visit's total
    const ev = bindEvidence(rb, pages).evidence;
    expect(ev.find((e) => e.path === "/budgetGrids/0/procedures/0/cells/V1")).toMatchObject({ status: "conflict", printed: "300.00" });
    expect(ev.find((e) => e.path === "/budgetGrids/0/visits/1/totalCents")).toMatchObject({ status: "conflict", printed: "560.00" });
  });

  it("two prices on one row are read by position: a swap, or one price read twice, is a conflict", () => {
    const at = (a: number, b: number) => {
      const rb = rulebook();
      Object.assign(rb.invoiceables[0]!, { amountCents: a, amountWithOverheadCents: b });
      const s = statuses(bindEvidence(rb, pages).evidence);
      return [s["/invoiceables/0/amountCents"], s["/invoiceables/0/amountWithOverheadCents"]];
    };
    expect(at(5000, 7000)).toEqual(["confirmed", "confirmed"]);
    expect(at(7000, 5000)).toEqual(["conflict", "conflict"]);
    expect(at(7000, 7000)).toEqual(["conflict", "confirmed"]);
  });

  it("a cell the page leaves blank is a conflict with nothing printed", () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.procedures[1]!.cells.V2 = 20000;
    expect(bindEvidence(rb, pages).evidence.find((e) => e.path === "/budgetGrids/0/procedures/1/cells/V2")).toMatchObject({ status: "conflict", printed: null });
  });

  it("sideways grid: rows and columns in the text's own direction", () => {
    const rb = rulebook(3);
    expect(Object.values(statuses(bindEvidence(rb, pages).evidence)).filter((s) => s !== "confirmed")).toEqual([]);
    rb.budgetGrids[0]!.procedures[3]!.cells.V2 = 10100;
    expect(statuses(bindEvidence(rb, pages).evidence)["/budgetGrids/0/procedures/3/cells/V2"]).toBe("conflict");
  });

  it("rules: the quote must match the page word for word, and hold the value", () => {
    const rb = rulebook();
    rb.payment.netDays.value = 30;
    rb.deadlines[0]!.prov.source!.quote = "no later than six months after study close";
    rb.overhead.pct.value = 4; // "40%" holds a 4 only as part of another number
    const s = statuses(bindEvidence(rb, pages).evidence);
    expect([s["/payment/netDays/value"], s["/deadlines/0/value"], s["/overhead/pct/value"]]).toEqual(["conflict", "ungrounded", "conflict"]);
  });

  it("a wrong page reference is re-pointed when label and amount sit on one line of exactly one other page", () => {
    const rb = rulebook();
    rb.siteFees[0]!.prov.source!.page = 2;
    const fee = bindEvidence(rb, pages).evidence.find((e) => e.path === "/siteFees/0/amountCents")!;
    expect(fee).toMatchObject({ status: "confirmed", note: "page reference corrected from 2 to 1", printed: "$12,000.00" });
    expect(fee.where[0]!.page).toBe(1);
    rb.siteFees[0]!.amountCents = 1300000;
    expect(statuses(bindEvidence(rb, pages).evidence)["/siteFees/0/amountCents"]).toBe("ungrounded");
  });

  it("hidden text and scans confirm nothing", () => {
    const rb = rulebook();
    rb.siteFees[0]!.amountCents = 999900; // printed in white on page 4
    rb.siteFees[0]!.prov.source!.page = 4;
    rb.budgetGrids[0]!.procedures.forEach((p) => (p.prov.source!.page = 5));
    const s = statuses(bindEvidence(rb, pages).evidence);
    expect(s["/siteFees/0/amountCents"]).toBe("ungrounded");
    expect(s["/budgetGrids/0/procedures/0/cells/V1"]).toBe("ungrounded");
  });

  it("unaccounted: inventory spans no value is bound to", () => {
    const { unaccounted } = bindEvidence(rulebook(), pages);
    const got = unaccounted.map((s) => `${s.where.page}:${s.kind}:${s.words.map((w) => w.text).join(" ")}`);
    expect(got.filter((x) => x.startsWith("1:"))).toEqual(["1:percent:1.5%", "1:absence:Sponsor may withhold payment for incomplete records."]);
    // The row the master doesn't hold, every number in it; the counted ones on held rows are bound.
    expect(got.filter((x) => x.startsWith("2:"))).toEqual(["2:grid_number:11111", "2:grid_number:75.00", "2:grid_number:75.00", "2:grid_number:75.00"]);
  });
});

describe("reviewFromEvidence", () => {
  const rb = rulebook();
  rb.budgetGrids[0]!.procedures[0]!.cells.V1 = 20000;
  rb.overhead.pct.prov.source!.quote = "overhead of forty percent";
  const { evidence, unaccounted } = bindEvidence(rb, pages.slice(0, 2));
  const items = reviewFromEvidence(evidence, unaccounted, rb);

  it("blind questions for conflicts and values not found, one item per uncaptured line or sentence", () => {
    for (const i of items) expect(ReviewItem.parse(i)).toEqual(i);
    const confirm = items.filter((i) => i.kind === "confirm_value");
    expect(confirm.map((i) => [i.path, i.reason, i.input, i.question])).toEqual([
      ["/budgetGrids/0/procedures/0/cells/V1", "VALUE_CONFLICT", "money", 'What amount is printed for "Physical exam" at Screening?'],
      ["/overhead/pct/value", "UNGROUNDED_VALUE", "percent", "What overhead percentage does the contract state?"],
    ]);
    expect(confirm[0]!.where[0]!.box).not.toBeNull();
    const terms = items.filter((i) => i.kind === "unaccounted");
    // The 40% its quote no longer binds, the interest %, the withholding sentence, the unbilled row (one item for its 4 numbers).
    expect(terms.map((i) => i.where.length)).toEqual([1, 1, 1, 4]);
    expect(terms[0]!.options.map((o) => o.label)).toEqual(["Add it to the invoicing master", "Keep as a term to bill by hand", "Not a payment term"]);
    expect(terms.every((i) => i.blocking && i.input === null && i.answer === null)).toBe(true);
  });

  it("never shows the reading, and speaks the reviewer's language", () => {
    expect(items.filter((i) => i.kind === "confirm_value").map((i) => i.question).join(" ")).not.toMatch(/200|40/);
    expect(JSON.stringify(items.map((i) => [i.question, i.options]))).not.toMatch(/\bAI\b|anomal|rulebook|extraction/i);
    expect(items.every((i) => i.compare === null && i.outcome === null)).toBe(true);
  });
});

describe.runIf(process.env.DCT_ROOT)("COPD signed original (DCT_ROOT)", () => {
  const root = process.env.DCT_ROOT!;
  const read = () => Rulebook.parse(JSON.parse(readFileSync(join(root, "data/extractions/copd.json"), "utf8")).rulebook);
  let pdfText: ReturnType<typeof readTextLayer> | undefined;
  const copd = () => (pdfText ??= readTextLayer(join(root, "data/contracts/copd-native/WO 116264 - EFC18243 - signed 2025-08-22.pdf"), "copd"));

  it("a single-digit misread of a grid cell is never confirmed", async () => {
    const pages = await copd();
    // Each cell is bound on its own (row by label, column by header), so one pass mutates every cell at once.
    for (const seed of [1, 2, 3]) {
      const rb = read();
      const paths: string[] = [];
      rb.budgetGrids[0]!.procedures.forEach((p, pi) =>
        Object.entries(p.cells).forEach(([k, c], n) => {
          if (typeof c !== "number") return;
          const s = c % 100 ? (c / 100).toFixed(2) : String(c / 100);
          const digits = [...s].flatMap((ch, i) => (/\d/.test(ch) ? [i] : []));
          const i = digits[(pi * 7 + n * 3 + seed) % digits.length]!;
          p.cells[k] = Math.round(Number(s.slice(0, i) + String((Number(s[i]) + seed) % 10) + s.slice(i + 1)) * 100);
          paths.push(`/budgetGrids/0/procedures/${pi}/cells/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
        }),
      );
      const s = statuses(bindEvidence(rb, pages).evidence);
      expect(paths.length).toBeGreaterThan(500);
      expect(paths.filter((p) => s[p] === "confirmed")).toEqual([]);
    }
  });

  it("the admin fee cited on page 4 is re-pointed to page 9", async () => {
    const moved = bindEvidence(read(), await copd()).evidence.filter((e) => e.note?.startsWith("page reference corrected"));
    expect(moved.map((e) => [e.note, e.where[0]!.page, e.status])).toEqual([["page reference corrected from 4 to 9", 9, "confirmed"]]);
  });
});
