import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checks } from "../src/checks";
import { coverage, findQuote } from "../src/checks/coverage";
import { pdfReader } from "../src/pdf";
import type { LoadedDoc, Word } from "../src/types";
import { ocrWordsOf } from "./words";

type Term = Rulebook["terms"][number];
type Grid = Rulebook["grids"][number];
type Draw = (text: string, x: number, y: number) => void;

let dir: string;
let contract: LoadedDoc;
let scan: LoadedDoc;
let protocol: LoadedDoc;

const FILLER = ["The sponsor pays the institution within forty-five days of an itemized invoice for work done under this agreement.", "Either party may end this agreement by written notice if the other fails to correct a breach within thirty days."];
const filler = (draw: Draw) => FILLER.forEach((l, i) => draw(l, 50, 700 - i * 14));

async function load(name: string, pages: ((draw: Draw) => void)[]): Promise<LoadedDoc> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const fill of pages) {
    const page = pdf.addPage([612, 792]);
    fill((text, x, y) => page.drawText(text, { x, y, size: 10, font }));
  }
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return { ...(await pdfReader.load(path)), name };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-coverage-"));
  contract = await load("contract.pdf", [
    (draw) => {
      filler(draw);
      draw("Startup fee of $1,500.00 is due on signing.", 50, 650);
      draw("The sponsor pays a $", 50, 630);
      draw("2,000.00", 152, 630);
      draw("per screen failure, and the parties agree that", 50, 616);
      draw("a bonus of $75.00 applies.", 50, 602);
      draw("Insurance limit $1,000,000.00 per claim.", 50, 580);
      draw("Stray charge $9.99 appears here.", 50, 560);
      draw("Nothing due: $0.00.", 50, 540);
    },
    (draw) => {
      filler(draw);
      draw("Superseded budget total $12,345.00 is replaced.", 50, 650);
      draw("Other old figure $222.22 too.", 50, 630);
    },
  ]);
  scan = { ...contract, name: "scan.pdf", pages: [{ ...contract.pages[0]!, kind: "image", words: [], layout: "", raw: "" }] };
  protocol = await load("protocol.pdf", [
    (draw) => {
      filler(draw);
      draw("Compensation of $500.00 is described elsewhere.", 50, 650);
    },
  ]);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const term = (id: string, over: Partial<Term> = {}): Term => ({
  id, category: "site_fee", name: id, amountCents: null, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null,
  conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null,
  source: { doc: "contract.pdf", page: 1, quote: "Startup fee" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const grid = (over: Partial<Grid> = {}): Grid => ({
  id: "g1", name: "Budget", arm: null, doc: "contract.pdf", pages: [2], visits: ["V1", "V2"], overheadPct: null,
  rows: [], subtotal: null, overhead: null, additions: [], total: null, grandTotalCents: null, cellsReadTwice: [], ...over,
});

const rulebook = (over: Partial<Rulebook> = {}): Rulebook => ({
  study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] },
  terms: [], grids: [], accounted: [], questions: [], ...over,
});

const page1 = (rb: Rulebook) => coverage(rb, [contract]).pages[0]!;
const amount = (rb: Rulebook, cents: number) => page1(rb).amounts.find((a) => a.cents === cents)!;

describe("coverage amounts", () => {
  it("finds every printed amount, whole or split over two words, with the union of its words as the box", () => {
    const amounts = page1(rulebook()).amounts;
    expect(amounts.map((a) => a.cents)).toEqual([150000, 200000, 7500, 100000000, 999]);
    const split = amounts.find((a) => a.cents === 200000)!;
    expect(split.text).toBe("$ 2,000.00");
    const [x0, y0, x1, y1] = split.box;
    expect(x0).toBeLessThan(150 / 612);
    expect(x1).toBeGreaterThan(190 / 612);
    expect(y1).toBeGreaterThan(y0);
    const whole = amounts[0]!.box;
    expect(whole[0]).toBeGreaterThan(100 / 612);
    expect(whole[2]).toBeLessThan(220 / 612);
  });

  it("marks a term's amount, and a cap's amount, as captured with a ref to the term", () => {
    const rb = rulebook({ terms: [term("fee", { amountCents: 150000 }), term("cap", { cap: { kind: "amount", value: 100000000, period: null, text: "" } }), term("count", { cap: { kind: "count", value: 999, period: null, text: "" } })] });
    expect(amount(rb, 150000)).toMatchObject({ status: "captured", ref: { target: "term", id: "fee" }, reason: null });
    expect(amount(rb, 100000000)).toMatchObject({ status: "captured", ref: { target: "term", id: "cap" } });
    expect(amount(rb, 999).status).toBe("missing");
  });

  it("marks an amount a person decided", () => {
    expect(amount(rulebook({ terms: [term("fee", { amountCents: 150000, evidence: "person" })] }), 150000)).toMatchObject({ status: "decided", ref: { target: "term", id: "fee" } });
  });

  it("matches grid cells by row and visit, printed lines with row -1, and unit costs and row totals by row", () => {
    const rb = rulebook({
      grids: [grid({ pages: [1], rows: [{ name: "Exam", code: null, unitCostCents: 7500, cells: [null, 150000], printedRowTotalCents: 200000 }], subtotal: [null, 999] })],
    });
    expect(amount(rb, 150000).ref).toEqual({ target: "grid", id: "g1", row: 0, col: 1 });
    expect(amount(rb, 7500).ref).toEqual({ target: "grid", id: "g1", row: 0, col: -1 });
    expect(amount(rb, 200000).ref).toEqual({ target: "grid", id: "g1", row: 0, col: -1 });
    expect(amount(rb, 999).ref).toEqual({ target: "grid", id: "g1", row: -1, col: 1 });
  });

  it("matches overhead, additions, total and grand total lines", () => {
    const rb = rulebook({ grids: [grid({ pages: [1], overhead: [150000], additions: [{ name: "Stipend", cells: [null, 7500] }], total: [200000], grandTotalCents: 999 })] });
    expect([150000, 7500, 200000, 999].map((c) => amount(rb, c).ref)).toEqual([
      { target: "grid", id: "g1", row: -1, col: 0 }, { target: "grid", id: "g1", row: -1, col: 1 }, { target: "grid", id: "g1", row: -1, col: 0 }, { target: "grid", id: "g1", row: -1, col: -1 },
    ]);
  });

  it("compares credits by magnitude", () => {
    expect(amount(rulebook({ terms: [term("credit", { amountCents: -7500 })] }), 7500).status).toBe("captured");
  });

  it("prefers a match from this document and page over one elsewhere", () => {
    const elsewhere = term("other", { amountCents: 150000, source: { doc: "contract.pdf", page: 2, quote: "x" } });
    const here = term("here", { amountCents: 150000 });
    expect(amount(rulebook({ terms: [elsewhere, here] }), 150000).ref).toEqual({ target: "term", id: "here" });
    expect(amount(rulebook({ terms: [elsewhere] }), 150000).ref).toEqual({ target: "term", id: "other" });
    expect(amount(rulebook({ grids: [grid({ pages: [1], total: [150000] })], terms: [elsewhere] }), 150000).ref).toMatchObject({ target: "grid" });
  });

  it("sets aside an amount listed for this page, or every amount on a listed page, with the reason", () => {
    const one = rulebook({ accounted: [{ doc: "contract.pdf", page: 1, amountCents: 100000000, reason: "insurance limit" }] });
    expect(amount(one, 100000000)).toMatchObject({ status: "set_aside", reason: "insurance limit", ref: null });
    expect(amount(one, 999).status).toBe("missing");
    // as in the every-dollar check, an amount set aside on another page still counts as set aside
    const otherPage = rulebook({ accounted: [{ doc: "contract.pdf", page: 2, amountCents: 100000000, reason: "x" }] });
    expect(amount(otherPage, 100000000)).toMatchObject({ status: "set_aside", reason: "x" });
    const whole = rulebook({ accounted: [{ doc: "contract.pdf", pages: [1], reason: "old budget" }] });
    expect(page1(whole).amounts.every((a) => a.status === "set_aside" && a.reason === "old budget")).toBe(true);
  });

  it("lets a captured value win over a set-aside one", () => {
    const rb = rulebook({ terms: [term("fee", { amountCents: 150000 })], accounted: [{ doc: "contract.pdf", page: 1, amountCents: 150000, reason: "r" }] });
    expect(amount(rb, 150000).status).toBe("captured");
  });

  it("leaves $0.00 out, as the every-dollar check does", () => {
    expect(page1(rulebook()).amounts.some((a) => a.cents === 0)).toBe(false);
  });

  it("lists scanned pages without amounts or clauses", () => {
    const rb = rulebook({ terms: [term("fee", { amountCents: 150000 })] });
    expect(coverage(rb, [scan]).pages).toEqual([{ doc: "scan.pdf", page: 1, kind: "image", amounts: [], clauses: [] }]);
  });

  it("skips documents with no money, but not those missing from the study's list", () => {
    const role = { doc: "protocol.pdf", role: "protocol" as const, hasMoney: false, supersedes: [], effectiveFrom: null, retroactive: false, notes: null };
    const study = rulebook().study;
    expect(coverage(rulebook({ study: { ...study, documents: [role] } }), [contract, protocol]).pages.map((p) => p.doc)).toEqual(["contract.pdf", "contract.pdf"]);
    expect(coverage(rulebook({ study: { ...study, documents: [{ ...role, hasMoney: true }] } }), [protocol]).pages).toHaveLength(1);
    expect(coverage(rulebook(), [protocol]).pages[0]!.amounts).toHaveLength(1);
  });

  it("totals the amounts of every page", () => {
    const rb = rulebook({
      terms: [term("fee", { amountCents: 150000 }), term("bonus", { amountCents: 7500, evidence: "person" })],
      accounted: [{ doc: "contract.pdf", page: 1, amountCents: 100000000, reason: "limit" }, { doc: "contract.pdf", pages: [2], reason: "old" }],
    });
    const { totals, pages } = coverage(rb, [contract, scan]);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 1]);
    expect(totals).toEqual({ amounts: 7, captured: 1, decided: 1, setAside: 3, missing: 2 });
  });
});

describe("coverage clauses", () => {
  it("boxes the words of each term's quote on its page, one box per line", () => {
    const rb = rulebook({
      terms: [
        term("fee", { amountCents: 150000, source: { doc: "contract.pdf", page: 1, quote: "Startup fee of $1,500.00 is due on signing." } }),
        term("two-lines", { source: { doc: "contract.pdf", page: 1, quote: "per screen failure, and the PARTIES agree that a bonus of $75.00" } }),
        term("missing", { source: { doc: "contract.pdf", page: 1, quote: "this sentence is not printed" } }),
        term("elsewhere", { source: { doc: "contract.pdf", page: 2, quote: "Other old figure" } }),
      ],
    });
    const { clauses } = page1(rb);
    expect(clauses.map((c) => [c.termId, c.boxes.length])).toEqual([["fee", 1], ["two-lines", 2]]);
    const [x0, y0, x1, y1] = clauses[0]!.boxes[0]!;
    expect(x0).toBeCloseTo(50 / 612, 1);
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
    expect(coverage(rb, [contract]).pages[1]!.clauses.map((c) => c.termId)).toEqual(["elsewhere"]);
  });
});

describe("findQuote", () => {
  const w = (text: string, x0: number, y0 = 0.1): Word => ({ text, x0, x1: x0 + 0.05, y0, y1: y0 + 0.02 });
  const words = [w("The", 0.1), w("Sponsor's", 0.2), w("fee,", 0.3), w("$", 0.4), w("5,000.00", 0.45), w("applies.", 0.1, 0.2), w("Coffee", 0.2, 0.2)];

  const closeTo = (boxes: number[][], expected: number[][]) => {
    expect(boxes).toHaveLength(expected.length);
    boxes.forEach((box, i) => box.forEach((v, j) => expect(v).toBeCloseTo(expected[i]![j]!, 6)));
  };

  it("matches ignoring case, spacing and punctuation attached to words", () => {
    closeTo(findQuote(words, "sponsor’s   FEE $5,000.00"), [[0.2, 0.1, 0.5, 0.12]]);
    closeTo(findQuote(words, "the sponsors fee"), [[0.1, 0.1, 0.35, 0.12]]);
  });

  it("returns a box per line when the quote runs over lines", () => {
    closeTo(findQuote(words, "$5,000.00 applies"), [[0.45, 0.1, 0.5, 0.12], [0.1, 0.2, 0.15, 0.22]]);
  });

  it("matches whole words only, and finds nothing for a missing quote, an empty one or a page without words", () => {
    expect(findQuote(words, "fee")).toHaveLength(1);
    expect(findQuote(words, "offee")).toEqual([]);
    expect(findQuote(words, "the fee")).toEqual([]);
    expect(findQuote(words, " ")).toEqual([]);
    expect(findQuote([], "the")).toEqual([]);
  });
});

describe("coverage and the every-dollar check", () => {
  it("are one computation: money written in a rule's words is captured, and a red amount is exactly an unaccounted one", () => {
    const rb = rulebook({ terms: [term("sf", { amountCents: null, formula: "100% of $1,500.00 for Visit 1" })] });
    const missing = coverage(rb, [contract]).pages.flatMap((p) => p.amounts.filter((a) => a.status === "missing").map((a) => a.cents));
    expect([...new Set(missing)].sort()).toEqual(checks.unaccounted(rb, [contract]).map((u) => u.amountCents).sort());
    expect(missing).not.toContain(150000);
  });
});

describe("coverage on an OCR page", () => {
  const layout = "Startup fee $1,2OO.OO due\nVisit 1 200.00 and S9.99 extra";
  const words = ocrWordsOf(layout).map((w) => (w.text === "$1,2OO.OO" ? { ...w, confidence: 60 } : w.text === "S9.99" ? { ...w, confidence: 40 } : w));
  const ocr: LoadedDoc = { name: "ocr.pdf", path: "/x/ocr.pdf", sha256: "0", pages: [{ page: 1, kind: "ocr", layout, raw: layout, words, maskBoxes: [], firstLine: "", confidence: 90, rotation: 0 }] };
  const amounts = (rb: Rulebook) => coverage(rb, [ocr]).pages[0]!.amounts;

  it("matches rulebook values despite OCR slips, and carries OCR's confidence for each amount", () => {
    const rb = rulebook({ terms: [term("fee", { amountCents: 120000, source: { doc: "ocr.pdf", page: 1, quote: "Startup fee" } })] });
    expect(amounts(rb).map((a) => [a.cents, a.status, a.confidence])).toEqual([[120000, "captured", 60], [120000, "captured", 90], [999, "missing", 40]]);
  });

  it("is null on a page with a text layer", () => {
    expect(page1(rulebook()).amounts.every((a) => a.confidence === null)).toBe(true);
  });
});
