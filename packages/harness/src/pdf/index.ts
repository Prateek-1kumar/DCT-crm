import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { Region } from "@dct/shared";
import type { LoadedDoc, Page, PdfReader } from "../types";
import { classify } from "./kind";
import { groupLines, layoutText, maskBankDetails, rawLine } from "./lines";
import { extractWords } from "./text";

const DEFAULT_DPI = 150;
const MAX_DPI = 300;
// Keeps a page image well inside what a model accepts and what is affordable to send.
const MAX_PIXELS = 2.5e6;
const FIRST_LINE_MAX = 90;
const UNREADABLE = "This file isn't a readable PDF.";

const assets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const assetUrls = {
  standardFontDataUrl: join(assets, "standard_fonts/"),
  cMapUrl: join(assets, "cmaps/"),
  iccUrl: join(assets, "iccs/"),
  wasmUrl: join(assets, "wasm/"),
};

async function withPdf<T>(path: string, use: (pdf: PDFDocumentProxy, bytes: Buffer) => Promise<T>): Promise<T> {
  const bytes = await readFile(path).catch(() => {
    throw new Error("This file couldn't be opened. Check that it still exists and try again.");
  });
  if (!bytes.subarray(0, 1024).includes("%PDF-")) throw new Error(UNREADABLE);
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, ...assetUrls });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new Error(err instanceof Error && err.name === "PasswordException" ? "This PDF is password-protected, so it can't be read." : UNREADABLE);
  }
  try {
    return await use(pdf, bytes);
  } finally {
    await task.destroy();
  }
}

async function readPage(pdf: PDFDocumentProxy, number: number): Promise<Page> {
  const page = await pdf.getPage(number);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = extractWords(content, viewport.transform, viewport.width, viewport.height);
    const lines = groupLines(words);
    const maskBoxes = maskBankDetails(lines);
    const raw = lines.map(rawLine).join("\n");
    const textChars = words.reduce((n, w) => n + w.text.length, 0);
    return {
      page: number,
      kind: classify(textChars),
      layout: layoutText(lines),
      raw,
      words,
      maskBoxes,
      firstLine: (raw.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, FIRST_LINE_MAX),
    };
  } finally {
    page.cleanup();
  }
}

function checkRegion(region: Region) {
  const [x0, y0, x1, y1] = region;
  if (![x0, y0, x1, y1].every((v) => v >= 0 && v <= 1) || x1 <= x0 || y1 <= y0) {
    throw new Error("That page region isn't valid: it must stay inside the page and run from top-left to bottom-right.");
  }
}

export const pdfReader: PdfReader = {
  load: (path) =>
    withPdf(path, async (pdf, bytes) => {
      const pages: Page[] = [];
      for (let n = 1; n <= pdf.numPages; n++) pages.push(await readPage(pdf, n));
      return { name: basename(path), path, sha256: createHash("sha256").update(bytes).digest("hex"), pages } satisfies LoadedDoc;
    }),

  async render(doc, pageNumber, opts = {}) {
    const info = doc.pages[pageNumber - 1];
    if (!info) throw new Error(`This document has no page ${pageNumber}.`);
    const region: Region = opts.region ?? [0, 0, 1, 1];
    checkRegion(region);
    const [rx0, ry0, rx1, ry1] = region;

    return withPdf(doc.path, async (pdf) => {
      const page = await pdf.getPage(pageNumber);
      try {
        const { width, height } = page.getViewport({ scale: 1 });
        const regionPoints = (rx1 - rx0) * width * ((ry1 - ry0) * height);
        const scale = Math.min(Math.min(opts.dpi ?? DEFAULT_DPI, MAX_DPI) / 72, Math.sqrt(MAX_PIXELS / regionPoints));
        const left = rx0 * width * scale;
        const top = ry0 * height * scale;
        const canvas = createCanvas(Math.max(1, Math.floor((rx1 - rx0) * width * scale)), Math.max(1, Math.floor((ry1 - ry0) * height * scale)));
        const viewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        for (const [x0, y0, x1, y1] of info.maskBoxes) {
          ctx.fillRect(x0 * width * scale - left, y0 * height * scale - top, (x1 - x0) * width * scale, (y1 - y0) * height * scale);
        }
        return await canvas.encode("png");
      } finally {
        page.cleanup();
      }
    });
  },
};
