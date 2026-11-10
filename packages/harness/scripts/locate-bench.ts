// Free measurement of the locator (§5.1), no model calls: text pages from local contracts are drawn as degraded scans, a
// stand-in transcription is made from the text layer (one line per printed line, vertical guesses jittered by 1-2% of the
// page like the model's), the lines are located against real OCR, and every amount's and line's box is compared with where
// the text layer says it is. Prints numbers only, never contract text, amounts or file names.
//   pnpm --filter @dct/harness locate-bench [--pages 30] [--independent] [--tables]
// The model's vertical guesses drift smoothly down a page (the default); --independent jitters each line on its own, which
// also swaps neighbouring lines in the order the page is read, a harsher test than the model gives.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Region } from "@dct/shared";
import { amountsAt, looseKey } from "../src/checks/text";
import { pdfReader } from "../src/pdf";
import { groupLines, rawLine } from "../src/pdf/lines";
import { locateVersion, stopDetector, withScans } from "../src/scan";
import { LOCATE_DPI, detectWords } from "../src/scan/detect";
import { buildPage } from "../src/pdf/page";
import { amountPlace, cellPlace } from "../src/scan/place";
import type { Transcription } from "../src/scan/transcribe";
import { scanOf } from "./degraded-scan";

const args = process.argv.slice(2);
const maxPages = Number(args.includes("--pages") ? args[args.indexOf("--pages") + 1] : 30);
const root = resolve(import.meta.dirname, "../../../data");

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".pdf") ? [join(dir, e.name)] : []));
const pdfs = [...new Set(["uploads", "contracts"].map((d) => join(root, d)).filter(existsSync).flatMap(walk))];

// a seeded generator, so a run is repeatable
let seed = 7;
const random = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const independent = args.includes("--independent");
/** A page's vertical guesses: 1-2% of the page off, drifting smoothly down the page, or each line's own with --independent. */
function guesses() {
  const [amplitude, phase, turns] = [0.01 + 0.01 * random(), random() * 2 * Math.PI, 1 + random() * 2];
  return (y: number) => (independent ? (random() < 0.5 ? -1 : 1) * (0.01 + 0.01 * random()) : amplitude * Math.sin(phase + turns * 2 * Math.PI * y) + 0.002 * (random() - 0.5));
}

const inter = (a: Region, b: Region): Region => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
// The text layer's boxes are the font's and sit about half a text height off the glyphs OCR boxes, so boxes are compared by their
// centre line and across: a right box is on the truth's line and covers its width; a wrong one is on another line or word.
const cy = (b: Region) => (b[1] + b[3]) / 2;
const sits = (place: Region, truth: Region) => Math.abs(cy(place) - cy(truth)) <= 0.9 * (truth[3] - truth[1]) && (inter(place, truth)[2] - inter(place, truth)[0]) / Math.min(place[2] - place[0], truth[2] - truth[0]) >= 0.5;
// a larger area holds the truth when it spans the truth's width and its centre line
const contains = (outer: Region, inner: Region) => outer[0] <= inner[0] + 0.004 && outer[2] >= inner[2] - 0.004 && outer[1] <= cy(inner) && outer[3] >= cy(inner);
const union = (boxes: Region[]): Region => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];

interface Tally { total: number; exactRight: number; exactWrong: number; approxHolds: number; approxMisses: number }
const tally = (): Tally => ({ total: 0, exactRight: 0, exactWrong: 0, approxHolds: 0, approxMisses: 0 });
const debug = args.includes("--debug");
const count = (name: string, t: Tally, truth: Region, place: { box: Region; approx?: true }, copies = 0, tier = "") => {
  t.total++;
  if (debug && ((!place.approx && !sits(place.box, truth)) || (place.approx && !contains(place.box, truth)))) {
    const h = truth[3] - truth[1];
    // numbers only: how far, in text heights, the box's centre is from the truth's, how tall the box is, and how many same-text words the page has
    console.log(`  ${name} ${tier} ${place.approx ? "miss" : "WRONG"} dy=${(((place.box[1] + place.box[3]) / 2 - (truth[1] + truth[3]) / 2) / h).toFixed(1)} dx=${(((place.box[0] + place.box[2]) / 2 - (truth[0] + truth[2]) / 2) / 0.05).toFixed(1)} height=${((place.box[3] - place.box[1]) / h).toFixed(1)} copies=${copies}`);
  }
  if (!place.approx) t[sits(place.box, truth) ? "exactRight" : "exactWrong"]++;
  else t[contains(place.box, truth) ? "approxHolds" : "approxMisses"]++;
};
const show = (name: string, t: Tally) => {
  const pct = (n: number) => `${((100 * n) / Math.max(1, t.total)).toFixed(1)}%`;
  console.log(`${name}: n=${t.total} exact-and-correct=${pct(t.exactRight)} approx-and-containing=${pct(t.approxHolds)} approx-not-containing=${pct(t.approxMisses)} claimed-exact-but-WRONG=${pct(t.exactWrong)} (${t.exactWrong})`);
};

const tablesMode = args.includes("--tables");
const amounts = tally();
const cells = tally();
const lines = tally();
let pages = 0;
let seconds = 0;
for (const path of pdfs) {
  if (pages >= maxPages) break;
  const doc = await pdfReader.load(path);
  for (const page of doc.pages.filter((p) => p.kind === "text")) {
    if (pages >= maxPages) break;
    const printed = groupLines(page.words);
    if (!printed.some((l) => amountsAt(rawLine(l)).length)) continue;
    pages++;

    const guess = guesses();
    const span = (l: typeof printed[number]) => {
      const [top, bottom] = [Math.min(...l.map((w) => w.y0)), Math.max(...l.map((w) => w.y1))];
      const off = guess(top);
      return { top: Math.max(0, top + off), bottom: Math.min(1, bottom + off) };
    };
    // with --tables, each run of printed lines with two or more amounts is a table: a row per line, the words before its first
    // amount as the label and one cell per amount; every other line stays a line
    const asRow = printed.map((l) => tablesMode && amountsAt(rawLine(l)).length >= 2);
    const t: Transcription = { rotation: 0, lines: [], tables: [] };
    const ids: string[] = [];
    printed.forEach((line, i) => {
      const { top, bottom } = span(line);
      if (!asRow[i]) {
        t.lines.push({ text: rawLine(line), top, bottom, unsure: false, marks: [] });
        ids.push(`p${page.page}.l${t.lines.length}`);
        return;
      }
      if (!asRow[i - 1]) t.tables.push({ title: "", top, bottom, columns: [], rows: [] });
      const table = t.tables.at(-1)!;
      const found = amountsAt(rawLine(line));
      table.rows.push({ label: rawLine(line).slice(0, found[0]!.start).trim(), top, bottom, cells: found.map((a) => ({ text: a.text, unsure: false, marks: [] })) });
      table.bottom = bottom;
      ids.push(`p${page.page}.t${t.tables.length}.r${table.rows.length}`);
    });
    const t0 = performance.now();
    const words = await detectWords(await scanOf(path, page));
    seconds += (performance.now() - t0) / 1000;
    const shown = withScans({ ...doc, pages: [buildPage(page.page, [], "image")] }, [{ page: page.page, version: "bench", rotation: 0, transcription: t }], [], [{ page: page.page, version: locateVersion, rotation: 0, words }]).pages[0]!;

    printed.forEach((line, i) => {
      // cells come in the order the guessed positions put them, so each is found by its id
      const texts = line.map((w) => w.text);
      const lineCell = asRow[i] ? undefined : shown.cells!.find((c) => c.id === ids[i])!;
      if (lineCell) count("line", lines, union(line.map((w) => [w.x0, w.y0, w.x1, w.y1])), cellPlace(shown, lineCell), 0, shown.located!.rows[lineCell.id] ? "row" : shown.located!.bands[lineCell.id] ? "band" : "none");
      const seen = new Map<string, number>();
      amountsAt(rawLine(line)).forEach((a, k) => {
        const copy = seen.get(a.text) ?? 0;
        seen.set(a.text, copy + 1);
        // the amount's words in the text layer: the nth run of words that print it
        const parts = a.text.split(/\s+/);
        const at = texts.flatMap((_, n) => (parts.every((p, j) => texts[n + j] === p) ? [n] : []))[copy];
        if (at === undefined) return;
        const cell = lineCell ?? shown.cells!.find((c) => c.id === `${ids[i]}.c${k + 1}`)!;
        const place = amountPlace(shown, cell, a.text, lineCell ? copy : 0);
        const tally = lineCell ? amounts : cells;
        if (debug && place.approx) {
          const key = looseKey(a.text);
          const here = words.filter((w) => looseKey(w.text) === key).length;
          const there = shown.cells!.flatMap((c) => c.text.split(/\s+/).filter((x) => looseKey(x) === key)).length;
          console.log(`  approxamount ${lineCell ? "line" : "table"} ${shown.located!.rows[cell.id.replace(/\.c\d+$/, "")] ? "row" : "band"} ocrCopies=${here} transcribedCopies=${there}`);
        }
        count(lineCell ? "amount" : "cell", tally, union(line.slice(at, at + parts.length).map((w) => [w.x0, w.y0, w.x1, w.y1])), place, page.words.filter((w) => w.text === a.text).length);
      });
    });
  }
}
await stopDetector();
console.log(`pages=${pages} dpi=${LOCATE_DPI} sec/page=${(seconds / Math.max(1, pages)).toFixed(1)}`);
show(tablesMode ? "amounts in lines" : "amounts", amounts);
if (tablesMode) show("amounts in table cells", cells);
show("lines", lines);
