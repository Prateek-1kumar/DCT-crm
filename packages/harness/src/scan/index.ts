import { estimateUsd, spentOn, type Budget, type Part, type Reader } from "../models";
import { pdfReader } from "../pdf";
import { buildPage } from "../pdf/page";
import { ReadFailed } from "../read";
import type { LoadedDoc, Located, Page, ScanPage, ScanStore } from "../types";
import { cellsOf, scanText } from "./cells";
import { LOCATE_DPI, LOCATE_MAX_PIXELS, detectWords, locateVersion, type LocatePage, type LocateStore, type OcrWord } from "./detect";
import { locate } from "./match";
import { MAX_SCAN_PIXELS, SCAN_DPI, pageParts, parseTranscription, transcribeAsk, type Transcription } from "./transcribe";
import { quarterTurn } from "./verify";
import { bandsOf, toWords } from "./words";

export { fileScanStore } from "./store";
export { locateVersion, stopDetector } from "./detect";
export type { LocatePage, LocateStore, OcrWord } from "./detect";

/** What the budget adds for each scanned page not yet transcribed: about $0.30 for a dense budget page, much less for prose. */
export const SCAN_PAGE_USD = 0.4;

// Measured on compact transcriptions: the densest page costs about $0.20 at $30 a million output tokens.
const OUTPUT_TOKENS = 4000;
const PARALLEL_PAGES = 4;

export const scanVersion = (reader: Reader) => `transcribe-3 ${reader.model}`;

const readyPages = async (doc: LoadedDoc, store: ScanStore, reader: Reader) => (await store.get(doc.sha256)).filter((p) => p.version === scanVersion(reader));
const needsReading = (page: Page, saved: ScanPage[]) => page.kind === "image" && !saved.some((s) => s.page === page.page);

/** How many scanned pages still have to be paid for. */
export async function untranscribed(docs: LoadedDoc[], store: ScanStore, reader: Reader): Promise<number> {
  const counts = await Promise.all(
    docs.map(async (doc) => {
      const saved = await readyPages(doc, store, reader);
      return doc.pages.filter((p) => needsReading(p, saved)).length;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/** Where OCR found a page's words, when it did so for the picture this transcription was read from. */
const detectedFor = (located: LocatePage[], scan: ScanPage) => located.find((l) => l.page === scan.page && l.version === locateVersion && l.rotation === scan.rotation);

/** A failure to line a page up with its OCR words leaves its marks approximate; it never stops a page from loading. */
function located(page: number, t: ScanPage["transcription"], words: OcrWord[]): Located | undefined {
  try {
    return locate(page, t, words);
  } catch {
    return undefined;
  }
}

/**
 * The doc with its transcribed pages, each with the blind second read of it in `verified` when one was kept for the page turned
 * the same way, and, from `detected`, where OCR found the page's words (§5.1): without that, every mark on the page is approximate.
 */
export function withScans(doc: LoadedDoc, pages: ScanPage[], verified: ScanPage[] = [], detected: LocatePage[] = []): LoadedDoc {
  const found = new Map(pages.map((p) => [p.page, p]));
  return {
    ...doc,
    pages: doc.pages.map((p) => {
      const scan = p.kind === "image" ? found.get(p.page) : undefined;
      if (!scan) return p;
      // the words only place the page's text for display; the agent and the quote check read the transcription's own structure
      const text = scanText(p.page, scan.transcription);
      const bands = Object.fromEntries([...bandsOf(scan.transcription)].map(([key, band]) => [`p${p.page}.${key}`, band]));
      const second = verified.find((v) => v.page === p.page && v.rotation === scan.rotation && quarterTurn(v.transcription.rotation) === 0)?.transcription;
      const words = detectedFor(detected, scan)?.words;
      const here = words && located(p.page, scan.transcription, words);
      const there = words && second && located(p.page, second, words);
      return { ...buildPage(p.page, toWords(scan.transcription), "scan", scan.rotation), raw: text, layout: text, cells: cellsOf(p.page, scan.transcription), transcription: scan.transcription, bands, ...(second && { second }), ...(here && { located: here }), ...(there && { locatedSecond: there }) };
    }),
  };
}


const pngWidth = (png: Buffer) => png.readUInt32BE(16);

/**
 * The dpi the model sees the page's small print at: the last image sent is a strip, or the whole page when it fits one.
 * ponytail: assumes the render wasn't lowered by MAX_SCAN_PIXELS, which only a page over about 300 square inches is.
 */
function effectiveDpi(png: Buffer, parts: Part[]): number | undefined {
  const last = parts.flatMap((p) => (p.type === "image" ? [p.png] : [])).at(-1);
  return last ? Math.round((SCAN_DPI * pngWidth(last)) / pngWidth(png)) : undefined;
}

/**
 * One transcription inside the budget: the estimate is held while the call runs, then replaced by what it cost. undefined
 * when the estimate doesn't fit.
 */
async function transcribeWithin(reader: Reader, budget: Budget, png: Buffer): Promise<{ read: Transcription; dpi?: number } | undefined> {
  const parts = await pageParts(png);
  const estimate = estimateUsd(reader, parts, OUTPUT_TOKENS);
  if (budget.spent + estimate > budget.limit) return undefined;
  budget.spent += estimate;
  try {
    const answer = await reader.ask(transcribeAsk(parts));
    budget.spent += answer.usd - estimate;
    return { read: parseTranscription(answer.value), dpi: effectiveDpi(png, parts) };
  } catch (err) {
    budget.spent += spentOn(err) - estimate;
    throw err;
  }
}

/** The saved pages of a doc whose words OCR hasn't located yet: only pages the doc has as scans, and only for the turn they were read at. */
export const unlocated = (doc: LoadedDoc, scans: ScanPage[], detected: LocatePage[]) => scans.filter((s) => doc.pages[s.page - 1]?.kind === "image" && !detectedFor(detected, s));

/**
 * Finds the words of one saved scanned page with OCR and keeps them. This is free and local; OCR only says where the
 * transcribed text sits, and its own text is never used. Throws if OCR can't run.
 */
export function locatePage(doc: LoadedDoc, scan: ScanPage, store: LocateStore, detect: (png: Buffer) => Promise<OcrWord[]> = detectWords): Promise<void> {
  // a read and the API's background pass can reach the same page; it is detected once
  const key = `${doc.sha256}:${scan.page}:${scan.rotation}`;
  const running = detecting.get(key);
  if (running) return running;
  const turned = { ...doc, pages: doc.pages.map((p) => (p.page === scan.page ? { ...p, rotation: scan.rotation } : p)) };
  const run = pdfReader
    .render(turned, scan.page, { dpi: LOCATE_DPI, maxPixels: LOCATE_MAX_PIXELS })
    .then(detect)
    .then((words) => store.put(doc.sha256, { page: scan.page, version: locateVersion, rotation: scan.rotation, words }))
    .finally(() => detecting.delete(key));
  detecting.set(key, run);
  return run;
}
const detecting = new Map<string, Promise<void>>();

const MAX_READS = 3;

async function transcribePage(doc: LoadedDoc, page: Page, reader: Reader, budget: Budget, onProgress?: (line: string) => void): Promise<ScanPage | undefined> {
  const render = (of: LoadedDoc) => pdfReader.render(of, page.page, { dpi: SCAN_DPI, maxPixels: MAX_SCAN_PIXELS });
  let rotation = 0;
  let done = await transcribeWithin(reader, budget, await render(doc));
  // each read reports the turn still needed on the picture it was given, so the page's turn is their sum
  for (let reads = 1; done && quarterTurn(done.read.rotation) !== 0 && reads < MAX_READS; reads++) {
    rotation = (rotation + quarterTurn(done.read.rotation)) % 360;
    const turned = { ...doc, pages: doc.pages.map((p) => (p.page === page.page ? { ...p, rotation } : p)) };
    done = await transcribeWithin(reader, budget, await render(turned));
  }
  if (!done) return undefined;
  // shows on a paid run whether tiny print on landscape pages needs smaller strips
  if (done.dpi) onProgress?.(`p.${page.page} of ${doc.name} read at ${done.dpi} dpi`);
  if (quarterTurn(done.read.rotation) !== 0) onProgress?.(`p.${page.page} of ${doc.name} may still be turned the wrong way`);
  return { page: page.page, version: scanVersion(reader), rotation, transcription: done.read };
}

export async function scanDocs(docs: LoadedDoc[], opts: { reader: Reader; store: ScanStore; budget: Budget; onProgress?: (line: string) => void; detect?: (png: Buffer) => Promise<OcrWord[]> }): Promise<LoadedDoc[]> {
  const { reader, store, budget } = opts;
  const saved = await Promise.all(docs.map((doc) => readyPages(doc, store, reader)));
  const todo = docs.flatMap((doc, i) => doc.pages.filter((p) => needsReading(p, saved[i]!)).map((page) => ({ doc, page, saved: saved[i]! })));

  let done = 0;
  let outOfBudget = false;
  let failure: { name: string; page: number; cause: unknown } | undefined;
  const progress = () => opts.onProgress?.(`Reading scanned pages: ${done} of ${todo.length}`);
  if (todo.length) progress();

  let next = 0;
  const worker = async () => {
    while (!outOfBudget && !failure && next < todo.length) {
      const job = todo[next++]!;
      try {
        const scan = await transcribePage(job.doc, job.page, reader, budget, opts.onProgress);
        if (!scan) {
          outOfBudget = true;
          return;
        }
        await store.put(job.doc.sha256, scan);
        job.saved.push(scan);
        if (!toWords(scan.transcription).length) opts.onProgress?.(`p.${job.page.page} of ${job.doc.name} looked blank when read from the image`);
        done++;
        progress();
      } catch (cause) {
        failure ??= { name: job.doc.name, page: job.page.page, cause };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PAGES, todo.length) }, worker));

  if (failure) {
    throw new ReadFailed(`${failure.name} p.${failure.page} couldn't be read, so the read stopped. The pages already read are kept, so starting the read again continues from there.`, budget.spent, { cause: failure.cause });
  }
  if (outOfBudget) {
    throw new ReadFailed(`Stopped at the $${budget.limit.toFixed(2)} limit after reading ${done} of ${todo.length} scanned pages. They're kept, so starting the read again continues from there.`, budget.spent);
  }
  const detected = await Promise.all(docs.map((doc, i) => locateAll(doc, saved[i]!, opts)));
  return docs.map((doc, i) => withScans(doc, saved[i]!, [], detected[i]));
}

/** Locates every saved scanned page of the doc that isn't yet, one at a time; a page it can't do stays approximate. Costs nothing. */
async function locateAll(doc: LoadedDoc, scans: ScanPage[], opts: { store: ScanStore; onProgress?: (line: string) => void; detect?: (png: Buffer) => Promise<OcrWord[]> }): Promise<LocatePage[]> {
  const { locate: store } = opts.store;
  if (!store) return [];
  const todo = unlocated(doc, scans, await store.get(doc.sha256));
  for (const [n, scan] of todo.entries()) {
    opts.onProgress?.(`Finding where each line sits on ${doc.name}: page ${n + 1} of ${todo.length} scanned`);
    await locatePage(doc, scan, store, opts.detect).catch(() => opts.onProgress?.(`p.${scan.page} of ${doc.name}: couldn't find exactly where its lines sit, so its highlights will cover a larger area`));
  }
  return store.get(doc.sha256);
}
