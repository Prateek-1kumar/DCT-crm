import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import type { LoadedDoc, OcrPage, Word } from "../types";
import { withPdf } from "./open";
import { buildPage } from "./page";

const DPI = 300;
const ROTATIONS = [90, 180, 270];
// A page read upright scores well above this; below it the page may be upside down.
const SURE_CONFIDENCE = 75;
const MODEL = "4.0.0_best_int";

const require = createRequire(import.meta.url);
const versionOf = (pkg: string) => (require(`${pkg}/package.json`) as { version: string }).version;
const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), MODEL);

export const OCR_VERSION = `tesseract.js@${versionOf("tesseract.js")} eng@${versionOf("@tesseract.js-data/eng")}/${MODEL} ${DPI}dpi auto-layout upright`;

function rotated(canvas: Canvas, clockwise: number): Canvas {
  const sideways = clockwise % 180 !== 0;
  const out = createCanvas(sideways ? canvas.height : canvas.width, sideways ? canvas.width : canvas.height);
  const ctx = out.getContext("2d");
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((clockwise * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// Right-way-up text yields many confident characters; sideways text yields few, or junk the engine doubts.
const score = (words: Word[]) => words.reduce((n, w) => n + (w.confidence ?? 0) * w.text.length, 0);

async function recognise(worker: Worker, canvas: Canvas): Promise<Word[]> {
  const { data } = await worker.recognize(await canvas.encode("png"), {}, { blocks: true });
  return (data.blocks ?? [])
    .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
    .filter((w) => w.text.trim())
    .map((w) => ({
      text: w.text.trim(),
      x0: w.bbox.x0 / canvas.width,
      y0: w.bbox.y0 / canvas.height,
      x1: w.bbox.x1 / canvas.width,
      y1: w.bbox.y1 / canvas.height,
      confidence: w.confidence,
    }));
}

// Read upright, a word of a few letters is wider than tall; on a sideways page tesseract reads the lines going down the page.
const MIN_WORD_CHARS = 3;
function sideways(words: Word[], canvas: Canvas) {
  const long = words.filter((w) => w.text.length >= MIN_WORD_CHARS);
  const tall = long.filter((w) => (w.y1 - w.y0) * canvas.height > (w.x1 - w.x0) * canvas.width);
  return tall.length * 2 > long.length;
}

async function readUpright(worker: Worker, canvas: Canvas): Promise<{ words: Word[]; rotation: number }> {
  const first = { words: await recognise(worker, canvas), rotation: 0, canvas };
  if (!first.words.length || (mean(first.words.map((w) => w.confidence ?? 0)) >= SURE_CONFIDENCE && !sideways(first.words, canvas))) return first;
  const reads = [first];
  for (const rotation of ROTATIONS) {
    const turned = rotated(canvas, rotation);
    reads.push({ words: await recognise(worker, turned), rotation, canvas: turned });
  }
  // a read whose lines run down the page is the page sideways, however confidently tesseract read it
  const upright = reads.filter((r) => !sideways(r.words, r.canvas));
  const best = (upright.length ? upright : reads).reduce((a, b) => (score(b.words) > score(a.words) ? b : a));
  return { words: best.words, rotation: best.rotation };
}

export async function ocrPages(doc: LoadedDoc, opts: { onPage?: (done: number, total: number) => void } = {}): Promise<OcrPage[]> {
  const todo = doc.pages.filter((p) => p.kind === "image");
  if (!todo.length) return [];
  const worker = await createWorker("eng", OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: "none" });
  try {
    // tesseract.js reads a page as one block of text by default, which on some budget tables finds only a header line
    await worker.setParameters({ user_defined_dpi: String(DPI), tessedit_pageseg_mode: PSM.AUTO });
    return await withPdf(doc.path, async (pdf) => {
      const out: OcrPage[] = [];
      for (const info of todo) {
        const page = await pdf.getPage(info.page);
        try {
          // This image never leaves the process, so it needs no size cap; the cap on `render` protects what is sent to a model.
          const viewport = page.getViewport({ scale: DPI / 72 });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
          const { words, rotation } = await readUpright(worker, canvas);
          out.push({
            page: info.page,
            words,
            confidence: mean(words.map((w) => w.confidence ?? 0)),
            rotation,
          });
        } finally {
          page.cleanup();
        }
        opts.onPage?.(out.length, todo.length);
      }
      return out;
    });
  } finally {
    await worker.terminate();
  }
}

export function withOcr(doc: LoadedDoc, ocr: OcrPage[]): LoadedDoc {
  const found = new Map(ocr.map((o) => [o.page, o]));
  return { ...doc, pages: doc.pages.map((p) => { const o = found.get(p.page); return o ? buildPage(p.page, o.words, "ocr", o.confidence, o.rotation) : p; }) };
}
