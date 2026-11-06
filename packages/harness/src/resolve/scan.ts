import { applyPatches, type Patch, type Question, type Region, type Source } from "@dct/shared";
import { needsProof } from "../checks";
import { findQuote } from "../checks/coverage";
import { usd } from "../checks/text";
import type { CheckReport, Doubt, Page, Word } from "../types";
import { askPages, cellLabel, printQuestion, proven, raise, raiseZoomed, readCell, same, shown, termLabel } from "./read";
import type { Run } from "./run";

const PAD = 0.015;

const MARKS: Partial<Record<Doubt, string>> = { handwritten: "handwritten", struck_out: "struck out", initialed: "initialed" };

interface Spot {
  source: Source;
  about: Question["about"];
  label: string;
  questionId: string;
  current: number;
  /** What was transcribed at this spot: the quote's lines, or none when the quote can't be found. */
  words: Word[];
  /** Where to look closer; undefined when the spot can't be found, so the whole page is shown. */
  crop?: Region;
  patch(value: number): Patch;
}

const lineBand = (words: Word[], text: string): [number, number] | null => {
  const boxes = findQuote(words, text);
  return boxes.length ? [Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[3]))] : null;
};

const wordsIn = (page: Page, band: [number, number] | null) => (band ? page.words.filter((w) => (w.y0 + w.y1) / 2 >= band[0] && (w.y0 + w.y1) / 2 <= band[1]) : []);

function spotsOf(run: Run, report: CheckReport): Spot[] {
  const scanPage = (doc: string, n: number) => run.docs.find((d) => d.name === doc)?.pages.find((p) => p.page === n && p.kind === "scan");
  const spots: Spot[] = [];

  for (const t of run.rulebook.terms) {
    const page = scanPage(t.source.doc, t.source.page);
    if (!page || !needsProof(t, page)) continue;
    const band = lineBand(page.words, t.source.quote);
    spots.push({
      source: t.source, about: { target: "term", id: t.id }, label: termLabel(t), questionId: `read:${t.id}`, current: t.amountCents!, words: wordsIn(page, band),
      crop: band ? [0, Math.max(0, band[0] - PAD), 1, Math.min(1, band[1] + PAD)] : undefined,
      patch: (v) => ({ target: "term", id: t.id, set: { amountCents: v } }),
    });
  }

  for (const g of run.rulebook.grids) {
    const pages = g.pages.flatMap((n) => scanPage(g.doc, n) ?? []);
    // a grid whose arithmetic fails is read again whole by rereadScanGrids
    const open = report.grids[g.id]?.problems.length ? [] : (report.grids[g.id]?.unproven ?? []);
    for (const { row, col } of pages.length ? open : []) {
      const current = g.rows[row]!.cells[col];
      if (typeof current !== "number") continue;
      const name = g.rows[row]!.name;
      const page = pages.find((p) => findQuote(p.words, name).length) ?? pages[0]!;
      const band = lineBand(page.words, name);
      spots.push({
        source: { doc: g.doc, page: page.page, quote: "" }, about: { target: "grid", id: g.id }, label: cellLabel(g, row, col), questionId: `read:${g.id}`, current, words: wordsIn(page, band),
        // from the top of the page, so the visit headings above the row are in the picture
        crop: band ? [0, 0, 1, Math.min(1, band[1] + PAD)] : undefined,
        patch: (v) => ({ target: "grid", id: g.id, set: { [`rows.${row}.cells.${col}`]: v } }),
      });
    }
  }
  return spots;
}

const grouped = <T>(items: T[], key: (t: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
};

const markOf = (s: Spot) => s.words.flatMap((w) => (w.doubt && MARKS[w.doubt]) || [])[0];
const values = (n: number) => `${n} ${n === 1 ? "value" : "values"}`;

/** Grid cells share one question, so its picture runs from the top of the page to the lowest of them. */
function remember(run: Run, group: Spot[]) {
  const crop = group.map((s) => s.crop).filter((c): c is Region => c !== undefined).sort((a, b) => b[3] - a[3])[0];
  if (crop) run.crops.set(group[0]!.questionId, crop);
}

const question = (group: Spot[]) => ({ id: group[0]!.questionId, about: group[0]!.about, source: group[0]!.source, question: printQuestion(group[0]!.source, group.map((s) => s.label)) });

/**
 * For each amount the model wrote on a scanned page that arithmetic doesn't prove: a value marked handwritten, struck out or
 * initialed goes straight to a person; any other gets a zoomed second look at its spot by the vision reader, who isn't shown
 * the value. The same reading proves it (two_reads); a different one is asked.
 */
export async function relook(run: Run, report: CheckReport) {
  const spots = spotsOf(run, report);

  for (const group of grouped(spots.filter(markOf), (s) => s.questionId)) {
    remember(run, group);
    raise(run, {
      ...question(group),
      context: group.map((s) => `${group.length > 1 ? `${s.label}: ` : ""}p.${s.source.page} shows this value ${markOf(s)}`).join("; "),
      readings: [],
      options: [{ label: group.length === 1 ? `Use ${usd(group[0]!.current)}` : "Use these values", patches: group.map((s) => s.patch(s.current)) }],
    });
    run.log.push(`p.${group[0]!.source.page} (${group[0]!.source.doc}): ${values(group.length)} marked on the page, so a person will be asked`);
  }

  for (const group of grouped(spots.filter((s) => !markOf(s)), (s) => JSON.stringify([s.source.doc, s.source.page, s.crop ?? null]))) {
    const { doc, page } = group[0]!.source;
    try {
      const [answers] = await askPages(run, [run.openai], { doc, pages: [page], region: group[0]!.crop }, group);
      const confirmed = group.filter((s, i) => same(readCell(answers![i]!), s.current));
      if (confirmed.length) {
        run.rulebook = applyPatches(run.rulebook, proven(run.rulebook, confirmed.map((s) => s.patch(s.current))));
        run.log.push(`p.${page} (${doc}): a closer look confirms ${values(confirmed.length)} ✓`);
      }
      const differ = group.flatMap((s, i) => (confirmed.includes(s) ? [] : [{ s, said: answers![i]! }]));
      for (const rows of grouped(differ, ({ s }) => s.questionId)) {
        const spotsHere = rows.map(({ s }) => s);
        remember(run, spotsHere);
        raiseZoomed(run, question(spotsHere), rows.map(({ s, said }) => {
          const read = readCell(said);
          return { label: s.label, whole: shown(s.current), read: said, keep: s.patch(s.current), use: typeof read === "number" ? s.patch(read) : null };
        }));
        run.log.push(`p.${page} (${doc}): a closer look read ${values(rows.length)} differently, so a person will be asked`);
      }
    } catch (err) {
      for (const rows of grouped(group, (s) => s.questionId)) {
        remember(run, rows);
        raise(run, { ...question(rows), context: "This still needs a closer second read of the page, and it could not be done in this run.", readings: [], options: [] });
      }
      run.log.push(`p.${page} (${doc}): the closer look could not be done (${err instanceof Error ? err.message : "it could not be read"}), so a person will be asked`);
    }
  }
}
