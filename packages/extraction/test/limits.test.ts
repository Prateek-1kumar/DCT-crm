import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, ExtractionLimitError, extractWith, identifyWith } from "../src/extract";
import { renderPage } from "../src/index";
import type { LlmClient } from "../src/llm";
import { openDocuments, pageCount, RENDER_LIMITS, RenderTimeoutError, renderPng, renderTiles, tileLayout, WORKER_FILE } from "../src/render";
import { bankRects, inventory, readTextLayer } from "../src/textlayer";

function pdfWith(pages: number, size: [number, number] = [612, 792]): string {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, size[0], size[1]], 0, {}, "0 0 0 rg 10 10 50 50 re f"));
  const path = join(mkdtempSync(join(tmpdir(), "dct-limits-")), "x.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

/** PNG width/height from the IHDR chunk. */
const dims = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

const saved = { ...RENDER_LIMITS, maxPagesPerDoc: CONFIG.maxPagesPerDoc, maxPagesTotal: CONFIG.maxPagesTotal, maxTilesPerExtraction: CONFIG.maxTilesPerExtraction, maxImagesPerExtraction: CONFIG.maxImagesPerExtraction };
afterEach(() => {
  Object.assign(RENDER_LIMITS, { maxDpi: saved.maxDpi, maxPixels: saved.maxPixels, maxTilesPerPage: saved.maxTilesPerPage, timeoutMs: saved.timeoutMs });
  CONFIG.maxPagesPerDoc = saved.maxPagesPerDoc;
  CONFIG.maxTilesPerExtraction = saved.maxTilesPerExtraction;
  CONFIG.maxPagesTotal = saved.maxPagesTotal;
  CONFIG.maxImagesPerExtraction = saved.maxImagesPerExtraction;
});

describe("render limits", () => {
  const pdf = pdfWith(2);

  it("rejects page numbers outside 1..pageCount and non-integers", async () => {
    for (const p of [0, -1, 3, 1.5, Number.NaN]) await expect(renderPage(pdf, p)).rejects.toThrow(RangeError);
    await expect(renderPage(pdf, 1, 0)).rejects.toThrow(/not a valid DPI/);
  });

  it("clamps DPI to maxDpi", async () => {
    const [w] = dims(await renderPage(pdf, 1, 5000));
    expect(w).toBe(Math.round((612 / 72) * RENDER_LIMITS.maxDpi));
  });

  it("downscales a full page to the pixel budget, rejects an oversize clip", async () => {
    RENDER_LIMITS.maxPixels = 1_000_000;
    const [w, h] = dims(await renderPage(pdf, 1, 600));
    expect(w! * h!).toBeLessThanOrEqual(1_000_000);
    expect(w! * h!).toBeGreaterThan(900_000);
    await expect(renderPng(pdf, 1, { dpi: 600, clip: [0, 0, 2000, 2000] })).rejects.toThrow(/over the 1000000-pixel limit/);
  });

  it("a huge page cannot exceed the pixel budget", async () => {
    const huge = pdfWith(1, [14400, 14400]); // 200 × 200 inches
    const [w, h] = dims(await renderPage(huge, 1, 150));
    expect(w! * h!).toBeLessThanOrEqual(RENDER_LIMITS.maxPixels);
  });

  it("caps tiles per page by lowering the DPI", async () => {
    RENDER_LIMITS.maxTilesPerPage = 4;
    const tiles = await renderTiles(pdf, 1, { dpi: 600, maxPx: 1000 });
    expect(tiles.length).toBeLessThanOrEqual(4);
  });
});

describe("extraction limits", () => {
  const llm: LlmClient = {
    provider: "anthropic",
    model: "mock",
    cost: () => ({ provider: "anthropic", model: "mock", inputTokens: 0, outputTokens: 0, usd: 0 }),
    async call<T>(req: { name: string; schema: { parse(x: unknown): T } }) {
      if (req.name === "classify") return req.schema.parse({ pages: [1, 2, 3].map((page) => ({ page, kind: "budget_grid", readable: true, rotation: 0, gridGroup: null })) });
      throw new Error(`AI should not be called after a cap trips (${req.name})`);
    },
  };

  it("fails before rendering when a document has too many pages", async () => {
    CONFIG.maxPagesPerDoc = 2;
    const calls: string[] = [];
    const spy = { ...llm, call: async (r: { name: string }) => (calls.push(r.name), llm.call(r as never)) } as LlmClient;
    await expect(extractWith({ documents: [{ id: "d", filename: "big.pdf", path: pdfWith(3), kind: null }] }, { primary: spy, cross: null })).rejects.toThrow(ExtractionLimitError);
    expect(calls).toEqual([]);
  });

  it("fails before any grid AI call when tiles exceed the per-extraction cap", async () => {
    CONFIG.maxTilesPerExtraction = 5;
    await expect(extractWith({ documents: [{ id: "d", filename: "g.pdf", path: pdfWith(3), kind: null }] }, { primary: llm, cross: null })).rejects.toThrow(/more than 5 grid image tiles/);
  });

  it("enforces a total page cap across documents before any render or AI call", async () => {
    CONFIG.maxPagesTotal = 4;
    const calls: string[] = [];
    const spy = { ...llm, call: async (r: { name: string }) => (calls.push(r.name), llm.call(r as never)) } as LlmClient;
    const documents = [1, 2].map((i) => ({ id: `d${i}`, filename: `${i}.pdf`, path: pdfWith(3), kind: null }));
    await expect(extractWith({ documents }, { primary: spy, cross: null })).rejects.toThrow(/6 pages in total; the limit is 4/);
    await expect(identifyWith(documents, spy)).rejects.toThrow(ExtractionLimitError);
    expect(calls).toEqual([]);
  });

  it("counts classification, overview and tile images toward the image cap", async () => {
    CONFIG.maxImagesPerExtraction = 3; // 3 classify images fit; the grid images don't
    await expect(extractWith({ documents: [{ id: "d", filename: "g.pdf", path: pdfWith(3), kind: null }] }, { primary: llm, cross: null })).rejects.toThrow(/more than 3 page images/);
    CONFIG.maxImagesPerExtraction = 2; // classification alone is over
    await expect(extractWith({ documents: [{ id: "d", filename: "g.pdf", path: pdfWith(3), kind: null }] }, { primary: llm, cross: null })).rejects.toThrow(/more than 2 page images/);
  });
});

describe("tile budget", () => {
  const pdf = pdfWith(1);
  it("throws when a page cannot fit maxTilesPerPage at any DPI", async () => {
    RENDER_LIMITS.maxTilesPerPage = 0;
    await expect(tileLayout(pdf, 1, { dpi: 400, maxPx: 1000 })).rejects.toThrow(/limit is 0/);
  });
  it("renderTiles checks the caller's remaining budget against the layout before rendering", async () => {
    const layout = await tileLayout(pdf, 1, { dpi: 400, maxPx: 1000 });
    expect(layout.count).toBeGreaterThan(1);
    await expect(renderTiles(pdf, 1, { dpi: 400, maxPx: 1000, maxTiles: layout.count - 1 })).rejects.toThrow(/left for this read/);
    expect(await renderTiles(pdf, 1, { dpi: 400, maxPx: 1000, maxTiles: layout.count })).toHaveLength(layout.count);
  });
});

describe("the mupdf worker", () => {
  it("is the package's own script, found the way an app that bundles this package finds it", async () => {
    expect(WORKER_FILE).toBe(fileURLToPath(new URL("../src/mupdf-worker.mjs", import.meta.url)));
    // An app that inlines render.ts (the API's tsup build) resolves it from its own dist/, through node_modules.
    const app = mkdtempSync(join(tmpdir(), "dct-app-"));
    mkdirSync(join(app, "node_modules", "@dct"), { recursive: true });
    symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(app, "node_modules", "@dct", "extraction"), "dir");
    const fromApp = createRequire(join(app, "dist", "server.js")).resolve("@dct/extraction/mupdf-worker");
    expect(realpathSync(fromApp)).toBe(realpathSync(WORKER_FILE));
    expect(existsSync(join(app, "dist", "mupdf-worker.mjs"))).toBe(false); // nothing to copy next to the bundle
    expect(await pageCount(pdfWith(2))).toBe(2); // and it starts
  });

  it("a timeout replaces the worker: the next call gets a fresh one", async () => {
    await pageCount(pdfWith(1));
    expect(await openDocuments()).toBeGreaterThan(0);
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, "0 0 m 612 792 l S\n".repeat(400_000)));
    const slow = join(mkdtempSync(join(tmpdir(), "dct-limits-")), "slow.pdf");
    writeFileSync(slow, doc.saveToBuffer("").asUint8Array());
    RENDER_LIMITS.timeoutMs = 300;
    await expect(renderPng(slow, 1, { dpi: 400 })).rejects.toThrow(RenderTimeoutError);
    RENDER_LIMITS.timeoutMs = saved.timeoutMs;
    expect(await openDocuments()).toBe(0); // a new worker: nothing open yet
    expect(await pageCount(pdfWith(3))).toBe(3);
  });

  it("stops a page that takes too long to draw, without blocking the event loop; that page then fails at once", async () => {
    // a crafted content stream: hundreds of thousands of full-page strokes
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, "0 0 m 612 792 l S\n".repeat(400_000)));
    const slow = join(mkdtempSync(join(tmpdir(), "dct-limits-")), "slow.pdf");
    writeFileSync(slow, doc.saveToBuffer("").asUint8Array());
    RENDER_LIMITS.timeoutMs = 300;
    let ticks = 0;
    const tick = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    await expect(renderPng(slow, 1, { dpi: 400 })).rejects.toThrow(RenderTimeoutError);
    clearInterval(tick);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(10); // the main thread kept running while mupdf was busy
    const again = Date.now();
    await expect(renderPng(slow, 1, { dpi: 72 })).rejects.toThrow(/isn't tried again/);
    expect(Date.now() - again).toBeLessThan(100);
    // a fresh worker serves everything else
    RENDER_LIMITS.timeoutMs = saved.timeoutMs;
    expect((await renderPng(pdfWith(1), 1, { dpi: 72 })).subarray(1, 4).toString()).toBe("PNG");
  });

  it("keeps at most 8 PDFs open", async () => {
    for (let i = 0; i < 10; i++) expect(await pageCount(pdfWith(1))).toBe(1);
    expect(await openDocuments()).toBe(8);
  });
});

describe("bank details (ADR-001 §9)", () => {
  it("are painted over in the page image, on text pages", async () => {
    const doc = new mupdf.PDFDocument();
    const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
    const line = (y: number, t: string) => `BT /F1 10 Tf 40 ${792 - y} Td (${t}) Tj ET\n`;
    const text = [
      "Payee bank ABA routing 021000021, account 123456789.",
      "Sponsor shall pay each invoice within forty-five (45) days of receipt of invoice.",
      "This page continues the agreement between the parties and the site, as set out above in full detail.",
      "A second ordinary line of words keeps this page well above the threshold for a real text layer.",
    ];
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, text.map((t, i) => line(60 + 20 * i, t)).join("")));
    const file = join(mkdtempSync(join(tmpdir(), "dct-limits-")), "bank.pdf");
    writeFileSync(file, doc.saveToBuffer("").asUint8Array());
    const [page] = await readTextLayer(file, "d1");
    const rects = bankRects(page!);
    expect(page!.words.filter((w) => rects.includes(w.rect)).map((w) => w.text)).toEqual(["021000021,", "123456789."]);
    // the 45 in the payment sentence is no bank detail
    const pixels = async (mask?: [number, number, number, number][]) => {
      const pix = new mupdf.Image(await renderPng(file, 1, { dpi: 72, gray: true, mask })).toPixmap();
      const [x0, y0, x1, y1] = rects[1]!.map(Math.round) as [number, number, number, number];
      const px = pix.getPixels();
      const out: number[] = [];
      for (let y = y0 + 1; y < y1 - 1; y++) for (let x = x0 + 1; x < x1 - 1; x++) out.push(px[y * pix.getStride() + x]!);
      return out;
    };
    expect((await pixels()).some((v) => v > 200)).toBe(true); // black text on white
    expect((await pixels(rects)).every((v) => v < 10)).toBe(true); // all black
  });

  it("are found by their label in a table cell beside them or on the line above, not elsewhere on the page", async () => {
    const doc = new mupdf.PDFDocument();
    const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
    const at = (x: number, y: number, t: string) => `BT /F1 9 Tf ${x} ${792 - y} Td (${t}) Tj ET\n`;
    const filler = "This page continues the agreement between the parties and the site, as set out above in full detail.";
    const content = [
      at(40, 60, "Payment instructions"),
      at(40, 80, "Bank account number"),
      at(300, 80, "4417 1234 5678"),
      at(40, 96, "ABA routing number"),
      at(300, 96, "021000021"),
      at(40, 130, "Wire to account:"),
      at(40, 144, "987654321012"),
      at(300, 144, "Wire fee $25.00 per payment"),
      at(40, 300, "Protocol NCT01234567 is the study this agreement covers."),
      at(40, 320, "The study budget is $12,500.00 for each subject, paid within 30 days."),
      at(40, 700, filler),
      at(40, 720, filler),
    ].join("");
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));
    const file = join(mkdtempSync(join(tmpdir(), "dct-limits-")), "bank-table.pdf");
    writeFileSync(file, doc.saveToBuffer("").asUint8Array());
    const [page] = await readTextLayer(file, "d1");
    const rects = bankRects(page!);
    expect(page!.words.filter((w) => rects.includes(w.rect)).map((w) => w.text)).toEqual(["4417", "1234", "5678", "021000021", "987654321012"]);
    // Never stored either: not a span, nor in the text of the line around one.
    const spans = inventory([page!]);
    expect(spans.some((x) => x.words.some((w) => w.text === "$25.00"))).toBe(true);
    expect(JSON.stringify(spans.map((x) => [x.text, x.words.map((w) => w.text)]))).not.toMatch(/987654321012|021000021/);
  });
});
