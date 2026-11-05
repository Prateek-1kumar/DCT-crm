import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { amountsIn } from "../src/checks/text";
import { OCR_VERSION, ocrPages, pdfReader, withOcr } from "../src/pdf";
import { groupLines, maskBankDetails } from "../src/pdf/lines";
import { withPdf } from "../src/pdf/open";
import type { LoadedDoc, Word } from "../src/types";
import { wordsOf } from "./words";

const PAGE_W = 612;
const PAGE_H = 792;
const SCAN_DPI = 300;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-ocr-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function textPdf(name: string, draw: (page: PDFPage, font: PDFFont) => void): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  draw(pdf.addPage([PAGE_W, PAGE_H]), font);
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return path;
}

async function scanOf(textPath: string, name: string, clockwise = 0): Promise<string> {
  const upright = await withPdf(textPath, async (pdf) => {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: SCAN_DPI / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    return canvas;
  });
  const sideways = clockwise % 180 !== 0;
  const scan = createCanvas(sideways ? upright.height : upright.width, sideways ? upright.width : upright.height);
  const ctx = scan.getContext("2d");
  ctx.translate(scan.width / 2, scan.height / 2);
  ctx.rotate((clockwise * Math.PI) / 180);
  ctx.drawImage(await loadImage(await upright.encode("png")), -upright.width / 2, -upright.height / 2);

  const pdf = await PDFDocument.create();
  const [w, h] = sideways ? [PAGE_H, PAGE_W] : [PAGE_W, PAGE_H];
  pdf.addPage([w, h]).drawImage(await pdf.embedPng(await scan.encode("png")), { x: 0, y: 0, width: w, height: h });
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return path;
}

async function ocrOf(path: string): Promise<{ scan: LoadedDoc; doc: LoadedDoc }> {
  const scan = await pdfReader.load(path);
  return { scan, doc: withOcr(scan, await ocrPages(scan)) };
}

const budget = [
  ["Screening visit", "$1,500.00", "$950.00", "$75.00"],
  ["Baseline visit", "$12,345.67", "$1,100.00", "$80.00"],
  ["Week 4 follow-up", "$310.00", "$99.99", "$5.00"],
];
const columns = [50, 250, 350, 450];

function drawContract(page: PDFPage, font: PDFFont) {
  page.drawText("Exhibit A Budget", { x: 50, y: 740, size: 14, font });
  budget.forEach((row, i) => row.forEach((cell, c) => page.drawText(cell, { x: columns[c]!, y: 700 - i * 22, size: 11, font })));
  page.drawText("Startup fee $1,234.56 payable on signature", { x: 50, y: 610, size: 11, font });
  const bank = [
    "Account Number: 900765432",
    "ABA/Routing: 000333444",
    "SWIFT: TESTUS33",
    "IBAN: GB29 NWBK 6016 1331 9268 19",
    "Acct#246813579",
    "Bank Account Number",
    "900123456",
  ];
  bank.forEach((line, i) => page.drawText(line, { x: 50, y: 560 - i * 24, size: 11, font }));
}

const secrets = /900765432|000333444|TESTUS33|NWBK|GB29|6016|1331|9268|246813579|900123456/;
const expectedAmounts = [150000, 95000, 7500, 1234567, 110000, 8000, 31000, 9999, 500, 123456].sort((a, b) => a - b);

describe("ocr of a scanned page", { timeout: 120_000 }, () => {
  let scan: LoadedDoc;
  let doc: LoadedDoc;
  beforeAll(async () => {
    ({ scan, doc } = await ocrOf(await scanOf(await textPdf("contract.pdf", drawContract), "contract-scan.pdf")));
  });

  it("starts as an image page and becomes an OCR page with a confidence", () => {
    expect(scan.pages[0]!.kind).toBe("image");
    expect(scan.pages[0]!.words).toHaveLength(0);
    const page = doc.pages[0]!;
    expect(page.kind).toBe("ocr");
    expect(page.confidence).toBeGreaterThan(85);
    expect(page.firstLine).toBe("Exhibit A Budget");
    expect(page.words.every((w) => w.confidence !== undefined)).toBe(true);
  });

  it("finds words where they are, as fractions of the page", () => {
    const title = doc.pages[0]!.words.find((w) => w.text === "Exhibit")!;
    expect(title.x0).toBeCloseTo(50 / PAGE_W, 1);
    expect(title.y0).toBeCloseTo((PAGE_H - 740 - 14) / PAGE_H, 1);
    for (const w of doc.pages[0]!.words) {
      expect(w.x0).toBeGreaterThanOrEqual(0);
      expect(w.x1).toBeLessThanOrEqual(1);
      expect(w.y1).toBeLessThanOrEqual(1);
    }
  });

  it("reads every dollar amount exactly", () => {
    expect(amountsIn(doc.pages[0]!.layout).sort((a, b) => a - b)).toEqual(expectedAmounts);
  });

  it("keeps the table columns aligned in the layout", () => {
    const rows = doc.pages[0]!.layout.split("\n").filter((l) => /visit|follow-up/.test(l));
    expect(rows).toHaveLength(3);
    for (const col of [1, 2, 3]) {
      const offsets = rows.map((row, i) => row.indexOf(budget[i]![col]!));
      expect(offsets.every((o) => o > 0)).toBe(true);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(2);
    }
  });

  it("masks bank details in every layout and leaves amounts alone", () => {
    const page = doc.pages[0]!;
    for (const text of [page.layout, page.raw, page.words.map((w) => w.text).join(" ")]) {
      expect(text).not.toMatch(secrets);
      expect(text).toContain("$1,234.56");
    }
    expect(page.raw).toMatch(/Account Number: #########/);
    expect(page.raw).toMatch(/SWIFT: ########/);
    expect(page.maskBoxes.length).toBeGreaterThanOrEqual(8);
  });

  it("paints the mask boxes over the numbers when rendered", async () => {
    const img = await loadImage(await pdfReader.render(doc, 1, { dpi: 100 }));
    const ctx = createCanvas(img.width, img.height).getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [x0, y0, x1, y1] = doc.pages[0]!.maskBoxes[0]!;
    const pixel = ctx.getImageData(Math.round(((x0 + x1) / 2) * img.width), Math.round(((y0 + y1) / 2) * img.height), 1, 1).data;
    expect([...pixel]).toEqual([0, 0, 0, 255]);
  });

  it("is keyed by a version naming the engine and its data", () => {
    expect(OCR_VERSION).toMatch(/^tesseract\.js@\d+\.\d+\.\d+ eng@\d+\.\d+\.\d+\//);
  });
});

describe("ocr of a sideways or upside-down scan", { timeout: 240_000 }, () => {
  let upright: LoadedDoc;
  beforeAll(async () => {
    upright = (await ocrOf(await scanOf(await textPdf("turn.pdf", drawContract), "turn-0.pdf"))).doc;
  });

  it.each([90, 180, 270])("reads a page turned %i degrees clockwise and keeps it the right way up", async (clockwise) => {
    const path = await scanOf(await textPdf(`turn-${clockwise}-text.pdf`, drawContract), `turn-${clockwise}.pdf`, clockwise);
    const scan = await pdfReader.load(path);
    const ocr = await ocrPages(scan);
    expect(ocr[0]!.rotation).toBe((360 - clockwise) % 360);
    const doc = withOcr(scan, ocr);
    const page = doc.pages[0]!;
    expect(page.firstLine).toBe("Exhibit A Budget");
    expect(amountsIn(page.layout).sort((a, b) => a - b)).toEqual(expectedAmounts);
    expect(page.raw).not.toMatch(secrets);
    for (const [x0, y0, x1, y1] of upright.pages[0]!.maskBoxes) {
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      expect(page.maskBoxes.some(([a, b, c, d]) => a <= cx && cx <= c && b <= cy && cy <= d)).toBe(true);
    }
    const png = await pdfReader.render(doc, 1, { dpi: 72 });
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    expect(width).toBeLessThan(height);
  });
});

describe("text pages", () => {
  it("are not OCR'd and come back untouched", async () => {
    const doc = await pdfReader.load(await textPdf("text.pdf", (page, font) => page.drawText("Sponsor pays Institution within thirty days. ".repeat(6), { x: 20, y: 700, size: 6, font })));
    expect(doc.pages[0]!.kind).toBe("text");
    const seen: number[] = [];
    expect(await ocrPages(doc, { onPage: (done) => seen.push(done) })).toEqual([]);
    expect(withOcr(doc, [])).toEqual(doc);
    expect(seen).toEqual([]);
  });

  it("report progress per scanned page", { timeout: 120_000 }, async () => {
    const seen: [number, number][] = [];
    const path = await scanOf(await textPdf("progress.pdf", (page, font) => page.drawText("Exhibit A Budget", { x: 50, y: 700, size: 14, font })), "progress-scan.pdf");
    await ocrPages(await pdfReader.load(path), { onPage: (done, total) => seen.push([done, total]) });
    expect(seen).toEqual([[1, 1]]);
  });
});

describe("OCR-tolerant bank masking", () => {
  const masked = (text: string, ocr = true) => {
    const words: Word[] = wordsOf(text);
    maskBankDetails(groupLines(words), ocr);
    return groupLines(words).map((l) => l.map((w) => w.text).join(" "));
  };

  it.each([
    ["Account Number: 9OO765432", "Account Number: #########"],
    ["Account Number: 9OO 765 432", "Account Number: ### ### ###"],
    ["Acct#9OO765432", "##############"],
    ["Acc0unt Number: 900765432", "Acc0unt Number: #########"],
    ["R0uting 000333444", "R0uting #########"],
    ["ABA/Routing: OOO333444", "ABA/Routing: #########"],
    ["A8A: OOO333444", "A8A: #########"],
    ["Acct 1OO765", "Acct ######"],
    ["Acct 5O1D8Z", "Acct ######"],
    ["Rout1ng No. 0O0333444", "Rout1ng No. #########"],
    ["SWlFT: TESTUS33", "SWlFT: ########"],
    ["SWIFT: TESTUSS33", "SWIFT: #########"],
    ["BIC TESTU33", "BIC #######"],
    ["Bank Account Number\n9OO123456", "Bank Account Number\n#########"],
  ])("masks %j", (text, expected) => {
    expect(masked(text).join("\n")).toBe(expected);
  });

  it("treats digit-like letters as digits only on an OCR page", () => {
    expect(masked("Acct OO765", false)).toEqual(["Acct OO765"]);
    expect(masked("Acct OO765", true)).toEqual(["Acct #####"]);
  });

  it("does not take a misread amount for an account number", () => {
    expect(maskBankDetails(groupLines(wordsOf("Acct 12345 S25.00")), true)).toHaveLength(1);
  });

  it("hides what could be a garbled number near a label when no number can be read, and nothing else", () => {
    expect(maskBankDetails(groupLines(wordsOf("Account Number: ~#?@ x")), true)).toHaveLength(1);
    expect(masked("Account Number: ~#?@ x\nlOOSSIlO here 12\nuntouched 345678")).toEqual([
      "Account Number: ~#?@ x",
      "######## here ##",
      "untouched 345678",
    ]);
  });

  it("leaves contract prose and amounts readable around labels", () => {
    expect(masked("taking into account the fee of $25.00 and\nthe Bank fee S25.00 per wire")).toEqual([
      "taking into account the fee of $25.00 and",
      "the Bank fee S25.00 per wire",
    ]);
  });

  it("matches labels up to one character off, not unrelated words", () => {
    expect(masked("The shifts are 12345 each")).toEqual(["The shifts are 12345 each"]);
    expect(masked("Rooting 000333444")).toEqual(["Rooting #########"]);
  });
});
