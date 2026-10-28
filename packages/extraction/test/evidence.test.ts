import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewItem, Rulebook, ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { bindEvidence, isoDate, reviewFromEvidence } from "../src/binder";
import { amounts, inventory, readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/** Text at (x, y from the top) on a letter page; `up` draws it reading bottom→top (a sideways grid). */
const at = (x: number, y: number, s: string, opts: { size?: number; up?: boolean; pre?: string } = {}) =>
  `BT ${opts.pre ?? ""} /F1 ${opts.size ?? 8} Tf ${opts.up ? `0 1 -1 0 ${x} ${y} Tm` : `${x} ${792 - y} Td`} (${s}) Tj ET 0 g 0 Tr\n`;

const TERMS = [
  "Sponsor shall pay each invoice within forty-five (45) days of receipt of invoice.",
  "Overhead of 40% applies to all per-patient lines.",
  "Invoices must be submitted no later than 6 months after study close.",
  "Administrative fee $12,000.00 due within 45 days of study initiation.",
  "Interest of 1.5% per month applies to late payments.",
  "Payee bank ABA routing 021000021, account 123456789.",
  "Lidocaine 2% cream is supplied by the site.",
  "Sponsor may withhold payment for incomplete records.",
  "Courier shipment   $50.00   $70.00   per shipment",
  "This Work Order is effective as of August 22, 2025.",
  "The amended rates apply from 01/15/2026 for all visits.",
  "Overpayments will be refunded within thirty (30) days of notice.",
  "Courier costs are reimbursed up to $500.00 per month.",
  "One (1) screen failure is paid for every two (2) randomized subjects, up to a maximum of ten (10).",
  "Sponsor will hold back 10% of each payment until close-out.",
];

/** Grid rows in reading order: [code, name, unit, V1, V2]. */
const GRID = [
  ["Code", "Procedure", "Unit", "V1", "V2"],
  ["99205", "Physical exam", "300.00", "300.00", "300.00"],
  ["36415", "Blood draw", "200.00", "200.00", ""],
  ["VA", "Visual acuity", "55.00", "", "Invoiceable"],
  ["NP008", "Patient stipend", "100.00", "100.00", "100.00"],
  ["", "Procedure subtotal", "", "500.00", "300.00"],
  ["", "Overhead 40%", "", "240.00", "160.00"],
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
  g.prov = on(gridPage);
  g.visits.forEach((v) => (v.prov = on(gridPage)));
  g.procedures.forEach((p) => (p.prov = on(gridPage)));
  g.perPatientTotals = [{ label: "Total per patient", cents: 140000, prov: on(gridPage) }];
  rb.invoiceables = [
    { ...rb.invoiceables[0]!, code: null, name: "Courier shipment", amountCents: 5000, amountWithOverheadCents: 7000, cap: { kind: "amount", n: 50000, ratio: null }, prov: on(1, "Courier costs are reimbursed up to $500.00 per month") },
  ];
  rb.screenFail = { amountCents: null, basis: "per_procedure", cap: { kind: "ratio_to_randomized", n: 10, ratio: 0.5 }, paidVia: "invoice", requiredDocs: [], prov: on(1, "One (1) screen failure is paid for every two (2) randomized subjects, up to a maximum of ten (10)") };
  rb.payment.netDays.prov = on(1, "pay each invoice within forty-five (45) days of receipt of invoice");
  rb.overhead.pct.prov = on(1, "Overhead of 40% applies to all per‑patient lines");
  rb.deadlines[0]!.prov = on(1, "no later than 6 months after study close");
  rb.siteFees[0]!.prov = on(1, "Administrative fee $12,000.00 due within 45 days");
  rb.study.effectiveDate = { value: "2025-08-22", prov: on(1, "effective as of August 22, 2025") };
  rb.appliesFrom = { value: "2026-01-15", prov: on(1, "The amended rates apply from 01/15/2026") };
  rb.overpayment = { refundDays: 30, sponsorMayOffset: false, prov: on(1, "refunded within thirty (30) days of notice") };
  rb.holdback = { pct: 10, appliesTo: "each payment", releaseConditions: ["close-out"], prov: on(1, "hold back 10% of each payment") };
  return rb;
}
const statuses = (ev: ValueEvidence[]) => Object.fromEntries(ev.map((e) => [e.path, e.status]));

/** The value at a JSON pointer, and a copy of the rulebook with another value there. */
const valueAt = (rb: Rulebook, path: string) => path.split("/").slice(1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], rb);
const setValue = (rb: Rulebook, path: string, v: unknown) => {
  const keys = path.split("/").slice(1);
  (keys.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], rb) as Record<string, unknown>)[keys.at(-1)!] = v;
  return rb;
};
const withValue = (rb: Rulebook, path: string, v: unknown) => setValue(structuredClone(rb), path, v);
const realDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
};
/**
 * Every value one printed character away: a digit changed, dropped or added (cents as printed in dollars: 50000 → "500.00").
 * Dates: one digit of the ISO date changed, when that is still a real day.
 */
function nearby(v: number | string, cents = false): (number | string)[] {
  if (typeof v === "string") return [...v].flatMap((ch, i) => (/\d/.test(ch) ? [..."0123456789"].filter((d) => d !== ch).map((d) => v.slice(0, i) + d + v.slice(i + 1)) : [])).filter(realDay);
  const s = cents ? (v / 100).toFixed(2) : String(v);
  const back = (t: string) => (cents ? Math.round(Number(t) * 100) : Number(t));
  const out = new Set<number>();
  for (let i = 0; i <= s.length; i++) {
    const digit = i < s.length && /\d/.test(s[i]!);
    for (const d of "0123456789") {
      out.add(back(s.slice(0, i) + d + s.slice(i)));
      if (digit) out.add(back(s.slice(0, i) + d + s.slice(i + 1)));
    }
    if (digit && s.length > 1) out.add(back(s.slice(0, i) + s.slice(i + 1)));
  }
  out.delete(v);
  return [...out].filter(Number.isFinite);
}

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
    expect(evidence.find((e) => e.path === "/budgetGrids/0/procedures/2/cells/V2")!.printed).toBe("Invoiceable");
    // Rules: the figure of the value's kind in the quote, its number as printed (without the brackets of "forty-five (45)").
    const printed = Object.fromEntries(evidence.filter((e) => !/procedures|visits|perPatient/.test(e.path)).map((e) => [e.path, e.printed]));
    expect(printed).toMatchObject({
      "/payment/netDays/value": "45",
      "/overhead/pct/value": "40%",
      "/budgetGrids/0/statedOverheadPct": "40%",
      "/siteFees/0/dueDays": "45",
      "/overpayment/refundDays": "30",
      "/invoiceables/0/cap/n": "$500.00",
      "/screenFail/cap/n": "10",
      "/screenFail/cap/ratio": "(1) screen failure is paid for every two (2)",
      "/study/effectiveDate/value": "August 22, 2025",
      "/appliesFrom/value": "01/15/2026",
    });
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

  it("a rule, cap, due date or date one character off what the page prints is never confirmed", () => {
    const rb = rulebook();
    const before = statuses(bindEvidence(rb, pages).evidence);
    const cents = new Set(["/invoiceables/0/cap/n", "/invoiceables/0/amountCents", "/invoiceables/0/amountWithOverheadCents", "/siteFees/0/amountCents"]);
    const paths = ["/payment/netDays/value", "/overhead/pct/value", "/holdback/pct", "/deadlines/0/value", "/budgetGrids/0/statedOverheadPct", "/siteFees/0/dueDays", "/overpayment/refundDays", "/screenFail/cap/n", "/screenFail/cap/ratio", "/study/effectiveDate/value", "/appliesFrom/value", ...cents];
    let tried = 0;
    for (const path of paths) {
      expect(before[path], path).toBe("confirmed");
      for (const v of nearby(valueAt(rb, path) as number | string, cents.has(path))) {
        tried++;
        expect([path, v, statuses(bindEvidence(withValue(rb, path, v), pages).evidence)[path]]).not.toEqual([path, v, "confirmed"]);
      }
    }
    expect(tried).toBeGreaterThan(500);
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

/** A one-page text PDF of these lines, read back. */
async function textPdf(lines: string[], documentId = "d1") {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const filler = [
    "This page continues the agreement between the parties and the site, as set out above in full detail.",
    "A second ordinary line of words keeps this page well above the threshold for a real text layer.",
  ];
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, [...lines, ...filler].map((t, i) => at(40, 60 + 20 * i, t)).join("")));
  const file = join(mkdtempSync(join(tmpdir(), "dct-evidence-")), "page.pdf");
  writeFileSync(file, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(file, documentId);
}

describe("rules as contracts print them", async () => {
  const LINES = [
    "Payment is due within 30 days of invoice and disputes within 60 days of payment.",
    "Signed and effective on 2025-08-22 by both parties.",
    "Effective as of Aug. 22nd, 2025 for all sites.",
    "Dated the 22nd day of August, 2025 at the site.",
    "Valid from 22-Aug-25 until the close of the study.",
    "Starting 8/22/2025 the new rates apply.",
    "Effective 22.08.2025 for the sites in Europe.",
    "Starting 03/04/2025 the old rates end.",
    "Sponsor will pay for 12 screen failures in total.",
    "Sponsor will pay for 12 screen failures across 3 sites.",
    "Institutional overhead of 30% applies to procedures.",
    "The overhead is set out in the budget, and the site keeps 25% of the stipends.",
    "The archive fee is $250.00 a year, and $350.00 with overhead.",
  ];
  const text = await textPdf(LINES);
  const quoted = (path: string, value: unknown, line: number) => {
    const rb = withValue(rulebook(), path, value);
    const src = { documentId: "d1", page: 1, quote: LINES[line]!.replace(/\.$/, "") };
    if (path.startsWith("/study")) rb.study.effectiveDate.prov.source = src;
    if (path.startsWith("/payment")) rb.payment.netDays.prov.source = src;
    if (path.startsWith("/screenFail")) rb.screenFail!.prov.source = src;
    if (path.startsWith("/budgetGrids")) rb.budgetGrids[0]!.prov.source = src;
    return bindEvidence(rb, text).evidence.find((e) => e.path === path)!;
  };

  it("dates: ISO, month names, day first, two-digit years and numbers are read; a day/month that can swap is asked", () => {
    for (const line of [1, 2, 3, 4, 5, 6]) expect(quoted("/study/effectiveDate/value", "2025-08-22", line), LINES[line]).toMatchObject({ status: "confirmed" });
    expect(quoted("/study/effectiveDate/value", "2025-08-23", 2)).toMatchObject({ status: "conflict", printed: "Aug. 22nd, 2025" });
    for (const v of ["2025-03-04", "2025-04-03"]) expect(quoted("/study/effectiveDate/value", v, 7)).toMatchObject({ status: "ungrounded", note: "the date can be read as month/day or day/month" });
    // The same reading for a typed date against the printed text: one date that reads one way, and only a real day.
    expect(["Aug. 22nd, 2025", "22-Aug-25", "8/22/2025", "2025-08-22", "the 22nd day of August, 2025"].map(isoDate)).toEqual(Array(5).fill("2025-08-22"));
    expect(["03/04/2025", "31 June 2025", "2025-02-30", "August 22, 2025 and 9/1/2025", "45 days"].map(isoDate)).toEqual(Array(5).fill(null));
  });

  it("a quote with two figures of the value's kind can't say which one is the value", () => {
    expect(quoted("/payment/netDays/value", 30, 0)).toMatchObject({ status: "ungrounded", note: "printed with another figure of the same kind, so which one it is can't be told" });
    expect(quoted("/payment/netDays/value", 45, 0)).toMatchObject({ status: "conflict", printed: null });
  });

  it("a cap is the number stated as a limit, else the only plain number in the quote", () => {
    expect(quoted("/screenFail/cap/n", 12, 8)).toMatchObject({ status: "confirmed", printed: "12" });
    expect(quoted("/screenFail/cap/n", 12, 9).status).toBe("ungrounded");
  });

  it("amounts in a quote (no row found by the label): two by position, else the only one", () => {
    const fee = (amountCents: number, amountWithOverheadCents: number | null) => {
      const rb = rulebook();
      rb.invoiceables = [{ ...rb.invoiceables[0]!, name: "Records retention", amountCents, amountWithOverheadCents, prov: { ...rb.invoiceables[0]!.prov, source: { documentId: "d1", page: 1, quote: LINES[12]! } } }];
      const s = statuses(bindEvidence(rb, text).evidence);
      return [s["/invoiceables/0/amountCents"], s["/invoiceables/0/amountWithOverheadCents"]];
    };
    expect(fee(25000, 35000)).toEqual(["confirmed", "confirmed"]);
    expect(fee(35000, 25000)).toEqual(["conflict", "conflict"]);
    expect(fee(25000, null)).toEqual(["ungrounded", undefined]); // $350.00 is in the quote too: which one it is can't be told
  });

  it("the grid's overhead % must be printed next to the word overhead", () => {
    expect(quoted("/budgetGrids/0/statedOverheadPct", 30, 10)).toMatchObject({ status: "confirmed", printed: "30%" });
    expect(quoted("/budgetGrids/0/statedOverheadPct", 25, 11).status).not.toBe("confirmed");
  });
});

describe("an amount at the end of a sentence", () => {
  it("is read with its full stop, not taken from the next line", async () => {
    const text = await textPdf(["The start-up fee is $7,455.00.", "The archiving fee is $1,000.00 per year."]);
    const rb = rulebook();
    rb.siteFees = [{ ...rb.siteFees[0]!, code: null, name: "Start-up fee", amountCents: 745500, prov: { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } }];
    const fee = bindEvidence(rb, text).evidence.find((e) => e.path === "/siteFees/0/amountCents");
    expect(fee).toMatchObject({ status: "confirmed", printed: "$7,455.00." });
    expect(inventory(text).filter((x) => x.kind === "amount").map((x) => x.words.map((w) => w.text).join(" "))).toEqual(["$7,455.00.", "$1,000.00"]);
  });
});

/** A PDF of these pages (content streams; /Im1 is a small grey image), read back. */
async function contentPdf(contents: string[]) {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
  pix.clear(120);
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) }, XObject: { Im1: doc.addImage(new mupdf.Image(pix)) } };
  for (const c of contents) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, c));
  const file = join(mkdtempSync(join(tmpdir(), "dct-evidence-")), "pages.pdf");
  writeFileSync(file, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(file, "d1");
}
/** Ordinary text at the foot of a page, enough for a real text layer. */
const FOOT = [700, 712, 724, 736].map((y) => at(40, y, "This page continues the agreement between the parties and the site, as set out above in full detail.")).join("");
/** The image drawn at x, y (from the top), w × h points. */
const picture = (x: number, y: number, w: number, h: number) => `q ${w} 0 0 ${h} ${x} ${792 - y - h} cm /Im1 Do Q\n`;
const onPage1 = (quote?: string) => ({ source: { documentId: "d1", page: 1, ...(quote && { quote }) }, confidence: 0.9, method: "ai" as const, crossCheck: "not_checked" as const });

describe("an amount on a line that prints other amounts too", async () => {
  const text = await textPdf([
    "Each screen failure is paid at $500.00, up to a maximum of $5,000.00 per study.",
    "Re-consent visit $100.00 $130.00 per occurrence",
    "Start-up fee of $3,000.00, of which $1,500.00 is payable on execution.",
    "Archiving fee $250.00 per year",
  ]);
  const bind = (rb: Rulebook) => {
    rb.screenFail!.prov = onPage1();
    const { evidence, unaccounted } = bindEvidence(rb, text);
    return { s: statuses(evidence), notes: Object.fromEntries(evidence.map((e) => [e.path, e.note])), left: unaccounted.map((x) => x.words.map((w) => w.text).join(" ")) };
  };
  const fees = (amountCents: number, amountWithOverheadCents: number | null, startUp: number) => {
    const rb = rulebook();
    rb.invoiceables = [{ ...rb.invoiceables[0]!, name: "Re-consent visit", amountCents, amountWithOverheadCents, cap: { kind: "none", n: null, ratio: null }, prov: onPage1() }];
    rb.siteFees = [
      { ...rb.siteFees[0]!, code: null, name: "Start-up fee", amountCents: startUp, dueDays: null, prov: onPage1() },
      { ...rb.siteFees[0]!, code: null, name: "Archiving fee", amountCents: 25000, dueDays: null, prov: onPage1() },
    ];
    return bind(rb);
  };

  it("is asked, never confirmed, whichever of them the read took; the others stay unaccounted", () => {
    for (const cents of [50000, 500000]) {
      const rb = rulebook();
      rb.screenFail = { ...rb.screenFail!, amountCents: cents, cap: { kind: "none", n: null, ratio: null } };
      const { s, notes } = bind(rb);
      expect([cents, s["/screenFail/amountCents"]]).toEqual([cents, "ungrounded"]);
      expect(notes["/screenFail/amountCents"]).toBe("printed with another amount on the same line, so which one it is can't be told");
    }
    const { s, left } = fees(13000, null, 150000);
    expect([s["/invoiceables/0/amountCents"], s["/siteFees/0/amountCents"], s["/siteFees/1/amountCents"]]).toEqual(["ungrounded", "ungrounded", "confirmed"]);
    expect(left).toEqual(expect.arrayContaining(["$100.00", "$3,000.00,"]));
  });

  it("two prices read as two still bind by position; a misread is still a conflict", () => {
    expect(fees(10000, 13000, 300000).s).toMatchObject({ "/invoiceables/0/amountCents": "confirmed", "/invoiceables/0/amountWithOverheadCents": "confirmed", "/siteFees/0/amountCents": "ungrounded" });
    const rb = rulebook();
    rb.screenFail = { ...rb.screenFail!, amountCents: 60000, cap: { kind: "none", n: null, ratio: null } };
    expect(bind(rb).s["/screenFail/amountCents"]).toBe("conflict");
  });

  it("a page reference isn't re-pointed to a line where another amount could be the value", () => {
    const rb = rulebook();
    rb.invoiceables[0] = { ...rb.invoiceables[0]!, amountCents: 7000, amountWithOverheadCents: null }; // the with-overhead price, cited on page 2
    rb.invoiceables[0].prov.source!.page = 2;
    expect(statuses(bindEvidence(rb, pages).evidence)["/invoiceables/0/amountCents"]).toBe("ungrounded");
  });
});

describe("a rule quoted from another clause", async () => {
  const text = await textPdf([
    "Sponsor shall pay each invoice within forty-five (45) days of receipt.",
    "Site shall refund any overpayment within 30 days of notice.",
    "Sponsor will reimburse up to ten (10) unscheduled visits per subject.",
  ]);
  const NOTE = "the quote isn't from a sentence about this term";

  it("is asked, and the clause's own figure stays unaccounted", () => {
    const rb = rulebook();
    rb.payment.netDays = { value: 30, prov: onPage1("within 30 days") };
    const { evidence, unaccounted } = bindEvidence(rb, text);
    expect(evidence.find((e) => e.path === "/payment/netDays/value")).toMatchObject({ status: "ungrounded", note: NOTE, where: [{ documentId: "d1", page: 1, box: null }] });
    expect(unaccounted.map((x) => x.words.map((w) => w.text).join(" "))).toContain("30 days");
    rb.payment.netDays = { value: 45, prov: onPage1("within forty-five (45) days of receipt") };
    expect(statuses(bindEvidence(rb, text).evidence)["/payment/netDays/value"]).toBe("confirmed");
    // A screen-fail cap quoted from another item's limit.
    rb.screenFail = { ...rb.screenFail!, cap: { kind: "count", n: 10, ratio: null }, prov: onPage1("up to ten (10) unscheduled visits") };
    expect(bindEvidence(rb, text).evidence.find((e) => e.path === "/screenFail/cap/n")).toMatchObject({ status: "ungrounded", note: NOTE });
  });

  it("for every rule with words of its own: payment, refund, holdback, overhead, deadlines, due days", () => {
    // Each value is printed on the terms page, but in a sentence about another term.
    const rb = rulebook();
    rb.payment.netDays.prov = onPage1("refunded within thirty (30) days");
    rb.payment.netDays.value = 30;
    rb.overpayment = { ...rb.overpayment!, refundDays: 45, prov: onPage1("within forty-five (45) days of receipt") };
    rb.holdback = { ...rb.holdback!, pct: 1.5, prov: onPage1("Interest of 1.5% per month") };
    rb.overhead.pct = { value: 2, prov: onPage1("Lidocaine 2% cream") };
    rb.deadlines = [{ kind: "query_resolution_days", value: 30, consequence: "", prov: onPage1("refunded within thirty (30) days") }];
    rb.siteFees[0] = { ...rb.siteFees[0]!, dueDays: 30, prov: { ...rb.siteFees[0]!.prov, source: { documentId: "d1", page: 1, quote: "Overpayments will be refunded within thirty (30) days" } } };
    const ev = new Map(bindEvidence(rb, pages).evidence.map((e) => [e.path, [e.status, e.note]]));
    const paths = ["/payment/netDays/value", "/overpayment/refundDays", "/holdback/pct", "/overhead/pct/value", "/deadlines/0/value", "/siteFees/0/dueDays"];
    expect(paths.map((p) => [p, ev.get(p)])).toEqual(paths.map((p) => [p, ["ungrounded", NOTE]]));
  });
});

describe("two grids on one page with the same rows", async () => {
  const ROWS = (price: string, total: string) => [
    ["Code", "Procedure", "Unit", "V1", "V2"],
    ["36415", "Blood draw", price, price, price],
    ["93000", "ECG", "120.00", "120.00", "120.00"],
    ["", "Total per patient", "", total, ""],
  ];
  const table = (top: number, title: string, price: string, total: string, up: boolean) =>
    [["", title], ...ROWS(price, total)]
      .flatMap((r, i) => r.map((s, c) => (s ? (up ? at(top - 16 + 14 * i, 100 + COLS[c]!, s, { up }) : at(COLS[c]!, top - 16 + 14 * i, s)) : "")))
      .join("");
  const both = (up: boolean) => contentPdf([table(80, "Arm A budget", "55.00", "$350.00", up) + table(200, "Arm B budget", "60.00", "$360.00", up) + FOOT]);
  const [[flat], [sideways]] = [await both(false), await both(true)];
  const prov = onPage1();
  const visit = (code: string, order: number) => ({ code, name: code, order, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov });
  const arm = (id: string, blood: number, total: number) => ({
    id, label: `Arm ${id} budget`, arm: id, statedOverheadPct: null, prov, header: { investigator: null, siteName: null }, visits: [visit("V1", 1), visit("V2", 2)],
    perPatientTotals: [{ label: "Total per patient", cents: total, prov }],
    procedures: [
      { code: "36415", name: "Blood draw", unitCents: blood, overheadApplied: false, category: "procedure" as const, cells: { V1: blood, V2: blood }, prov },
      { code: "93000", name: "ECG", unitCents: 12000, overheadApplied: false, category: "procedure" as const, cells: { V1: 12000, V2: 12000 }, prov },
    ],
  });

  it("checks each grid's cells against its own table only, upright or sideways", () => {
    for (const page of [flat!, sideways!]) {
      const rb = rulebook();
      // Arm A read right; arm B read with arm A's blood draw price and per-patient total (it prints 60.00 and $360.00).
      rb.budgetGrids = [arm("A", 5500, 35000), arm("B", 5500, 35000)];
      const ev = bindEvidence(rb, [page]).evidence.filter((e) => /procedures|perPatient/.test(e.path));
      expect(ev.filter((e) => e.path.startsWith("/budgetGrids/0/")).every((e) => e.status === "confirmed")).toBe(true);
      const b = Object.fromEntries(ev.filter((e) => e.path.startsWith("/budgetGrids/1/")).map((e) => [e.path.slice(15), [e.status, e.printed]]));
      expect(b).toEqual({
        "procedures/0/cells/V1": ["conflict", "60.00"],
        "procedures/0/cells/V2": ["conflict", "60.00"],
        "procedures/0/unitCents": ["conflict", "60.00"],
        "procedures/1/cells/V1": ["confirmed", "120.00"],
        "procedures/1/cells/V2": ["confirmed", "120.00"],
        "procedures/1/unitCents": ["confirmed", "120.00"],
        "perPatientTotals/0/cents": ["conflict", "$360.00"],
      });
    }
  });

  it("a grid continuing onto the page where the other starts keeps its own rows", async () => {
    // Arm A: its blood draw on page 1, its ECG at the top of page 2; arm B starts under it, with its own header.
    const rows = (top: number, rs: string[][]) => rs.flatMap((r, i) => r.map((s, c) => (s ? at(COLS[c]!, top + 14 * i, s) : ""))).join("");
    const doc = await contentPdf([
      rows(64, [["", "Arm A budget"], ...ROWS("55.00", "").slice(0, 2)]) + FOOT,
      rows(80, [["93000", "ECG", "120.00", "120.00", "120.00"]]) + rows(184, [["", "Arm B budget"], ROWS("", "")[0]!, ["36415", "Blood draw", "60.00", "60.00", "60.00"], ["93000", "ECG", "130.00", "130.00", "130.00"]]) + FOOT,
    ]);
    const rb = rulebook();
    const [a, b] = [arm("A", 5500, 0), arm("B", 6000, 0)];
    a.procedures[1]!.prov = { ...prov, source: { documentId: "d1", page: 2 } };
    b.procedures.forEach((p) => (p.prov = { ...prov, source: { documentId: "d1", page: 2 } }));
    b.procedures[1]!.cells = { V1: 12000, V2: 12000 }; // arm A's ECG price; arm B prints 130.00
    rb.budgetGrids = [a, b].map((g) => ({ ...g, perPatientTotals: [] }));
    const s = statuses(bindEvidence(rb, doc).evidence);
    expect(["/budgetGrids/0/procedures/1/cells/V1", "/budgetGrids/1/procedures/0/cells/V1", "/budgetGrids/1/procedures/1/cells/V1"].map((p) => s[p])).toEqual(["confirmed", "confirmed", "conflict"]);
  });
});

describe("an amount in brackets", async () => {
  const w = (text: string) => ({ text, rect: [0, 0, 30, 8] as [number, number, number, number], dir: 0 as const, block: 0, line: 0, hidden: false });
  const cents = (...ws: string[]) => amounts(ws.map(w)).map((a) => a.cents);

  it("is a credit, unless it restates the amount in words before it", () => {
    expect(cents("(1,500.00)")).toEqual([-150000]);
    expect(cents("Total", "($", "1,500.00)")).toEqual([-150000]);
    expect(cents("Three", "Thousand", "Dollars", "($3,000.00)")).toEqual([300000]);
    expect(cents("Five", "Hundred", "and", "00/100", "($500.00).")).toEqual([50000]);
    expect(cents("forty-five", "(45)", "days", "(10%)", "$(", "($500.00")).toEqual([50000]);
  });

  it("never confirms a positive value; a restatement across a line break still does", async () => {
    const text = await textPdf(["Sponsor credit (1,500.00) on the final invoice", "The start-up fee is Three Thousand Dollars", "($3,000.00), payable on execution."]);
    const rb = rulebook();
    rb.siteFees = [
      { ...rb.siteFees[0]!, code: null, name: "Sponsor credit", amountCents: 150000, dueDays: null, prov: onPage1() },
      { ...rb.siteFees[0]!, code: null, name: "Start-up fee", amountCents: 300000, dueDays: null, prov: onPage1() },
    ];
    const s = statuses(bindEvidence(rb, text).evidence);
    expect([s["/siteFees/0/amountCents"], s["/siteFees/1/amountCents"]]).toEqual(["conflict", "confirmed"]);
    rb.siteFees[0]!.amountCents = -150000;
    expect(statuses(bindEvidence(rb, text).evidence)["/siteFees/0/amountCents"]).toBe("confirmed");
  });
});

describe("a picture on a text page (largePicture)", async () => {
  // Dense text over a picture: a background, not a picture of terms.
  const over = Array.from({ length: 30 }, (_, i) => at(40, 112 + 12 * i, "Text drawn over a background image is the page's own text, and it is read and swept like any other.")).join("");
  const read = await contentPdf([
    FOOT + picture(40, 200, 500, 200), // a pasted table: 21% of the page
    FOOT + picture(60, 500, 150, 55) + picture(330, 500, 150, 55) + picture(60, 570, 40, 30) + picture(40, 20, 100, 40), // two signatures, initials, a logo
    FOOT + picture(0, 0, 612, 72), // a letterhead banner across the top: 9%, in the top tenth
    FOOT + picture(40, 100, 532, 380) + over, // a background under the page's own text
    FOOT + [0, 1, 2, 3, 4].map((i) => picture(40, 300 + 20 * i, 500, 20)).join(""), // one picture saved in 5 strips
    FOOT + picture(40, 300, 200, 90), // under 5% of the page
  ]);

  it("is flagged for a pasted table or screenshot, not for signatures, logos, letterheads or backgrounds", () => {
    expect(read.map((p) => [p.source, p.largePicture])).toEqual([
      ["text", true],
      ["text", false],
      ["text", false],
      ["text", false],
      ["text", true],
      ["text", false],
    ]);
  });

  it("is never set on scans and OCR layers: they're attested whole", () => {
    expect(pages.map((p) => [p.source, p.largePicture])).toEqual([...Array(4).fill(["text", false]), ["image_only", false], ["ocr_layer", false]]);
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
    expect(terms[0]!.options.map((o) => o.id)).toEqual(["bill_by_hand", "not_payment", "covered"]);
    expect(terms.every((i) => i.blocking && i.input === null && i.answer === null)).toBe(true);
  });

  it("never shows the reading, and speaks the reviewer's language", () => {
    expect(items.filter((i) => i.kind === "confirm_value").map((i) => i.question).join(" ")).not.toMatch(/200|40/);
    expect(JSON.stringify(items.map((i) => [i.question, i.options]))).not.toMatch(/\bAI\b|anomal|rulebook|extraction/i);
    expect(items.every((i) => i.compare === null && i.outcome === null)).toBe(true);
  });

  it("asks every rule, cap, due date and date it can't confirm, with the input it needs", () => {
    const rb = rulebook();
    rb.budgetGrids[0]!.statedOverheadPct = 41;
    rb.budgetGrids[0]!.label = "Exhibit A at 40%";
    rb.invoiceables.push({ ...rb.invoiceables[0]!, name: "Re-consent", cap: { kind: "blocks_with_reauth", n: 3, ratio: null } });
    const { evidence, unaccounted } = bindEvidence(rb, pages.slice(1, 2)); // the grid page only: the terms page's rules aren't there
    const asked = reviewFromEvidence(evidence, unaccounted, rb).filter((i) => i.kind === "confirm_value" && !/procedures|visits|perPatient|amount/i.test(i.path!));
    expect(Object.fromEntries(asked.map((i) => [i.path, `${i.input}: ${i.question}`]))).toEqual({
      "/budgetGrids/0/statedOverheadPct": 'percent: What overhead percentage is printed on the budget grid "Exhibit A at …"?',
      "/study/effectiveDate/value": "date: What effective date does the contract give?",
      "/appliesFrom/value": "date: From what date do the new terms apply?",
      "/overhead/pct/value": "percent: What overhead percentage does the contract state?",
      "/holdback/pct": "percent: What percentage of each payment is held back?",
      "/payment/netDays/value": "number: Within how many days must an invoice be paid?",
      "/deadlines/0/value": "number: Within how many months after the study closes must the last invoices be sent?",
      "/overpayment/refundDays": "number: Within how many days must an overpayment be paid back?",
      "/siteFees/0/dueDays": 'number: Within how many days is "Administrative fee" due?',
      "/invoiceables/0/cap/n": 'money: What is the most that can be billed for "Courier shipment"?',
      "/invoiceables/1/cap/n": 'number: How many times can "Re-consent" be billed before the sponsor has to approve more?',
      "/screenFail/cap/n": "number: How many screen failures can be billed at most?",
      "/screenFail/cap/ratio": "number: How many screen failures can be billed for each randomized subject?",
    });
    expect(asked.every((i) => i.blocking && (i.reason === "UNGROUNDED_VALUE" || i.reason === "VALUE_CONFLICT"))).toBe(true);
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

  it("a single-character change of a fee, visit total, rule, cap, due date or date is never confirmed", async () => {
    const pages = await copd();
    const rb = read();
    const cents = (p: string) => /Cents$|\/cents$/.test(p) || (p.endsWith("/cap/n") && valueAt(rb, p.replace(/\/n$/, "/kind")) === "amount");
    // Every value but grid cells and unit prices (the test above), each bound on its own: round r gives every path its r-th neighbour.
    const paths = bindEvidence(rb, pages).evidence.map((e) => e.path).filter((p) => !/\/cells\/|unitCents$/.test(p));
    const near = new Map(paths.map((p) => [p, nearby(valueAt(rb, p) as number | string, cents(p))]));
    let tried = 0;
    for (let r = 0; [...near.values()].some((vs) => r < vs.length); r++) {
      const m = structuredClone(rb);
      const changed = paths.filter((p) => r < near.get(p)!.length);
      for (const p of changed) setValue(m, p, near.get(p)![r]);
      const s = statuses(bindEvidence(m, pages).evidence);
      tried += changed.length;
      expect(changed.filter((p) => s[p] === "confirmed")).toEqual([]);
    }
    expect(paths.filter((p) => /statedOverheadPct|effectiveDate|dueDays|cap\//.test(p)).length).toBeGreaterThan(10);
    expect(tried).toBeGreaterThan(5000);
  }, 60_000);

  it("the admin fee cited on page 4 is re-pointed to page 9", async () => {
    const moved = bindEvidence(read(), await copd()).evidence.filter((e) => e.note?.startsWith("page reference corrected"));
    expect(moved.map((e) => [e.note, e.where[0]!.page, e.status])).toEqual([["page reference corrected from 4 to 9", 9, "confirmed"]]);
  });
});
