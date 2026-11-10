import type { Region, Rulebook } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { coverage, quotePlace } from "../src/checks/coverage";
import { buildPage } from "../src/pdf/page";
import { locateVersion, withScans } from "../src/scan";
import type { LocatePage, OcrWord } from "../src/scan/detect";
import { locate } from "../src/scan/match";
import { parseTranscription } from "../src/scan/transcribe";
import type { LoadedDoc } from "../src/types";

// OCR words made by hand, as the real thing would find them: one printed line per entry, words left to right.
type Printed = [y: number, ...words: [text: string, x: number][]];
const HEIGHT = 0.012;
const ocrOf = (...lines: Printed[]): OcrWord[] =>
  lines.flatMap(([y, ...words], line) => words.map(([text, x]): OcrWord => ({ text, line: line + 1, box: [x, y, x + 0.008 * text.length, y + HEIGHT] })));

const read = (text: string) => parseTranscription({ rotation: 0, text });
const boxOf = (l: ReturnType<typeof locate>, id: string, index = 0) => l.words[id]![index];
const holds = (outer: Region, y: number) => outer[1] <= y && y <= outer[3];

// a fees table with a row of repeats
const FEES = "T 0.10-0.30 | Fees\nH | Item | V1 | V2 | V3\nR 0.15-0.16 | Screening | $50.00 | $50.00 | $50.00\nR 0.20-0.21 | Follow-up | $75.00 | $75.00 | $75.00";
const FEES_OCR: Printed[] = [
  [0.1, ["Fees", 0.1]],
  [0.13, ["Item", 0.1], ["V1", 0.4], ["V2", 0.55], ["V3", 0.7]],
  [0.155, ["Screening", 0.1], ["$50.00", 0.4], ["$50.00", 0.55], ["$50.00", 0.7]],
  [0.205, ["Follow-up", 0.1], ["$75.00", 0.4], ["$75.00", 0.55], ["$75.00", 0.7]],
];

describe("locate", () => {
  it("tells repeated amounts apart by their column order, and puts each in its own cell", () => {
    const l = locate(1, read(FEES), ocrOf(...FEES_OCR));
    expect([2, 3, 4].map((c) => boxOf(l, `p1.t1.r1.c${c - 1}`)![0])).toEqual([0.4, 0.55, 0.7]);
    expect([1, 2, 3].map((c) => boxOf(l, `p1.t1.r2.c${c}`)![0])).toEqual([0.4, 0.55, 0.7]);
    expect(boxOf(l, "p1.t1.r2.c1")![1]).toBeCloseTo(0.205);
    expect(l.rows["p1.t1.r2"]).toEqual([0, expect.closeTo(0.203, 3), 1, expect.closeTo(0.219, 3)]);
  });

  it("leaves the repeats a row has fewer of than the transcription unplaced, and still finds the row", () => {
    const missed = FEES_OCR.map((p, i): Printed => (i === 2 ? [p[0], p[1]!, p[2]!, p[4]!] : p));
    const l = locate(1, read(FEES), ocrOf(...missed));
    // which of three amounts the two found are is not knowable: none is claimed
    expect([1, 2, 3].map((c) => boxOf(l, `p1.t1.r1.c${c}`))).toEqual([null, null, null]);
    expect(l.rows["p1.t1.r1"]).toBeDefined();
    expect(boxOf(l, "p1.t1.r2.c2")![0]).toBe(0.55);
  });

  it("keeps a blank cell blank and the cells after it under their own columns", () => {
    const text = "T 0.1-0.3 | Fees\nH | Item | V1 | V2 | V3\nR 0.15-0.16 | Screening | $50.00 | | $90.00";
    const l = locate(1, read(text), ocrOf([0.1, ["Fees", 0.1]], [0.13, ["Item", 0.1], ["V1", 0.4], ["V2", 0.55], ["V3", 0.7]], [0.155, ["Screening", 0.1], ["$50.00", 0.4], ["$90.00", 0.7]]));
    expect(boxOf(l, "p1.t1.r1.c1")![0]).toBe(0.4);
    expect(l.words["p1.t1.r1.c2"]).toEqual([]);
    expect(boxOf(l, "p1.t1.r1.c3")![0]).toBe(0.7);
  });

  it("finds a row whose label OCR misread by a character, and an amount only if its own digits were found", () => {
    const text = "T 0.1-0.3 | Fees\nH | Item | V1 | V2\nR 0.15-0.16 | Screening visit | $50.00 | $120.00";
    const l = locate(1, read(text), ocrOf([0.1, ["Fees", 0.1]], [0.13, ["Item", 0.1], ["V1", 0.4], ["V2", 0.55]], [0.155, ["Screenlng", 0.1], ["visit", 0.16], ["$50.00", 0.4], ["$l20.O0", 0.55]]));
    expect(l.rows["p1.t1.r1"]).toBeDefined();
    expect(boxOf(l, "p1.t1.r1.c0")).not.toBeNull();
    expect(boxOf(l, "p1.t1.r1.c1")![0]).toBe(0.4);
    // O/0 and l/1 slips fold together, as in the amount check, so the same digits still count
    expect(boxOf(l, "p1.t1.r1.c2")![0]).toBe(0.55);
    const wrong = locate(1, read(text), ocrOf([0.1, ["Fees", 0.1]], [0.13, ["Item", 0.1], ["V1", 0.4], ["V2", 0.55]], [0.155, ["Screening", 0.1], ["visit", 0.16], ["$50.00", 0.4], ["$128.00", 0.55]]));
    expect(wrong.rows["p1.t1.r1"]).toBeDefined();
    expect(boxOf(wrong, "p1.t1.r1.c2")).toBeNull();
  });

  it("puts a row OCR missed in a band between its found neighbours that holds its true place", () => {
    const missed = FEES_OCR.filter((_, i) => i !== 2);
    const text = `${FEES}\nR 0.25-0.26 | Closeout | $900.00 | $900.00 | $900.00`;
    const l = locate(1, read(text), ocrOf(...missed, [0.255, ["Closeout", 0.1], ["$900.00", 0.4], ["$900.00", 0.55], ["$900.00", 0.7]]));
    expect(l.rows["p1.t1.r1"]).toBeUndefined();
    expect(l.words["p1.t1.r1.c1"]![0]).toBeNull();
    const band = l.bands["p1.t1.r1"]!;
    expect(holds(band, 0.155)).toBe(true);
    // from the lines found above it to the ones found below, each reached into by a line's height: it stays near its place
    expect(band[1]).toBeGreaterThan(0.08);
    expect(band[1]).toBeLessThan(0.15);
    expect(band[3]).toBeGreaterThan(0.2);
    expect(band[3]).toBeLessThan(0.28);
    expect(band[0]).toBe(0);
    expect(band[2]).toBe(1);
  });

  it("orders two tables with the same rows by their order on the page, and never gives one the other's row", () => {
    const two = "T 0.10-0.20 | Site\nH | Item | Fee\nR 0.15-0.16 | Screening | $50.00\nT 0.40-0.50 | Sponsor\nH | Item | Fee\nR 0.45-0.46 | Screening | $50.00";
    const both = ocrOf([0.1, ["Site", 0.1]], [0.13, ["Item", 0.1], ["Fee", 0.5]], [0.155, ["Screening", 0.1], ["$50.00", 0.5]], [0.4, ["Sponsor", 0.1]], [0.43, ["Item", 0.1], ["Fee", 0.5]], [0.455, ["Screening", 0.1], ["$50.00", 0.5]]);
    const l = locate(1, read(two), both);
    expect(boxOf(l, "p1.t1.r1.c1")![1]).toBeCloseTo(0.155);
    expect(boxOf(l, "p1.t2.r1.c1")![1]).toBeCloseTo(0.455);

    // the first table's row was missed: the one row left is the second's (its heading is right above it), and the first's is
    // not claimed on that same row, but placed between its neighbours
    const onlySecond = ocrOf([0.1, ["Site", 0.1]], [0.13, ["Item", 0.1], ["Fee", 0.5]], [0.4, ["Sponsor", 0.1]], [0.43, ["Item", 0.1], ["Fee", 0.5]], [0.455, ["Screening", 0.1], ["$50.00", 0.5]]);
    const m = locate(1, read(two), onlySecond);
    expect(m.words["p1.t1.r1.c1"]![0]).toBeNull();
    expect(m.words["p1.t2.r1.c1"]![0]![1]).toBeCloseTo(0.455);
    expect(holds(m.bands["p1.t1.r1"]!, 0.155)).toBe(true);
    expect(m.rows["p1.t1.r1"]).toBeUndefined();
  });

  it("claims neither of two identical rows when OCR found only one, so a mark is never confidently wrong", () => {
    const text = "T 0.1-0.3 | Fees\nH | Item | Fee\nR 0.15-0.16 | Unscheduled | $50.00\nR 0.20-0.21 | Unscheduled | $50.00";
    const found = ocrOf([0.1, ["Fees", 0.1]], [0.13, ["Item", 0.1], ["Fee", 0.5]], [0.205, ["Unscheduled", 0.1], ["$50.00", 0.5]]);
    const l = locate(1, read(text), found);
    expect(l.words["p1.t1.r1.c1"]![0]).toBeNull();
    expect(l.words["p1.t1.r2.c1"]![0]).toBeNull();
    // both are approximate, in bands that hold the one found row and so each holds its own place
    expect(holds(l.bands["p1.t1.r1"] ?? l.rows["p1.t1.r1"]!, 0.155)).toBe(true);
    expect(holds(l.bands["p1.t1.r2"] ?? l.rows["p1.t1.r2"]!, 0.205)).toBe(true);
  });

  it("without any located neighbour draws today's stripe, padded", () => {
    const l = locate(1, read("L 0.500-0.520 | Startup fee $1,234.56"), []);
    expect(l.rows).toEqual({});
    expect(l.bands["p1.l1"]![1]).toBeLessThan(0.5);
    expect(l.bands["p1.l1"]![3]).toBeGreaterThan(0.52);
  });
});

describe("locate: amounts a first pass can't settle", () => {
  const head = "T 0.1-0.3 | Fees\nH | Item | V1 | V2 | V3";
  const top: Printed[] = [[0.1, ["Fees", 0.1]], [0.13, ["Item", 0.1], ["V1", 0.4], ["V2", 0.55], ["V3", 0.7]]];

  // a row OCR found no amounts for sits above one that has them, so the two rows' equal amounts can't be ordered by the
  // lining up as a whole; inside the second row's own printed line the count of copies settles them
  const twoRows = `${head}\nR 0.15-0.16 | Alphabetical | $50.00 | $50.00 | $50.00\nR 0.20-0.21 | Bravissimo | $50.00 | $50.00 | $50.00`;

  it("settles repeats inside a placed row by column order when the counts of copies and free words are equal", () => {
    const l = locate(1, read(twoRows), ocrOf(...top, [0.155, ["Alphabetical", 0.1]], [0.205, ["Bravissimo", 0.1], ["$50.00", 0.4], ["$50.00", 0.55], ["$50.00", 0.7]]));
    expect([1, 2, 3].map((c) => boxOf(l, `p1.t1.r2.c${c}`)![0])).toEqual([0.4, 0.55, 0.7]);
    expect(boxOf(l, "p1.t1.r2.c1")![1]).toBeCloseTo(0.205);
    // the row above has no free word on its own line, so its amounts stay unplaced
    expect([1, 2, 3].map((c) => boxOf(l, `p1.t1.r1.c${c}`))).toEqual([null, null, null]);
  });

  it("leaves them approximate when the counts differ", () => {
    const l = locate(1, read(twoRows), ocrOf(...top, [0.155, ["Alphabetical", 0.1]], [0.205, ["Bravissimo", 0.1], ["$50.00", 0.4], ["$50.00", 0.7]]));
    expect([1, 2, 3].map((c) => boxOf(l, `p1.t1.r2.c${c}`))).toEqual([null, null, null]);
  });

  it("accepts an amount by its digits when OCR glued a letter or sign to it, but not a short number, a different amount, or three extra marks", () => {
    const text = `${head}\nR 0.15-0.16 | Screening | $1,500.00 | $500.00 | $1,200.00 | 8`;
    const glued = locate(1, read(text), ocrOf(...top, [0.155, ["Screening", 0.1], ["S1,500.00", 0.4], ["$50,000", 0.55], ["ABC1,200.00", 0.7], ["x8", 0.8]]));
    expect(boxOf(glued, "p1.t1.r1.c1")![0]).toBe(0.4);
    // same digits as $500.00, but not the same amount
    expect(boxOf(glued, "p1.t1.r1.c2")).toBeNull();
    expect(boxOf(glued, "p1.t1.r1.c3")).toBeNull();
    // a bare number is not an amount, so a digit match isn't enough
    expect(boxOf(glued, "p1.t1.r1.c4")).toBeNull();
    expect(boxOf(locate(1, read("L 0.1-0.12 | Screening visit $5"), ocrOf([0.11, ["Screening", 0.1], ["visit", 0.3], ["S5", 0.4]])), "p1.l1", 2)).toBeNull();
  });

  // the middle row's label is too short for OCR's words to place it; its amount is the only one of its digits in its band
  const middle = (amount: string) => `${head}\nR 0.15-0.16 | Alphabetical | $10.00\nR 0.20-0.21 | Zz | ${amount}\nR 0.25-0.26 | Gammarays | $30.00`;
  const around: Printed[] = [[0.155, ["Alphabetical", 0.1], ["$10.00", 0.4]], [0.255, ["Gammarays", 0.1], ["$30.00", 0.4]]];

  it("gives an amount its own box inside the band of a row that was not placed, and leaves the row's boxes as the band", () => {
    const l = locate(1, read(middle("$77.00")), ocrOf(...top, ...around, [0.205, ["$77.00", 0.4]]));
    expect(l.rows["p1.t1.r2"]).toBeUndefined();
    expect(holds(l.bands["p1.t1.r2"]!, 0.205)).toBe(true);
    expect(boxOf(l, "p1.t1.r2.c1")![0]).toBe(0.4);
    expect(boxOf(l, "p1.t1.r2.c1")![1]).toBeCloseTo(0.205);
  });

  it("does not, when two unplaced rows whose bands overlap want the same digits", () => {
    const text = `${head}\nR 0.15-0.16 | Alphabetical | $10.00\nR 0.20-0.21 | Zz | $77.00\nR 0.22-0.23 | Yy | $77.00\nR 0.25-0.26 | Gammarays | $30.00`;
    const l = locate(1, read(text), ocrOf(...top, ...around, [0.205, ["$77.00", 0.4]]));
    expect(boxOf(l, "p1.t1.r2.c1")).toBeNull();
    expect(boxOf(l, "p1.t1.r3.c1")).toBeNull();
  });

  it("does not take a word on a placed row's own line, or when two words in the band have the digits", () => {
    const onLine = locate(1, read(middle("$10.00")), ocrOf(...top, ...around));
    expect(boxOf(onLine, "p1.t1.r2.c1")).toBeNull();
    const two = locate(1, read(middle("$77.00")), ocrOf(...top, ...around, [0.205, ["$77.00", 0.4]], [0.23, ["$77.00", 0.4]]));
    expect(boxOf(two, "p1.t1.r2.c1")).toBeNull();
  });
});

describe("on a located scan page", () => {
  const image = (): LoadedDoc => ({ name: "s.pdf", path: "/x/s.pdf", sha256: "x", pages: [buildPage(1, [], "image")] });
  const open = (text: string, printed: Printed[], second?: string) => {
    const saved = [{ page: 1, version: "v", rotation: 0, transcription: read(text) }];
    const found: LocatePage = { page: 1, version: locateVersion, rotation: 0, words: ocrOf(...printed) };
    const verified = second ? [{ page: 1, version: "verify-1 m", rotation: 0, transcription: read(second) }] : [];
    return withScans(image(), saved, verified, [found]);
  };
  const empty = { study: { documents: [] }, terms: [], grids: [], accounted: [], questions: [] } as unknown as Rulebook;

  it("marks each amount exactly where its own digits are, with no flag", () => {
    const amounts = coverage(empty, [open(FEES, FEES_OCR)]).pages[0]!.amounts;
    expect(amounts).toHaveLength(6);
    expect(amounts.every((a) => a.approx === undefined)).toBe(true);
    expect(amounts.slice(0, 3).map((a) => a.box[0])).toEqual([0.4, 0.55, 0.7]);
    expect(amounts[0]!.box[2] - amounts[0]!.box[0]).toBeLessThan(0.1);
  });

  it("flags an amount whose digits weren't found as approximate, drawn as its row", () => {
    const printed = FEES_OCR.map((p, i): Printed => (i === 3 ? [p[0], p[1]!, ["$75.00", 0.4], ["$75.00", 0.55], ["$75.08", 0.7]] : p));
    const amounts = coverage(empty, [open(FEES, printed)]).pages[0]!.amounts;
    const last = amounts.at(-1)!;
    expect(last.approx).toBe(true);
    expect(last.box[0]).toBe(0);
    expect(last.box[2]).toBe(1);
    expect(holds(last.box, 0.205)).toBe(true);
    expect(last.box[3] - last.box[1]).toBeLessThan(0.05);
    // the Screening row is whole; the other's three $75.00 are two found, so which two can't be told and none is claimed
    expect(amounts.slice(0, 3).every((a) => a.approx === undefined)).toBe(true);
    expect(amounts.slice(3).every((a) => a.approx === true)).toBe(true);
  });

  it("a page with no located words is approximate everywhere, as the stripes are today", () => {
    const doc = withScans(image(), [{ page: 1, version: "v", rotation: 0, transcription: read(FEES) }]);
    const found = coverage(empty, [doc]).pages[0]!.amounts;
    expect(found.every((a) => a.approx === true && a.box[0] === 0 && a.box[2] === 1)).toBe(true);
  });

  it("marks an amount only the second read found where its words are", () => {
    const first = "L 0.100-0.120 | Startup fee $1,234.56";
    const second = "L 0.100-0.120 | Startup fee $1,234.56\nL 0.300-0.320 | Closeout fee $400.00";
    const page = coverage(empty, [open(first, [[0.11, ["Startup", 0.1], ["fee", 0.2], ["$1,234.56", 0.3]], [0.31, ["Closeout", 0.1], ["fee", 0.2], ["$400.00", 0.3]]], second)]).pages[0]!;
    const missed = page.amounts.find((a) => a.secondRead)!;
    expect(missed.cents).toBe(40000);
    expect(missed.approx).toBeUndefined();
    expect(missed.box[0]).toBe(0.3);
    expect(missed.box[1]).toBeCloseTo(0.31);
  });

  it("boxes a quote that wraps over two lines once per printed line, and never flags a text page", () => {
    const text = "L 0.100-0.112 | The sponsor pays the institution within\nL 0.120-0.132 | forty-five days of an itemized invoice";
    const doc = open(text, [[0.1, ["The", 0.1], ["sponsor", 0.15], ["pays", 0.25], ["the", 0.3], ["institution", 0.35], ["within", 0.5]], [0.12, ["forty-five", 0.1], ["days", 0.22], ["of", 0.3], ["an", 0.33], ["itemized", 0.37], ["invoice", 0.5]]]);
    const spot = quotePlace(doc.pages[0]!, "institution within forty-five days");
    expect(spot.approx).toBeUndefined();
    expect(spot.boxes).toHaveLength(2);
    expect(spot.boxes[0]![0]).toBe(0.35);
    expect(spot.boxes[1]![1]).toBeCloseTo(0.12);
    expect(quotePlace({ ...doc.pages[0]!, kind: "text" }, "institution within").approx).toBeUndefined();
  });

  it("flags a quote one of whose words OCR missed, with the row around it", () => {
    const text = "L 0.100-0.112 | The sponsor pays the institution within";
    const doc = open(text, [[0.1, ["The", 0.1], ["sponsor", 0.15], ["pays", 0.25], ["the", 0.3], ["within", 0.5]]]);
    const spot = quotePlace(doc.pages[0]!, "pays the institution within");
    expect(spot.approx).toBe(true);
    expect(holds(spot.boxes[0]!, 0.105)).toBe(true);
  });
});
