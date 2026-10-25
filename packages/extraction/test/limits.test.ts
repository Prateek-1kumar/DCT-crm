import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, ExtractionLimitError, extractWith, identifyWith } from "../src/extract";
import { renderPage } from "../src/index";
import type { LlmClient } from "../src/llm";
import { RENDER_LIMITS, renderPng, renderTiles, tileLayout } from "../src/render";

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
  Object.assign(RENDER_LIMITS, { maxDpi: saved.maxDpi, maxPixels: saved.maxPixels, maxTilesPerPage: saved.maxTilesPerPage });
  CONFIG.maxPagesPerDoc = saved.maxPagesPerDoc;
  CONFIG.maxTilesPerExtraction = saved.maxTilesPerExtraction;
  CONFIG.maxPagesTotal = saved.maxPagesTotal;
  CONFIG.maxImagesPerExtraction = saved.maxImagesPerExtraction;
});

describe("render limits", () => {
  const pdf = pdfWith(2);

  it("rejects page numbers outside 1..pageCount and non-integers", async () => {
    for (const p of [0, -1, 3, 1.5, Number.NaN]) await expect(renderPage(pdf, p)).rejects.toThrow(RangeError);
    await expect(renderPage(pdf, 1, 0)).rejects.toThrow(/invalid dpi/);
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
    await expect(renderPng(pdf, 1, { dpi: 600, clip: [0, 0, 2000, 2000] })).rejects.toThrow(/exceeds/);
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
    await expect(renderTiles(pdf, 1, { dpi: 400, maxPx: 1000, maxTiles: layout.count - 1 })).rejects.toThrow(/left in the budget/);
    expect(await renderTiles(pdf, 1, { dpi: 400, maxPx: 1000, maxTiles: layout.count })).toHaveLength(layout.count);
  });
});
