import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import type { Region } from "@dct/shared";

/**
 * Tesseract is a LOCATOR here, never a reader (§5.1): its words only say where the vision model's transcribed text sits on
 * the page. Nothing it reads may change a value, a check or what a model is sent.
 */

/** A word OCR found, positioned as fractions 0-1 of the page in the turned (readable) frame, origin top-left. */
export interface OcrWord {
  text: string;
  box: Region;
  /** The OCR line it was found in, so words of one printed line stay together. */
  line: number;
}

/** What detection kept for one scanned page: saved per file, so a page is detected once. */
export interface LocatePage {
  page: number;
  /** Names the engine and settings, so a change of either detects the page again. */
  version: string;
  /** Degrees clockwise the page was turned for the picture; the words are in that turned frame. */
  rotation: number;
  words: OcrWord[];
}

export interface LocateStore {
  get(sha256: string): Promise<LocatePage[]>;
  put(sha256: string, page: LocatePage): Promise<void>;
}

export const LOCATE_DPI = 200;
// Chosen from the trial on saved scans (design doc §5.1): automatic page layout, 200 dpi.
export const locateVersion = "locate-1 tesseract.js-7 eng-4.0.0 dpi200 psm3";
/** A picture is bigger than any page a letter-sized scan gives; beyond this the page is not located and stays approximate. */
export const LOCATE_MAX_PIXELS = 12e6;

const IDLE_MS = 5000;

let worker: Promise<Worker> | undefined;
let idle: NodeJS.Timeout | undefined;
// one picture at a time: a worker runs one job, and a second page waiting is cheaper than a second worker's memory
let queue: Promise<unknown> = Promise.resolve();

/** The language data ships in the install, so nothing is ever fetched at run time. */
function dataPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0");
}

function start(): Promise<Worker> {
  worker ??= (async () => {
    const created = await createWorker("eng", 1, { langPath: dataPath(), gzip: true, cacheMethod: "none" });
    // automatic page layout; the dpi is told, since a picture from canvas carries none
    await created.setParameters({ tessedit_pageseg_mode: "3" as never, user_defined_dpi: String(LOCATE_DPI) });
    return created;
  })().catch((err: unknown) => {
    worker = undefined;
    throw err;
  });
  return worker;
}

/** Ends the worker so the process can exit; the next page starts a new one. */
export async function stopDetector(): Promise<void> {
  clearTimeout(idle);
  const ending = worker;
  worker = undefined;
  await (await ending?.catch(() => undefined))?.terminate();
}

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** Where each word of a page picture sits, in reading order of OCR's own lines. Throws if OCR can't run; callers fall back to approximate marks. */
export function detectWords(png: Buffer): Promise<OcrWord[]> {
  const run = queue.then(async () => {
    clearTimeout(idle);
    try {
      const { width, height } = pngSize(png);
      const ocr = await start();
      const { data } = await ocr.recognize(png, {}, { blocks: true });
      const words: OcrWord[] = [];
      let line = 0;
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const l of paragraph.lines) {
            line++;
            for (const w of l.words) {
              const text = w.text.trim();
              if (!text) continue;
              const { x0, y0, x1, y1 } = w.bbox;
              words.push({ text, line, box: [x0 / width, y0 / height, x1 / width, y1 / height] });
            }
          }
        }
      }
      return words;
    } finally {
      idle = setTimeout(() => void stopDetector(), IDLE_MS);
      idle.unref();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
