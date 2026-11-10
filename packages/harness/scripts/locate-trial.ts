// Free trial of Tesseract as a locator only (§5.1): for every saved transcription found locally, how many of its amounts
// have an OCR word with the same digits somewhere on the page, per setting. Prints sha prefixes and counts only, never
// contract text, amounts or file names.
//   pnpm --filter @dct/harness locate-trial [--dpi 200,300] [--psm 3,6,11] [--pages 6]
// With --match it instead runs the built locator (detect + match, the settings the app uses) on the same saved scans and
// counts how many printed lines were found and how many amounts got an exact box.
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createWorker, type Page as OcrPage } from "tesseract.js";
import { amountsAt, looseKey } from "../src/checks/text";
import { pdfReader } from "../src/pdf";
import { cellsOf } from "../src/scan/cells";
import { parseCents } from "@dct/shared";
import type { LoadedDoc, ScanPage } from "../src/types";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback);
const dpis = flag("--dpi", "200,300").split(",").map(Number);
const psms = flag("--psm", "3,6,11").split(",");
const maxPages = Number(flag("--pages", "1000"));

const root = resolve(import.meta.dirname, "../../../data");
const digits = (s: string) => s.replace(/\D/g, "");

/** Each amount-bearing figure of a transcription as its digit string: amounts printed with a $ or cents, or a bare number alone in its cell. */
function wanted(page: number, scan: ScanPage): string[] {
  return cellsOf(page, scan.transcription).flatMap((c) => {
    const found = amountsAt(c.text).map((a) => digits(a.text));
    const bare = parseCents(c.text) !== null ? [digits(c.text)] : [];
    return (found.length ? found : bare).filter((d) => d.length >= 2);
  });
}

/** The transcription's words of four letters or more, as loose keys: the text a quote or a row label is found by. */
const wordsWanted = (page: number, scan: ScanPage) => cellsOf(page, scan.transcription).flatMap((c) => c.text.split(/\s+/).map(looseKey).filter((k) => k.length >= 4));

function pdfsBySha() {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".pdf") && /^[0-9a-f]{64}\.pdf$/.test(e.name)) found.set(e.name.slice(0, 64), p);
    }
  };
  walk(root);
  return found;
}

const scanFiles = [join(root, "uploads"), join(root, "scans")].flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".scan.json")).map((f) => join(dir, f)) : []));
const pdfs = pdfsBySha();

const sources: { sha: string; doc: LoadedDoc; scans: ScanPage[] }[] = [];
for (const file of scanFiles) {
  const sha = file.split("/").at(-1)!.slice(0, 64);
  const pdf = pdfs.get(sha);
  if (!pdf) {
    console.log(`${sha.slice(0, 8)}: no pdf with this hash here, skipped`);
    continue;
  }
  sources.push({ sha, doc: await pdfReader.load(pdf), scans: (JSON.parse(await readFile(file, "utf8")) as ScanPage[]).filter((p) => p.transcription).sort((a, b) => a.page - b.page).slice(0, maxPages) });
}

if (args.includes("--match")) {
  const { detectWords, stopDetector, LOCATE_DPI, LOCATE_MAX_PIXELS, locateVersion } = await import("../src/scan/detect").then(async (d) => ({ ...d, locateVersion: d.locateVersion }));
  const { locate } = await import("../src/scan/match");
  const { withScans } = await import("../src/scan");
  const { amountPlace } = await import("../src/scan/place");
  const sum = { pages: 0, lines: 0, found: 0, amounts: 0, exact: 0, tableAmounts: 0, tableExact: 0, detectMs: 0, matchMs: 0 };
  for (const { sha, doc, scans } of sources) {
    for (const s of scans) {
      const turned = { ...doc, pages: doc.pages.map((p) => (p.page === s.page ? { ...p, rotation: s.rotation } : p)) };
      const t0 = performance.now();
      const words = await detectWords(await pdfReader.render(turned, s.page, { dpi: LOCATE_DPI, maxPixels: LOCATE_MAX_PIXELS }));
      const t1 = performance.now();
      const found = locate(s.page, s.transcription, words);
      const t2 = performance.now();
      const shown = withScans(doc, [s], [], [{ page: s.page, version: locateVersion, rotation: s.rotation, words }]).pages[s.page - 1]!;
      const elements = new Set(shown.cells!.map((c) => c.id.replace(/\.c\d+$/, "").replace(/\.h\d+$/, ".h")));
      sum.pages++;
      sum.lines += elements.size;
      sum.found += Object.keys(found.rows).length;
      sum.detectMs += t1 - t0;
      sum.matchMs += t2 - t1;
      for (const c of shown.cells!) {
        const seen = new Map<string, number>();
        for (const a of amountsAt(c.text)) {
          const copy = seen.get(a.text) ?? 0;
          seen.set(a.text, copy + 1);
          const exact = !amountPlace(shown, c, a.text, copy).approx;
          sum.amounts++;
          if (exact) sum.exact++;
          if (c.table !== null) {
            sum.tableAmounts++;
            if (exact) sum.tableExact++;
          }
        }
      }
    }
    console.log(`${sha.slice(0, 8)} done`);
  }
  await stopDetector();
  console.log(`MATCH pages=${sum.pages} lines=${sum.lines} found=${sum.found} amounts=${sum.amounts} exact=${sum.exact} table-amounts=${sum.tableAmounts} table-exact=${sum.tableExact} detect sec/page=${(sum.detectMs / 1000 / Math.max(1, sum.pages)).toFixed(1)} match sec/page=${(sum.matchMs / 1000 / Math.max(1, sum.pages)).toFixed(2)} peak memory ~${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  process.exit(0);
}

const worker = await createWorker("eng", 1, { langPath: resolve(import.meta.dirname, "../node_modules/@tesseract.js-data/eng/4.0.0"), gzip: true, cacheMethod: "none" });
const totals = new Map<string, { want: number; found: number; ms: number; pages: number; words: number; textWant: number; textFound: number }>();

for (const dpi of dpis) {
  for (const { sha, doc, scans } of sources) {
    const images = new Map<number, Buffer>();
    for (const s of scans) {
      const turned = { ...doc, pages: doc.pages.map((p) => (p.page === s.page ? { ...p, rotation: s.rotation } : p)) };
      images.set(s.page, await pdfReader.render(turned, s.page, { dpi, maxPixels: 12e6 }));
    }
    for (const psm of psms) {
      await worker.setParameters({ tessedit_pageseg_mode: psm as never, user_defined_dpi: String(dpi) });
      let want = 0, found = 0, ms = 0, wordCount = 0, textWant = 0, textFound = 0;
      for (const s of scans) {
        const t0 = performance.now();
        const { data } = await worker.recognize(images.get(s.page)!, {}, { blocks: true });
        ms += performance.now() - t0;
        const words = ((data as OcrPage).blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
        wordCount += words.length;
        const have = new Set(words.map((w) => digits(w.text)));
        const haveText = new Set(words.map((w) => looseKey(w.text)));
        for (const k of wordsWanted(s.page, s)) {
          textWant++;
          if (haveText.has(k)) textFound++;
        }
        for (const d of wanted(s.page, s)) {
          want++;
          if (have.has(d)) found++;
        }
      }
      console.log(`${sha.slice(0, 8)} dpi=${dpi} psm=${psm}: pages=${scans.length} amounts=${want} findable=${found} words=${wordCount} textWords=${textWant} textFound=${textFound} sec/page=${(ms / 1000 / Math.max(1, scans.length)).toFixed(1)}`);
      const key = `dpi=${dpi} psm=${psm}`;
      const t = totals.get(key) ?? { want: 0, found: 0, ms: 0, pages: 0, words: 0, textWant: 0, textFound: 0 };
      totals.set(key, { want: t.want + want, found: t.found + found, ms: t.ms + ms, pages: t.pages + scans.length, words: t.words + wordCount, textWant: t.textWant + textWant, textFound: t.textFound + textFound });
    }
  }
}
await worker.terminate();
for (const [key, t] of totals) console.log(`TOTAL ${key}: pages=${t.pages} amounts=${t.want} findable=${t.found} (${((100 * t.found) / Math.max(1, t.want)).toFixed(1)}%) text words=${t.textWant} found=${((100 * t.textFound) / Math.max(1, t.textWant)).toFixed(1)}% sec/page=${(t.ms / 1000 / Math.max(1, t.pages)).toFixed(1)}`);
console.log(`peak memory ~${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
