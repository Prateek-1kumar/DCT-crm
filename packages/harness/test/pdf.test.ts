import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { amountsIn } from "../src/checks/text";
import { pdfReader } from "../src/pdf";
import type { LoadedDoc } from "../src/types";

const PAGE_W = 612;
const PAGE_H = 792;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-pdf-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function pdfFile(name: string, draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  draw(pdf.addPage([PAGE_W, PAGE_H]), font);
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return path;
}

const budget = [
  ["Screening visit", "$1,200.00", "$950.00", "$75.00"],
  ["Baseline visit", "$2,400.50", "$1,100.00", "$80.00"],
  ["Week 4 follow-up", "$310.00", "$99.99", "$5.00"],
];

const budgetPage = () =>
  pdfFile("budget.pdf", (page, font) => {
    page.drawText("Exhibit A Budget", { x: 50, y: 740, size: 14, font });
    budget.forEach((row, i) => row.forEach((cell, c) => page.drawText(cell, { x: [50, 260, 360, 460][c]!, y: 700 - i * 20, size: 10, font })));
    page.drawText("Payment terms: Sponsor pays Institution within forty-five days of an itemized invoice for work done under this budget.", { x: 50, y: 600, size: 9, font });
  });

const bankPage = () =>
  pdfFile("bank.pdf", (page, font) => {
    page.drawText("Account Number: 123456789", { x: 50, y: 700, size: 11, font });
    page.drawText("ABA Routing 000111222", { x: 50, y: 680, size: 11, font });
    page.drawText("Startup fee $1,234.56", { x: 50, y: 660, size: 11, font });
    page.drawText("Bank Account Number", { x: 50, y: 620, size: 11, font });
    page.drawText("900123456", { x: 50, y: 605, size: 11, font });
    page.drawText("IBAN: GB29 NWBK 6016 1331 9268 19", { x: 50, y: 580, size: 11, font });
    page.drawText("SWIFT: TESTUS33", { x: 50, y: 560, size: 11, font });
    page.drawText("Acct: 246,813,579", { x: 50, y: 540, size: 11, font });
    page.drawText("Bank fee $25.00 per wire, account review in 12 months", { x: 50, y: 520, size: 11, font });
    page.drawText("Acct#900765432 and ABA/Routing:000333444", { x: 50, y: 500, size: 11, font });
    page.drawText("Bank Account Number for ACH wire transfers: 900555666", { x: 50, y: 480, size: 11, font });
  });

describe("load", () => {
  let doc: LoadedDoc;
  beforeAll(async () => {
    doc = await pdfReader.load(await budgetPage());
  });

  it("reads a text page with its hash and name", () => {
    expect(doc.name).toBe("budget.pdf");
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]).toMatchObject({ page: 1, kind: "text", firstLine: "Exhibit A Budget" });
  });

  it("keeps amounts of one column at the same character offset across rows", () => {
    const rows = doc.pages[0]!.layout.split("\n").slice(1, 4);
    expect(rows).toHaveLength(3);
    for (const col of [1, 2, 3]) {
      const offsets = rows.map((row, i) => row.indexOf(budget[i]![col]!));
      expect(offsets.every((o) => o > 0)).toBe(true);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1);
    }
  });

  it("puts words in reading order in raw", () => {
    expect(doc.pages[0]!.raw.split("\n")[1]).toBe("Screening visit $1,200.00 $950.00 $75.00");
  });

  it("gives every word a box inside the page", () => {
    const words = doc.pages[0]!.words;
    expect(words.map((w) => w.text)).toContain("$1,200.00");
    for (const w of words) {
      expect(w.x0).toBeGreaterThanOrEqual(0);
      expect(w.x1).toBeLessThanOrEqual(1);
      expect(w.y0).toBeGreaterThanOrEqual(0);
      expect(w.y1).toBeLessThanOrEqual(1);
      expect(w.x1).toBeGreaterThan(w.x0);
      expect(w.y1).toBeGreaterThan(w.y0);
    }
    const title = words.find((w) => w.text === "Exhibit")!;
    expect(title.x0).toBeCloseTo(50 / PAGE_W, 1);
    expect(title.y0).toBeCloseTo((PAGE_H - 740 - 14) / PAGE_H, 1);
  });

  it("rejects bytes that aren't a PDF in plain English", async () => {
    const path = join(dir, "fake.pdf");
    await writeFile(path, "this is not a pdf");
    await expect(pdfReader.load(path)).rejects.toThrow("This file isn't a readable PDF.");
  });

  it("rejects a truncated PDF in plain English", async () => {
    const path = join(dir, "broken.pdf");
    await writeFile(path, "%PDF-1.7\n1 0 obj\n<< /Type /Catalog");
    await expect(pdfReader.load(path)).rejects.toThrow("This file isn't a readable PDF.");
  });
});

describe("page kind", () => {
  it("calls a page of many drawn paths and no text an image", async () => {
    const path = await pdfFile("vector.pdf", (page) => {
      for (let i = 0; i < 600; i++) page.drawRectangle({ x: 20 + (i % 40) * 14, y: 100 + Math.floor(i / 40) * 14, width: 5, height: 5 });
    });
    expect((await pdfReader.load(path)).pages[0]!.kind).toBe("image");
  });

  it("calls a blank page an image", async () => {
    expect((await pdfReader.load(await pdfFile("blank.pdf", () => {}))).pages[0]!.kind).toBe("image");
  });

  it("calls a page with a few words over a full-page picture an image", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const canvas = createCanvas(60, 80);
    canvas.getContext("2d").fillRect(0, 0, 60, 80);
    const png = await pdf.embedPng(await canvas.encode("png"));
    page.drawImage(png, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    page.drawText("Scanned copy page 3 of 9 initial here please", { x: 50, y: 30, size: 10, font });
    const path = join(dir, "scan.pdf");
    await writeFile(path, await pdf.save());
    expect((await pdfReader.load(path)).pages[0]!.kind).toBe("image");
  });
});

describe("bank masking", () => {
  let doc: LoadedDoc;
  beforeAll(async () => {
    doc = await pdfReader.load(await bankPage());
  });

  it("masks digits digit-for-digit in layout, raw and words", () => {
    const page = doc.pages[0]!;
    for (const text of [page.layout, page.raw, page.words.map((w) => w.text).join(" ")].map((t) => t.replace(/ +/g, " "))) {
      expect(text).toContain("Account Number: #########");
      expect(text).toContain("ABA Routing #########");
      expect(text).not.toMatch(/123456789|000111222/);
    }
    expect(page.maskBoxes.length).toBeGreaterThan(0);
  });

  it("masks a number on the line below its label, IBANs, SWIFT codes and comma-grouped digits", () => {
    const raw = doc.pages[0]!.raw;
    expect(raw).not.toMatch(/900123456|GB29|NWBK|6016|TESTUS33|246,813,579/);
    expect(raw).toContain("IBAN: #### #### #### #### #### ##");
    expect(raw).toContain("SWIFT: ########");
    expect(raw).not.toMatch(/900765432|000333444|900555666/);
  });

  it("leaves amounts and short numbers near a bank word alone", () => {
    expect(doc.pages[0]!.raw).toContain("Startup fee $1,234.56");
    expect(doc.pages[0]!.raw).toContain("Bank fee $25.00 per wire, account review in 12 months");
  });
});

describe("footnote markers", () => {
  const marked = async (name: string, lines: [string, string, number?][]) => {
    const path = await pdfFile(name, (page, font) => {
      lines.forEach(([text, note, dy = 4], i) => {
        const y = 700 - i * 30;
        const gap = font.widthOfTextAtSize(text, 10) + 1;
        page.drawText(text, { x: 50, y, size: 10, font });
        page.drawText(note, { x: 50 + gap, y: y + dy, size: 6, font });
      });
    });
    return (await pdfReader.load(path)).pages[0]!;
  };

  it("keeps a raised marker after a number from lengthening the number", async () => {
    const page = await marked("fee.pdf", [["Startup fee $500", "1"]]);
    for (const text of [page.layout, page.raw, page.words.map((w) => w.text).join(" ")]) {
      expect(text.replace(/ +/g, " ").trim()).toBe("Startup fee $500 [1]");
      expect(text).not.toContain("5001");
    }
    expect(amountsIn(page.layout)).toEqual([50000]);
    expect(page.words.map((w) => w.text)).toEqual(["Startup", "fee", "$500", "[1]"]);
  });

  it("keeps a marker after a bare number and after a word", async () => {
    const page = await marked("terms.pdf", [["Payment within 30", "1"], ["Fee", "a"]]);
    expect(page.raw.split("\n")).toEqual(["Payment within 30 [1]", "Fee [a]"]);
  });

  it("keeps a lowered marker apart too", async () => {
    const page = await marked("sub.pdf", [["Total $75", "2", -2]]);
    expect(page.raw).toBe("Total $75 [2]");
    expect(amountsIn(page.layout)).toEqual([7500]);
  });

  it("keeps a marker apart from the word that follows it", async () => {
    const path = await pdfFile("mid.pdf", (page, font) => {
      page.drawText("within 30", { x: 50, y: 700, size: 10, font });
      page.drawText("1", { x: 50 + font.widthOfTextAtSize("within 30", 10), y: 704, size: 6, font });
      page.drawText("days", { x: 50 + font.widthOfTextAtSize("within 30", 10) + 4, y: 700, size: 10, font });
    });
    expect((await pdfReader.load(path)).pages[0]!.raw).toBe("within 30 [1] days");
  });

  it("catches a marker raised so little that the word grouping alone would glue it on", async () => {
    const page = await marked("shallow.pdf", [["Startup fee $500", "1", 1.1]]);
    expect(page.raw).toBe("Startup fee $500 [1]");
    expect(amountsIn(page.layout)).toEqual([50000]);
  });

  it("does not mark a raised ordinal suffix", async () => {
    const page = await marked("ordinal.pdf", [["on the 15", "th"]]);
    expect(page.raw).not.toContain("[");
  });

  it("leaves text of different sizes on separate lines or one shared baseline unmarked", async () => {
    const path = await pdfFile("sizes.pdf", (page, font) => {
      page.drawText("ARTICLE 5", { x: 50, y: 700, size: 18, font });
      page.drawText("Fees", { x: 50 + font.widthOfTextAtSize("ARTICLE 5", 18) + 6, y: 700, size: 8, font });
      page.drawText("Amounts are in US dollars", { x: 50, y: 680, size: 7, font });
      page.drawText("Fee $500 per visit", { x: 50, y: 660, size: 11, font });
    });
    const raw = (await pdfReader.load(path)).pages[0]!.raw;
    expect(raw).toBe("ARTICLE 5 Fees\nAmounts are in US dollars\nFee $500 per visit");
  });

  it("masks a marker after a bank label along with the number: hiding too much is safe", async () => {
    const path = await pdfFile("acct.pdf", (page, font) => {
      page.drawText("Account Number", { x: 50, y: 700, size: 10, font });
      page.drawText("1", { x: 50 + font.widthOfTextAtSize("Account Number", 10), y: 704, size: 6, font });
      page.drawText("123456789", { x: 50 + font.widthOfTextAtSize("Account Number", 10) + 10, y: 700, size: 10, font });
    });
    const page = (await pdfReader.load(path)).pages[0]!;
    expect(page.raw).toBe("Account Number [#] #########");
  });

  it("masks an account number printed as small raised groups, which read as footnote marks", async () => {
    const path = await pdfFile("groups.pdf", (page, font) => {
      page.drawText("Account Number:", { x: 50, y: 700, size: 10, font });
      let x = 50 + font.widthOfTextAtSize("Account Number:", 10);
      for (const group of ["900", "765", "432"]) {
        page.drawText(group, { x, y: 704, size: 6, font });
        x += font.widthOfTextAtSize(group, 6);
      }
    });
    const page = (await pdfReader.load(path)).pages[0]!;
    expect(page.raw).not.toMatch(/9|7|4/);
  });
});

describe("render", () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let doc: LoadedDoc;
  beforeAll(async () => {
    doc = await pdfReader.load(await bankPage());
  });

  const size = async (png: Buffer) => {
    const img = await loadImage(png);
    return { w: img.width, h: img.height };
  };

  it("returns a PNG about page size times dpi/72", async () => {
    const png = await pdfReader.render(doc, 1, { dpi: 100 });
    expect(png.subarray(0, 8).equals(pngSignature)).toBe(true);
    const { w, h } = await size(png);
    expect(Math.abs(w - (PAGE_W * 100) / 72)).toBeLessThanOrEqual(1);
    expect(Math.abs(h - (PAGE_H * 100) / 72)).toBeLessThanOrEqual(1);
  });

  it("crops to a region proportionally", async () => {
    const full = await size(await pdfReader.render(doc, 1, { dpi: 100 }));
    const half = await size(await pdfReader.render(doc, 1, { dpi: 100, region: [0, 0, 0.5, 0.25] }));
    expect(Math.abs(half.w - full.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(half.h - full.h / 4)).toBeLessThanOrEqual(1);
  });

  it("caps high dpi by the megapixel limit", async () => {
    const { w, h } = await size(await pdfReader.render(doc, 1, { dpi: 1000 }));
    expect(w * h).toBeLessThanOrEqual(2.5e6);
    expect(w * h).toBeGreaterThan(2.3e6);
    expect(w / h).toBeCloseTo(PAGE_W / PAGE_H, 2);
  });

  it("paints mask boxes black and leaves other text visible", async () => {
    const img = await loadImage(await pdfReader.render(doc, 1, { dpi: 100 }));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [x0, y0, x1, y1] = doc.pages[0]!.maskBoxes[0]!;
    const inside = ctx.getImageData(Math.round(((x0 + x1) / 2) * img.width), Math.round(((y0 + y1) / 2) * img.height), 1, 1).data;
    expect([...inside]).toEqual([0, 0, 0, 255]);

    const unmasked = ctx.getImageData(0, Math.round(0.16 * img.height), img.width, Math.round(0.03 * img.height)).data;
    expect(unmasked.some((v, i) => i % 4 === 0 && v < 128)).toBe(true);
  });

  it("rejects regions outside the page or inverted", async () => {
    await expect(pdfReader.render(doc, 1, { region: [0, 0, 1.2, 1] })).rejects.toThrow(/region/);
    await expect(pdfReader.render(doc, 1, { region: [0.6, 0, 0.4, 1] })).rejects.toThrow(/region/);
  });

  it("rejects a page that doesn't exist", async () => {
    await expect(pdfReader.render(doc, 2)).rejects.toThrow("no page 2");
  });
});
