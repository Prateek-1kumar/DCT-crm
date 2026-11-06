import { estimateUsd, spentOn, type Budget, type Reader } from "../models";
import { pdfReader } from "../pdf";
import { buildPage } from "../pdf/page";
import { ReadFailed } from "../read";
import type { LoadedDoc, Page, ScanPage, ScanStore } from "../types";
import { MAX_SCAN_PIXELS, SCAN_DPI, pageParts, transcribeAsk, type Transcription } from "./transcribe";
import { toWords } from "./words";

export { fileScanStore } from "./store";

/** What the budget adds for each scanned page not yet transcribed: about $0.30 for a dense budget page, much less for prose. */
export const SCAN_PAGE_USD = 0.4;

const OUTPUT_TOKENS = 8000;
const PARALLEL_PAGES = 4;

export const scanVersion = (reader: Reader) => `transcribe-1 ${reader.model}`;

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

export function withScans(doc: LoadedDoc, pages: ScanPage[]): LoadedDoc {
  const found = new Map(pages.map((p) => [p.page, p]));
  return {
    ...doc,
    pages: doc.pages.map((p) => {
      const scan = p.kind === "image" ? found.get(p.page) : undefined;
      // copied, because masking bank numbers rewrites the words in place
      return scan ? buildPage(p.page, scan.words.map((w) => ({ ...w })), "scan", scan.rotation) : p;
    }),
  };
}

const quarterTurn = (degrees: number) => (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;

/** One transcription inside the budget: the estimate is held while the call runs, then replaced by what it cost. undefined when the estimate doesn't fit. */
async function transcribeWithin(reader: Reader, budget: Budget, png: Buffer): Promise<Transcription | undefined> {
  const parts = await pageParts(png);
  const estimate = estimateUsd(reader, parts, OUTPUT_TOKENS);
  if (budget.spent + estimate > budget.limit) return undefined;
  budget.spent += estimate;
  try {
    const answer = await reader.ask(transcribeAsk(parts));
    budget.spent += answer.usd - estimate;
    return answer.value;
  } catch (err) {
    budget.spent += spentOn(err) - estimate;
    throw err;
  }
}

async function transcribePage(doc: LoadedDoc, page: Page, reader: Reader, budget: Budget): Promise<ScanPage | undefined> {
  const render = (of: LoadedDoc) => pdfReader.render(of, page.page, { dpi: SCAN_DPI, maxPixels: MAX_SCAN_PIXELS });
  const first = await transcribeWithin(reader, budget, await render(doc));
  if (!first) return undefined;
  const rotation = quarterTurn(first.rotation);
  if (rotation === 0) return { page: page.page, version: scanVersion(reader), rotation, words: toWords(first) };

  const turned = { ...doc, pages: doc.pages.map((p) => (p.page === page.page ? { ...p, rotation } : p)) };
  const second = await transcribeWithin(reader, budget, await render(turned));
  return second && { page: page.page, version: scanVersion(reader), rotation, words: toWords(second) };
}

export async function scanDocs(docs: LoadedDoc[], opts: { reader: Reader; store: ScanStore; budget: Budget; onProgress?: (line: string) => void }): Promise<LoadedDoc[]> {
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
        const scan = await transcribePage(job.doc, job.page, reader, budget);
        if (!scan) {
          outOfBudget = true;
          return;
        }
        await store.put(job.doc.sha256, scan);
        job.saved.push(scan);
        if (!scan.words.length) opts.onProgress?.(`p.${job.page.page} of ${job.doc.name} looked blank when read from the image`);
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
  return docs.map((doc, i) => withScans(doc, saved[i]!));
}
