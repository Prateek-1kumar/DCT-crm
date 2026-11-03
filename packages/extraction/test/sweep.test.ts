import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValueEvidence } from "@dct/shared";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import type { RowBand } from "../src/binder";
import { gateSweep, masterAmounts, SWEEP } from "../src/sweep";
import { makeRulebook } from "./helpers";
import { boxOf, inventory, readTextLayer, type Span, type TextPage, type Word } from "../src/textlayer";

const at = (x: number, y: number, s: string) => `BT /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`;
const FILLER = [at(40, 740, "This page continues the agreement between the parties and the site, as set out above in full detail."), at(40, 756, "A second ordinary line of words keeps this page well above the threshold for a real text layer.")].join("");

/** Pages of synthetic text, read back. */
async function read(contents: string[]): Promise<TextPage[]> {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  for (const c of contents) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, c + FILLER));
  const file = join(mkdtempSync(join(tmpdir(), "dct-sweep-")), "pages.pdf");
  writeFileSync(file, doc.saveToBuffer("").asUint8Array());
  return readTextLayer(file, "d1");
}

// ---------- a budget grid ----------
// rows 1..6: unit prices at x=300/360/420; a totals column at x=456 (inside the one-cell margin) and x=520 (beyond it)
const ROW_Y = (r: number) => 100 + 12 * r;
const COLS = [300, 360, 420];
const gridPage = () =>
  [
    ...[1, 2, 3].map((n, i) => at(COLS[i]!, ROW_Y(0), String(n))), // header: visit numbers
    ...[1, 2, 3, 4, 5, 6].flatMap((r) => [at(40, ROW_Y(r), `Procedure ${r}`), ...COLS.map((x) => at(x, ROW_Y(r), "100.00")), at(456, ROW_Y(r), "300.00"), at(520, ROW_Y(r), "310.00")]),
    // a row the read missed: right below the table, prices, no bound cell on its line
    at(40, ROW_Y(7), "Unbilled ECG"),
    ...COLS.map((x) => at(x, ROW_Y(7), "75.00")),
    at(40, 400, "Archive fee $250.00 a year."),
  ].join("");

const cellsOf = (p: TextPage, rows: number[], cols = COLS) =>
  rows.flatMap((r) => cols.map((x) => p.words.find((w) => w.text === "100.00" && Math.abs(w.rect[0] - x) < 1 && Math.abs(w.rect[1] - ROW_Y(r)) < 12)).filter((w): w is Word => !!w));
/** What the binder would hand over: every inventory span none of whose words is bound. */
const unaccounted = (pages: TextPage[], bound: Word[]) => inventory(pages).filter((s) => !s.words.some((w) => bound.includes(w)));
const evidence = (p: TextPage, bound: Word[], status: ValueEvidence["status"] = "confirmed"): ValueEvidence[] =>
  bound.map((w, i) => ({ path: `/budgetGrids/0/procedures/${i}/cells/V1`, status, where: [boxOf(p, [w])], printed: w.text, note: null }));
const textOf = (ss: Span[]) => ss.map((s) => s.words.map((w) => w.text).join(" "));

describe("consumed: a bound table's own cells", async () => {
  const pages = await read([gridPage()]);
  const p = pages[0]!;
  const bound = cellsOf(p, [1, 2, 3, 4, 5, 6]);
  const run = (b: Word[], ev = evidence(p, b)) => gateSweep(unaccounted(pages, b), { evidence: ev, pages });

  it("has the planted cells", () => expect(bound).toHaveLength(18));

  it("drops its header numbers, and a number a bound entry claims just beside the table", () => {
    const total = p.words.find((w) => w.text === "300.00" && Math.abs(w.rect[1] - ROW_Y(3)) < 12)!;
    const claim: ValueEvidence = { path: "/budgetGrids/0/visits/0/totalCents", status: "confirmed", where: [boxOf(p, [total])], printed: "300.00", note: null };
    const { dropped, kept } = run(bound, [...evidence(p, bound), claim]);
    const gone = textOf(dropped.map((d) => d.span));
    expect(dropped.every((d) => d.reason === "consumed" && d.where.page === 1 && d.where.box)).toBe(true);
    expect(gone).toContain("300.00"); // the one the entry claims
    expect(textOf(kept).filter((t) => t === "300.00")).toHaveLength(5); // not the five beside it
    expect(gone).toContain("1"); // the header's visit numbers (not prices)
  });

  it("keeps a whole column the read missed: the prices no entry claims are asked, though every line beside them is bound", () => {
    const { kept, dropped } = run(bound);
    expect(textOf(kept).filter((t) => t === "300.00")).toHaveLength(6);
    expect(textOf(dropped.map((d) => d.span))).not.toContain("300.00");
    expect(textOf(dropped.map((d) => d.span))).toContain("1"); // header numbers still go
  });

  it("keeps a number beyond the one-cell margin, on a bound line", () => {
    const { kept } = run(bound);
    expect(textOf(kept)).toContain("310.00");
  });

  it("keeps a row the read missed, though it sits inside the margin: prices on a line with no bound cell", () => {
    const { kept } = run(bound);
    expect(textOf(kept).filter((t) => t === "75.00")).toHaveLength(3);
  });

  it("keeps the narrative amount below the table", () => {
    const { kept } = run(bound);
    expect(textOf(kept)).toContain("$250.00");
  });

  it("counts the cells: one fewer than the threshold is no zone, so nothing is consumed", () => {
    expect(SWEEP.minBoundCells).toBe(6);
    const five = run(bound.slice(0, 5));
    expect(five.report.consumed).toBe(0);
    const six = run(bound.slice(0, 6));
    expect(six.report.consumed).toBeGreaterThan(0);
  });

  it("needs a table: six cells down one column bind no zone", () => {
    const column = cellsOf(p, [1, 2, 3, 4, 5, 6], [300]);
    expect(column).toHaveLength(6);
    expect(run(column).report.consumed).toBe(0);
  });

  it("counts confirmed_by_math and attested, never a conflict or a missing value", () => {
    for (const s of ["confirmed_by_math", "attested"] as const) expect(run(bound, evidence(p, bound, s)).report.consumed).toBeGreaterThan(0);
    for (const s of ["conflict", "ungrounded"] as const) expect(run(bound, evidence(p, bound, s)).report.consumed).toBe(0);
  });

  it("keeps the amounts on a conflict's spot, which that value's own question shows", () => {
    const stray = p.words.find((w) => w.text === "310.00" && Math.abs(w.rect[1] - ROW_Y(3)) < 12)!;
    const mid = p.words.find((w) => w.text === "300.00" && Math.abs(w.rect[1] - ROW_Y(3)) < 12)!;
    const open: ValueEvidence = { path: "/budgetGrids/0/visits/0/totalCents", status: "conflict", where: [boxOf(p, [mid])], printed: "300.00", note: null };
    const claim: ValueEvidence = { ...open, status: "confirmed" };
    const { kept } = run(bound, [...evidence(p, bound), claim, open]);
    expect(kept.some((s) => s.words[0] === mid)).toBe(true);
    expect(kept.some((s) => s.words[0] === stray)).toBe(true); // beyond the margin anyway
    // claimed alone, it's that entry's own number
    expect(run(bound, [...evidence(p, bound), claim]).kept.some((s) => s.words[0] === mid)).toBe(false);
  });

  it("an invoiceable table's amounts make a zone too", () => {
    const ev = evidence(p, bound).map((e, i): ValueEvidence => ({ ...e, path: `/invoiceables/${i}/amountCents` }));
    expect(run(bound, ev).report.consumed).toBeGreaterThan(0);
    // but a path that is no money cell of a table (a header, a rule) is not one
    const none = evidence(p, bound).map((e, i): ValueEvidence => ({ ...e, path: `/budgetGrids/0/header/${i}` }));
    expect(run(bound, none).report.consumed).toBe(0);
  });
});

// ---------- narrative pages ----------
const NARRATIVE = [
  "Each party shall maintain commercial general liability insurance of $1,000,000 per occurrence and $3,000,000 annual aggregate.", // 1: limits
  "Sponsor will reimburse the cost of insurance premiums up to $5,000.00 per year.", // 2: a fee clause that mentions insurance
  "A start-up fee of $12,000.00 is due within 45 days of the study start.", // 3
  "Sponsor will withhold 10% of each payment until close-out.", // 4: holdback
  "Reimbursement is capped at $500.00 per month, up to 20 visits.", // 5: cap
  "Indemnification of the site by the sponsor covers claims of 30 days or more after termination.", // 6: days, in an indemnity sentence
  "Ordinary words about the weather and the lobby fill this line with no payment terms at all, and then", // 7: tail of a CPT line
];
async function narrative() {
  const lines = NARRATIVE.map((t, i) => at(40, 60 + 20 * i, t));
  // two bare numbers in a row of a list that talks about nothing financial, then the same with a trigger word near them
  lines.push(at(40, 220, "Codes        71045        99000        36415 are listed for reference only in this schedule of procedures."));
  lines.push(at(40, 240, "Courier        50.00        70.00        per mile reimbursement for the site."));
  lines.push(at(40, 260, "Mailing label reference $0009 for the shipment."));
  return read([lines.join("")]);
}

describe("insurance clause", async () => {
  const pages = await narrative();
  const all = inventory(pages);
  const { kept, dropped } = gateSweep(all, { evidence: [], pages });
  const said = (list: Span[]) => textOf(list);
  const insurance = dropped.filter((d) => d.reason === "insurance_clause").map((d) => d.span);

  it("has the planted spans", () => {
    expect(said(all)).toEqual(expect.arrayContaining(["$1,000,000", "$3,000,000", "$5,000.00", "$12,000.00", "10%", "$500.00"]));
  });

  it("drops the limits in an insurance sentence, with its reason and box", () => {
    expect(said(insurance)).toEqual(expect.arrayContaining(["$1,000,000", "$3,000,000"]));
    for (const d of dropped) expect(d.where).toEqual(d.span.where);
    expect(dropped.find((d) => d.reason === "insurance_clause")!.where.box).not.toBeNull();
  });

  it("keeps a fee clause that mentions insurance: reimburse sits next to its amount", () => {
    expect(said(kept)).toContain("$5,000.00");
  });

  it("drops a day count in an indemnity sentence with no payment verb near it", () => {
    expect(said(insurance)).toContain("30 days");
  });
});

describe("per occurrence: a fee line, not an insurance limit", async () => {
  const pages = await read([
    [
      at(40, 60, "SAE report, $350.00 per occurrence."),
      at(40, 80, "Institution shall maintain professional liability coverage of $1,000,000 per occurrence."),
      at(40, 100, "Site shall maintain insurance of $2,000,000 per occurrence."),
    ].join(""),
  ]);
  const { kept, dropped } = gateSweep(inventory(pages), { evidence: [], pages });
  const insurance = textOf(dropped.filter((d) => d.reason === "insurance_clause").map((d) => d.span));

  it("keeps a fee priced per occurrence", () => expect(textOf(kept)).toContain("$350.00"));
  it("still drops a limit whose sentence names insurance or liability", () => expect(insurance).toEqual(expect.arrayContaining(["$1,000,000", "$2,000,000"])));
});

// ---------- figure-less sentences (owner, 2026-11-02) ----------
// wordings of no contract we have: each names money (or names none) in a way the payment words must tell apart
const PAYS = [
  "Upon termination, Sponsor shall pay Institution for all work performed through the termination date.",
  "Sponsor will compensate the Site for visits completed before early termination.",
  "Sponsor shall bear the shipping of samples to the central laboratory.",
  "Additional imaging shall be invoiced to Sponsor monthly.",
  "Local laboratory tests are billable to Sponsor.",
  "Unscheduled procedures: at the Site's standard rate.",
  "Courier shipments will be reimbursed at actual cost upon receipt.",
  "Monitor-requested local labs are pass-through items.",
  "Non-cancellable commitments made before notice are honoured.",
  "Bank wire fees are the Sponsor's responsibility.",
  "Supplies the Site buys are charged to Sponsor on receipt.",
  "After seven screen failures the Site is evaluated for more.",
];
const NO_MONEY = [
  "This Agreement may be terminated by either party upon written notice.",
  "Institution shall retain all Study records as required by law.",
  "Sponsor shall own all right, title and interest in the Inventions.",
  "The Patient Bill of Rights survives termination of this Agreement.",
  "The Investigator in charge of the Study may terminate enrollment.",
  "A person charged with a felony may not be retained.",
  "Site warrants no staff member has been charged, convicted or debarred, or retained after it.",
  "Neither party is responsible for workers' compensation or withholding taxes of the other's staff.",
  "Return the charging cable at termination.",
];

describe("figure-less sentences: asked only with a payment word", async () => {
  const lines = [...PAYS, ...NO_MONEY].map((t, i) => at(40, 60 + 16 * i, t));
  lines.push(at(40, 60 + 16 * (PAYS.length + NO_MONEY.length), "Notices go by courier, shipping charges prepaid, to the address below."));
  const pages = await read([lines.join("")]);
  const all = inventory(pages);
  const { kept, dropped, report } = gateSweep(all, { evidence: [], pages });
  const sentence = (s: Span) => s.words.map((w) => w.text).join(" ");

  it("asks each money sentence, however it words the money", () => {
    const asked = kept.filter((s) => s.kind === "absence").map(sentence);
    for (const t of PAYS) expect(asked).toContain(t);
  });

  it("drops a sentence with no payment word, counted with its reason and box", () => {
    const gone = dropped.filter((d) => d.reason === "no_payment_word");
    expect(gone.map((d) => sentence(d.span)).sort()).toEqual([...NO_MONEY].sort());
    expect(report.noPayment).toBe(NO_MONEY.length);
    for (const d of gone) expect(d.where.box).not.toBeNull();
  });

  it("takes no notice clause's courier charges for money", () => {
    expect(all.some((s) => sentence(s).startsWith("Notices go by courier"))).toBe(false);
  });
});

describe("the same money words find figures, and keep a bare number on a narrative page", async () => {
  const pages = await read([[at(40, 60, "Pass-through items are billed within 30 days of receipt."), at(40, 80, "Courier        250.00        325.00        billed to Sponsor as used.")].join("")]);
  const all = inventory(pages);
  const { kept } = gateSweep(all, { evidence: [], pages });

  it("sweeps a day count whose sentence's only money word is a billing one", () => expect(textOf(all)).toContain("30 days"));
  it("keeps bare prices beside a billing word (the trigger is the inventory's money words)", () => expect(textOf(kept)).toEqual(expect.arrayContaining(["250.00", "325.00"])));
});

describe("quoted by the master: a figure-less sentence a value cites is the master's", async () => {
  const QUOTED = "Screen failures will be paid upon receipt of an invoice with the screen failure log.";
  const HALF = "Screen failures are paid quarterly, upon receipt of the visit log and the monitor's sign-off.";
  const LONG = "Courier costs are reimbursed upon receipt, and archiving is invoiced at close-out, with receipts.";
  const FIGURE = "A start-up fee of $5,000.00 is paid upon receipt of the IRB approval letter.";
  const pages = await read([[QUOTED, HALF, LONG, FIGURE].map((t, i) => at(40, 60 + 20 * i, t)).join("")]);
  const rb = makeRulebook();
  const cite = (quote: string, page = 1) => ({ ...rb.screenFail!.prov, source: { documentId: "d1", page, quote } });
  rb.screenFail!.prov = cite(QUOTED);
  rb.siteFees[0]!.prov = cite(FIGURE);
  rb.payment.netDaysFrom.prov = cite("paid quarterly, upon receipt of the visit log"); // 8 of 15 words
  rb.invoiceables[0]!.prov = cite("upon receipt"); // two words of a longer sentence: not that sentence's value
  const run = (r = rb) => gateSweep(inventory(pages), { evidence: [], pages, rb: r });
  const sentence = (s: Span) => s.words.map((w) => w.text).join(" ");

  it("drops a sentence a value quotes whole, or at least half of, with its own reason", () => {
    const { dropped, report } = run();
    const quoted = dropped.filter((d) => d.reason === "quoted_by_master").map((d) => sentence(d.span));
    expect(quoted.sort()).toEqual([HALF, QUOTED].sort());
    expect(report.quoted).toBe(2);
  });

  it("keeps a sentence a short quote only touches, and a quoted sentence with a figure", () => {
    const { kept } = run();
    expect(kept.map(sentence)).toContain(LONG);
    expect(textOf(kept)).toContain("$5,000.00");
  });

  it("needs the quote on the sentence's own page", () => {
    const moved = makeRulebook();
    moved.screenFail!.prov = cite(QUOTED, 2);
    expect(run(moved).report.quoted).toBe(0);
  });
});

describe("currency cue on a narrative page", async () => {
  const pages = await narrative();
  const { kept, dropped } = gateSweep(inventory(pages), { evidence: [], pages });
  const gone = textOf(dropped.filter((d) => d.reason === "no_currency_cue").map((d) => d.span));

  it("drops bare code-like numbers with no financial word near them", () => {
    expect(gone).toEqual(expect.arrayContaining(["71045", "99000", "36415"]));
  });

  it("keeps bare numbers with a trigger word within ten tokens", () => {
    expect(textOf(kept)).toEqual(expect.arrayContaining(["50.00", "70.00"]));
  });

  it("always keeps a start-up fee, a holdback and a cap", () => {
    expect(textOf(kept)).toEqual(expect.arrayContaining(["$12,000.00", "45 days", "10%", "$500.00", "up to 20"]));
    expect(gone).not.toContain("45 days");
    expect(gone).not.toContain("10%");
  });

  it("keeps an amount with a currency mark even when it is not an amount at all (a code misread as $0009)", () => {
    expect(textOf(kept)).toContain("$0009");
  });

  it("does not apply on a page with a zone: only narrative pages are gated by the cue", async () => {
    const grid = await read([gridPage()]);
    const p = grid[0]!;
    const bound = cellsOf(p, [1, 2, 3, 4, 5, 6]);
    const spans = unaccounted(grid, bound);
    const out = gateSweep(spans, { evidence: evidence(p, bound), pages: grid });
    expect(out.report.noCue).toBe(0);
  });
});

describe("the report", async () => {
  const pages = await narrative();
  const all = inventory(pages);

  it("counts every span once", () => {
    const { kept, dropped, report } = gateSweep(all, { evidence: [], pages });
    expect(report.kept + report.noPayment + report.quoted + report.consumed + report.arithmetic + report.insurance + report.explained + report.noCue).toBe(all.length);
    expect(report.kept).toBe(kept.length);
    expect(report.noPayment + report.quoted + report.consumed + report.arithmetic + report.insurance + report.explained + report.noCue).toBe(dropped.length);
  });

  it("changes nothing it was given", () => {
    const before = JSON.stringify([all, pages]);
    const ev = [{ path: "/budgetGrids/0/visits/0/totalCents", status: "confirmed", where: [{ documentId: "d1", page: 1, box: [0.1, 0.1, 0.1, 0.01] }], printed: null, note: null }] as ValueEvidence[];
    const evBefore = JSON.stringify(ev);
    const copy = [...all];
    gateSweep(all, { evidence: ev, pages });
    expect(JSON.stringify([all, pages])).toBe(before);
    expect(JSON.stringify(ev)).toBe(evBefore);
    expect(all).toEqual(copy);
  });

  it("is quiet on nothing", () => {
    expect(gateSweep([], { evidence: [], pages: [] })).toEqual({ kept: [], dropped: [], report: { noPayment: 0, quoted: 0, consumed: 0, arithmetic: 0, insurance: 0, explained: 0, noCue: 0, kept: 0, explainedBy: {}, modelNonFee: {}, modelKept: 0 } });
  });

  it("keeps a span whose page it doesn't know (nothing to say it is narrative)", () => {
    const { kept } = gateSweep(all.filter((s) => s.kind === "grid_number"), { evidence: [], pages: [] });
    expect(kept.length).toBeGreaterThan(0);
  });
});

// ---------- explained by the master ----------
// The synthetic master: unit prices 300.00, 200.00, 55.00, 100.00; V1 total 840.00, V2 560.00; per patient 1,400.00; V1 sum 500.00.
const rb = makeRulebook();
const row = (y: number, label: string, ...cells: string[]) => [at(40, y, label), ...cells.map((c, i) => at(200 + 60 * i, y, `$${c}`))].join("");

/** The line's y as `at` was given it (a word's box straddles its baseline). */
const mid = (w: Word) => (w.rect[1] + w.rect[3]) / 2 + 3.5;

async function summary() {
  const page1 = [
    row(100, "Visit total", "840.00", "560.00", "1,400.00"), // a summary table: visit totals and the per-patient total
    row(120, "Physical exam", "300.00", "300.00", "600.00"), // a Totals column: unit price, cell, row sum
    row(140, "Total", "123.45", "840.00", "560.00"), // one amount the master does not hold
    row(160, "Unbilled ECG", "300.00", "200.00", "300.00"), // a row the read missed: prices equal others', its label is nobody's
    row(180, "Start-up fee", "300.00", "300.00", "300.00"), // a fee row
    row(200, "Overhead", "1.00", "2.00", "3.00"), // nothing held
    at(40, 240, "Subtotal"), at(400, 240, "$500.00"), at(40, 255, "Subtotal"), at(400, 255, "$300.00"), at(40, 270, "Subtotal"), at(400, 270, "$100.00"), at(40, 285, "Subtotal"), at(400, 285, "$840.00"), // a column of lines
  ].join("");
  const page2 = [
    at(40, 60, "A start-up fee of $300.00 is due within 45 days of signing."), // equals a unit price
    at(40, 80, "Sponsor will hold back $200.00 of each payment until close-out."), // equals a cell
    at(40, 100, "Reimbursement is capped at $500.00 per month."), // equals a visit sum
    at(40, 120, "The visits cost $300.00, $200.00 and $300.00 per visit."), // three prices in a sentence
    at(40, 140, "The total is shown below."), at(40, 160, "Subtotal"), at(300, 160, "$500.00"), // one lone amount of the master's, no column
  ].join("");
  return read([page1, page2]);
}

describe("explained by the master", async () => {
  const pages = await summary();
  const [p1, p2] = pages as [TextPage, TextPage];
  const all = inventory(pages);
  const run = (ev: ValueEvidence[] = [], withRb = true) => gateSweep(all, { evidence: ev, pages, ...(withRb ? { rb } : {}) });
  const on = (list: { span: Span }[] | Span[], page: number, y: number) => (list as { span?: Span }[]).map((x) => x.span ?? (x as Span)).filter((s) => s.where.page === page && Math.abs(mid(s.words[0]!) - y) < 7);
  const said = (list: Span[]) => textOf(list);
  const explained = () => run().dropped.filter((d) => d.reason === "explained_by_master");

  it("drops a summary table's visit totals and per-patient total, a Totals column, and says what each equals", () => {
    const d = explained();
    expect(said(on(d, 1, 100))).toEqual(["$840.00", "$560.00", "$1,400.00"]);
    expect(d.filter((x) => mid(x.span.words[0]!) < 110).map((x) => x.as)).toEqual(["visit_total", "visit_total", "patient_total"]);
    expect(said(on(d, 1, 120))).toEqual(["$300.00", "$300.00", "$600.00"]);
    expect(d.filter((x) => Math.abs(mid(x.span.words[0]!) - 120) < 7).map((x) => x.as)).toEqual(["unit_price", "unit_price", "row_sum"]);
    for (const x of d) expect(x.where).toEqual(x.span.where);
  });

  it("asks an amount in a table that the master does not hold, and drops the held ones beside it", () => {
    const { kept } = run();
    expect(said(on(kept, 1, 140))).toEqual(["$123.45"]);
    expect(said(on(explained(), 1, 140))).toEqual(["$840.00", "$560.00"]);
    expect(said(on(kept, 1, 200))).toEqual(["$1.00", "$2.00", "$3.00"]);
  });

  it("reads a column of lines as a table: four amounts, one under another", () => {
    expect(said(on(explained(), 1, 240).concat(on(explained(), 1, 255), on(explained(), 1, 270), on(explained(), 1, 285)))).toEqual(["$500.00", "$300.00", "$100.00", "$840.00"]);
  });

  it("keeps a lone amount of the master's, with no table around it", () => {
    expect(said(on(run().kept, 2, 160))).toEqual(["$500.00"]);
  });

  it("keeps a row the read missed: its prices equal others', but its label is not the master's", () => {
    expect(said(on(run().kept, 1, 160))).toEqual(["$300.00", "$200.00", "$300.00"]);
  });

  it("keeps a fee row in a table: a fee word on the line", () => {
    expect(said(on(run().kept, 1, 180))).toEqual(["$300.00", "$300.00", "$300.00"]);
  });

  it("never touches prose: a start-up fee, a holdback and a cap equal to master amounts are still asked", () => {
    const { kept, dropped } = run();
    for (const y of [60, 80, 100, 120]) expect(on(dropped, 2, y)).toEqual([]);
    expect(said(on(kept, 2, 60))).toContain("$300.00");
    expect(said(on(kept, 2, 80))).toEqual(["$200.00"]);
    expect(said(on(kept, 2, 100))).toEqual(["$500.00"]);
    expect(said(on(kept, 2, 120))).toEqual(["$300.00,", "$200.00", "$300.00"]); // three prices in a sentence are not a table
  });

  it("keeps the amounts on a conflict's spot, which that value's question shows", () => {
    const w = p1.words.find((x) => x.text === "$840.00" && Math.abs(mid(x) - 100) < 7)!;
    const open: ValueEvidence = { path: "/budgetGrids/0/visits/0/totalCents", status: "conflict", where: [boxOf(p1, [w])], printed: "$840.00", note: null };
    const { kept } = run([open]);
    expect(kept.some((s) => s.words[0] === w)).toBe(true);
    expect(said(on(run([open]).dropped, 1, 100))).toEqual(["$560.00", "$1,400.00"]);
  });

  it("does nothing without the master, and counts what it did", () => {
    expect(run([], false).report.explained).toBe(0);
    const { report } = run();
    expect(report.explained).toBe(explained().length);
    expect(report.explainedBy).toMatchObject({ visit_total: expect.any(Number), patient_total: 1, row_sum: 1 });
    expect(Object.values(report.explainedBy).reduce((a, b) => a + b, 0)).toBe(report.explained);
    expect(p2.page).toBe(2);
  });

  it("holds what a summary table repeats and nothing a clause gives", () => {
    const m = masterAmounts(rb);
    for (const c of [30000, 20000, 42000, 50000, 84000, 24000, 140000, 5500, 1200000]) expect(m.has(c)).toBe(true);
    expect(m.get(42000)).toBe("unit_price_with_overhead");
    expect(m.has(500000)).toBe(false); // the screen-fail block size and a cap's limit are not table amounts
    expect(m.has(1)).toBe(false);
  });
});

// ---------- row bands (ADR-002: the senior engineer's structural rule) ----------
// The grid page again: rows 1..6 are mapped to rulebook rows 0..5 (visit cells V1 at x=300, V2 at 360, and a third column at 420 that
// is no visit of the master), a Totals column at 456 sits inside the table, a figure at 520 is outside it, and row 7 is a row
// no rulebook row took. The read's entries cover only the V1 and V2 cells: everything else printed in a band is "unclaimed".
describe("consumed: a mapped row's band", async () => {
  const pages = await read([gridPage()]);
  const p = pages[0]!;
  const lineOf = (r: number) => p.words.filter((w) => Math.abs((w.rect[1] + w.rect[3]) / 2 + 3.5 - ROW_Y(r)) < 4);
  const at2 = (r: number, x: number) => lineOf(r).find((w) => Math.abs(w.rect[0] - x) < 1)!;
  // a band: the table's width (up to x=500) at the row's height; a visit's cell: its column's width
  const W = 612;
  const H = 792;
  const bandOf = (r: number): RowBand => {
    const [y0, y1] = [(ROW_Y(r) - 9.5) / H, (ROW_Y(r) + 2.5) / H];
    const cell = (x0: number, x1: number): RowBand["box"] => [x0 / W, y0, (x1 - x0) / W, y1 - y0];
    return { grid: 0, procedure: r - 1, documentId: "d1", page: 1, box: cell(30, 500), cells: [{ visit: "V1", box: cell(290, 340), ink: true }, { visit: "V2", box: cell(350, 400), ink: true }], total: null, by: null, covers: null };
  };
  const bands = [1, 2, 3, 4, 5, 6].map(bandOf);
  const entry = (r: number, v: "V1" | "V2", status: ValueEvidence["status"] = "confirmed"): ValueEvidence => ({ path: `/budgetGrids/0/procedures/${r - 1}/cells/${v}`, status, where: [boxOf(p, [at2(r, v === "V1" ? 300 : 360)])], printed: "100.00", note: null });
  const entries = [1, 2, 3, 4, 5, 6].flatMap((r) => [entry(r, "V1"), entry(r, "V2")]);
  const bound = entries.flatMap((e, i) => [at2(Math.floor(i / 2) + 1, i % 2 ? 360 : 300)]);
  const left = unaccounted(pages, bound);
  const run = (ctx: Partial<Parameters<typeof gateSweep>[1]> = {}) => gateSweep(left, { evidence: entries, pages, ...ctx });
  const count = (spans: Span[], t: string) => textOf(spans).filter((x) => x === t).length;

  it("without bands, the prices no entry claims beside the bound cells are asked (the zone rule)", () => {
    const { kept } = run();
    expect(count(kept, "100.00")).toBe(6); // the third column
    expect(count(kept, "300.00")).toBe(6);
  });

  it("with bands, every number in a mapped row's band is consumed, claimed or not: the third column and the Totals column", () => {
    const { kept, dropped } = run({ rows: bands });
    expect(count(kept, "100.00")).toBe(0);
    expect(count(kept, "300.00")).toBe(0);
    expect(textOf(dropped.map((d) => d.span)).filter((t) => t === "300.00")).toHaveLength(6);
    expect(dropped.every((d) => d.reason === "consumed")).toBe(true);
  });

  it("a mapped row's band is consumed even where a value of the row is itself asked (its own question shows the printed digits)", () => {
    const open = [entry(1, "V1", "conflict"), ...entries.slice(1)];
    expect(count(gateSweep(left, { evidence: open, pages, rows: bands }).kept, "100.00")).toBe(0);
  });

  it("keeps a number outside the table's width, a row no rulebook row took, and the footnote below the table", () => {
    const { kept } = run({ rows: bands });
    expect(count(kept, "310.00")).toBe(6); // x=520, beyond the band's width
    expect(count(kept, "75.00")).toBe(3); // row 7 has no band
    expect(textOf(kept)).toContain("$250.00");
  });

  it("only the rows with a band: unmapping a row asks its prices again", () => {
    const { kept } = run({ rows: bands.slice(1) });
    expect(count(kept, "300.00")).toBe(1);
    expect(count(kept, "100.00")).toBe(1);
  });

  it("a band on another page consumes nothing here", () => {
    const { kept } = run({ rows: bands.map((b) => ({ ...b, page: 2 })) });
    expect(count(kept, "300.00")).toBe(6);
  });

  it("only amounts and table numbers are consumed by a band, never a percentage or a day count", () => {
    const stuff = { rows: bands };
    const kinds = new Set(gateSweep(left, { evidence: entries, pages, ...stuff }).dropped.map((d) => d.span.kind));
    expect([...kinds].every((k) => k === "amount" || k === "grid_number")).toBe(true);
  });

  describe("the safeguard: a visit the read gave a row no value for", () => {
    // row 1's V2 cell is printed (100.00 at x=360) but the read has no entry for it
    const without = entries.filter((e) => e.path !== "/budgetGrids/0/procedures/0/cells/V2");
    const missedCell = at2(1, 360);
    const leftover = unaccounted(pages, bound.filter((w) => w !== missedCell));
    const go = (ctx: Partial<Parameters<typeof gateSweep>[1]>) => gateSweep(leftover, { evidence: without, pages, rows: bands, ...ctx });
    // "asked" = not consumed by the band (with the master, an amount equal to one of its own could also be dropped as explained: not what is tested)
    const consumed = (r: ReturnType<typeof go>) => r.dropped.some((d) => d.span.words[0] === missedCell && d.reason === "consumed");

    it("is asked when the visit's column can't vouch for it (no printed subtotal, or it fails)", () => {
      expect(consumed(go({}))).toBe(false);
      expect(go({}).kept.some((s) => s.words[0] === missedCell)).toBe(true);
      expect(consumed(go({ rb, vouched: [] }))).toBe(false);
      // another visit's vouching is no proof for this one
      expect(consumed(go({ rb, vouched: ["/budgetGrids/0/visits/0"] }))).toBe(false);
      // without the master the visit's code can't be found, so nothing vouches
      expect(consumed(go({ vouched: ["/budgetGrids/0/visits/1"] }))).toBe(false);
    });

    it("is consumed when the visit's column adds up to a subtotal the page confirms", () => {
      expect(consumed(go({ rb, vouched: ["/budgetGrids/0/visits/1"] }))).toBe(true);
    });

    it("only that price: every other number of the band is still consumed", () => {
      const r = go({});
      expect(r.kept.filter((s) => s.words[0] !== missedCell && ["100.00", "300.00"].includes(s.words[0]!.text))).toEqual([]);
    });

    it("a visit cell the read does have an entry for (even a conflict) is never held back by the safeguard", () => {
      const open = [...without, { ...entry(1, "V2", "conflict") }];
      expect(consumed(gateSweep(leftover, { evidence: open, pages, rows: bands, rb }))).toBe(true);
    });
  });

  it("never gates on the kind of page: a terms page with no band is swept as before, whatever bands other pages have", async () => {
    const both = await read([gridPage(), "BT /F1 8 Tf 40 700 Td (Sponsor will hold back $200.00 of each payment until close-out.) Tj ET\n"]);
    const spans = inventory(both).filter((s) => s.where.page === 2);
    const out = gateSweep(spans, { evidence: [], pages: both, rows: bands });
    expect(textOf(out.kept)).toContain("$200.00");
    expect(out.report.consumed).toBe(0);
  });

  it("changes nothing it was given", () => {
    const before = JSON.stringify([left, pages, entries, bands]);
    deepFreezeAll([left, entries, bands]);
    run({ rows: bands, rb, vouched: ["/budgetGrids/0/visits/1"] });
    expect(JSON.stringify([left, pages, entries, bands])).toBe(before);
  });
});

function deepFreezeAll(xs: unknown[]) {
  for (const x of xs) if (x && typeof x === "object" && !Object.isFrozen(x)) (Object.freeze(x), deepFreezeAll(Object.values(x)));
}

describe("the senior engineer's three table rules", async () => {
  // 1. the inside of a table, in a visit column the page's subtotal vouches for
  const pages = await read([gridPage()]);
  const p = pages[0]!;
  const [W, H] = [612, 792];
  const lineOf = (r: number) => p.words.filter((w) => Math.abs((w.rect[1] + w.rect[3]) / 2 + 3.5 - ROW_Y(r)) < 4);
  const wordAt = (r: number, x: number) => lineOf(r).find((w) => Math.abs(w.rect[0] - x) < 1)!;
  const bandOf = (r: number): RowBand => {
    const [y0, y1] = [(ROW_Y(r) - 9.5) / H, (ROW_Y(r) + 2.5) / H];
    const cell = (x0: number, x1: number): RowBand["box"] => [x0 / W, y0, (x1 - x0) / W, y1 - y0];
    return { grid: 0, procedure: r - 1, documentId: "d1", page: 1, box: cell(30, 500), cells: [{ visit: "V1", box: cell(290, 340), ink: true }, { visit: "V2", box: cell(350, 400), ink: true }], total: null, by: null, covers: null };
  };
  // rows 1-3 and 5-6 are mapped; row 4, in the middle of the table, has no band and no entry
  const mapped = [1, 2, 3, 5, 6];
  const entries = mapped.flatMap((r) => (["V1", "V2"] as const).map((v): ValueEvidence => ({ path: `/budgetGrids/0/procedures/${r - 1}/cells/${v}`, status: "confirmed", where: [boxOf(p, [wordAt(r, v === "V1" ? 300 : 360)])], printed: "100.00", note: null })));
  const bound = mapped.flatMap((r) => [wordAt(r, 300), wordAt(r, 360)]);
  const left = unaccounted(pages, bound);
  const row4 = (r: ReturnType<typeof gateSweep>, kind: "kept" | "dropped") => (kind === "kept" ? r.kept : r.dropped.map((d) => d.span)).filter((s) => Math.abs(mid(s.words[0]!) - ROW_Y(4)) < 4 && ["100.00"].includes(s.words[0]!.text.replace("$", "")) && s.words[0]!.rect[0] < 400);
  const run = (vouched: string[]) => gateSweep(left, { evidence: entries, pages, rb, rows: mapped.map(bandOf), vouched });

  it("a price in an unmapped row of the table, in a visit column the page's subtotal vouches for, is not asked", () => {
    const r = run(["/budgetGrids/0/visits/0", "/budgetGrids/0/visits/1"]);
    expect(row4(r, "kept")).toEqual([]);
    expect(row4(r, "dropped").length).toBeGreaterThan(0);
    expect(r.report.explainedBy.column_vouched).toBeGreaterThan(0);
  });

  it("is not dropped for that reason when no column is vouched for, or only another visit's", () => {
    // (the master's own amounts may still explain a price equal to one of its cells: only this rule is under test)
    const byColumn = (r: ReturnType<typeof gateSweep>) => r.dropped.filter((d) => d.as === "column_vouched").map((d) => Math.round(d.span.words[0]!.rect[0]));
    expect(byColumn(run([]))).toEqual([]);
    // V1 vouched: only the V1 column (x=300) is covered
    expect(new Set(byColumn(run(["/budgetGrids/0/visits/0"])))).toEqual(new Set([300]));
  });

  // 2. counting: every printing of an amount is one of the read's values that cite the page
  it("an amount printed once, with one of the read's values of that amount citing the page, is accounted for; without it, it is asked", async () => {
    const prose = await read([at(40, 100, "A start-up fee of $12,000.00 is due within 45 days of signing.")]);
    const spans = inventory(prose);
    const claim = (n: number): ValueEvidence[] => Array.from({ length: n }, () => ({ path: "/siteFees/0/amountCents", status: "ungrounded" as const, where: [boxOf(prose[0]!, [prose[0]!.words[0]!])], printed: null, note: null }));
    const dropped = gateSweep(spans, { evidence: claim(1), pages: prose, rb });
    expect(dropped.report.explainedBy.price_count).toBe(1);
    expect(textOf(dropped.kept)).not.toContain("$12,000.00");
    expect(textOf(gateSweep(spans, { evidence: [], pages: prose, rb }).kept)).toContain("$12,000.00");
    // printed twice, one value: the second printing is not accounted for
    const twice = await read([[at(40, 100, "A start-up fee of $12,000.00 is due within 45 days of signing."), at(40, 120, "The start-up fee of $12,000.00 is not refundable.")].join("")]);
    const both = gateSweep(inventory(twice), { evidence: claim(1).map((e) => ({ ...e, where: [boxOf(twice[0]!, [twice[0]!.words[0]!])] })), pages: twice, rb });
    expect(textOf(both.kept).filter((t) => t === "$12,000.00")).toHaveLength(2);
  });

  // 3. the overhead pair: a base price and the same plus overhead, both the master's, on a line whose label is garbled
  it("a line printing a master price and the master's price with overhead is that row, whatever its label", async () => {
    const pair = await read([[row(100, "Qzxv wkpl", "300.00", "420.00", "600.00"), row(120, "Qzxv wkpl", "300.00", "425.00", "600.00")].join("")]);
    const out = gateSweep(inventory(pair), { evidence: [], pages: pair, rb });
    const line = (y: number, kept: Span[]) => textOf(kept.filter((s) => Math.abs(mid(s.words[0]!) - y) < 7));
    // the pair is the row; the sum beside it is not part of this rule
    expect(line(100, out.kept)).toEqual(["$600.00"]);
    expect(out.report.explainedBy.overhead_pair).toBeGreaterThan(0);
    // 425.00 is not 300.00 plus 40%: the line is a row the read may have missed
    expect(line(120, out.kept)).toEqual(["$300.00", "$425.00", "$600.00"]);
  });
});
