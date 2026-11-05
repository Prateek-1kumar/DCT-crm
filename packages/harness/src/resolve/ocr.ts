import { applyPatches, type Patch, type Region } from "@dct/shared";
import { needsProof } from "../checks";
import { findQuote } from "../checks/coverage";
import { ocrAmounts } from "../checks/text";
import { groupLines } from "../pdf/lines";
import type { CheckReport, Page, Word } from "../types";
import { askPages, cellLabel, proven, readCell, same, termLabel } from "./read";
import type { Run } from "./run";

const PAD = 0.015;

interface Spot {
  doc: string;
  page: number;
  label: string;
  questionId: string;
  current: number;
  /** What OCR read at this spot: the quote's lines, or none when the quote can't be found, so OCR can't prove it. */
  words: Word[];
  /** A grid row's cells, which OCR must read in this order on the row's line, so a value in the wrong column isn't proven. */
  row?: number[];
  /** Where to look closer; undefined when the spot can't be found, so the whole page is shown. */
  crop?: Region;
  patch: Patch;
}

const lineBand = (words: Word[], text: string): [number, number] | null => {
  const boxes = findQuote(words, text);
  return boxes.length ? [Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[3]))] : null;
};

const wordsIn = (page: Page, band: [number, number] | null) => (band ? page.words.filter((w) => (w.y0 + w.y1) / 2 >= band[0] && (w.y0 + w.y1) / 2 <= band[1]) : []);

function spotsOf(run: Run, report: CheckReport): Spot[] {
  const ocrPage = (doc: string, n: number) => run.docs.find((d) => d.name === doc)?.pages.find((p) => p.page === n && p.kind === "ocr");
  const spots: Spot[] = [];

  for (const t of run.rulebook.terms) {
    const page = ocrPage(t.source.doc, t.source.page);
    if (!page || !needsProof(t, page)) continue;
    const band = lineBand(page.words, t.source.quote);
    spots.push({
      doc: t.source.doc, page: page.page, label: termLabel(t), questionId: `read:${t.id}`, current: t.amountCents!, words: wordsIn(page, band),
      crop: band ? [0, Math.max(0, band[0] - PAD), 1, Math.min(1, band[1] + PAD)] : undefined,
      patch: { target: "term", id: t.id, set: { amountCents: t.amountCents } },
    });
  }

  for (const g of run.rulebook.grids) {
    const pages = g.pages.flatMap((n) => ocrPage(g.doc, n) ?? []);
    for (const { row, col } of pages.length ? (report.grids[g.id]?.unproven ?? []) : []) {
      const cells = g.rows[row]!.cells;
      const current = cells[col];
      if (typeof current !== "number") continue;
      const name = g.rows[row]!.name;
      const page = pages.find((p) => findQuote(p.words, name).length) ?? pages[0]!;
      const band = lineBand(page.words, name);
      spots.push({
        doc: g.doc, page: page.page, label: cellLabel(g, row, col), questionId: `read:${g.id}`, current, words: wordsIn(page, band),
        // with a blank cell in the row, which column a value sits in can't be told from the line's order
        row: cells.every((c) => typeof c === "number") ? (cells as number[]) : [],
        // from the top of the page, so the visit headings above the row are in the picture
        crop: band ? [0, 0, 1, Math.min(1, band[1] + PAD)] : undefined,
        patch: { target: "grid", id: g.id, set: { [`rows.${row}.cells.${col}`]: current } },
      });
    }
  }
  return spots;
}

const inOrder = (read: number[], row: number[]) => row.length > 0 && read.some((_, at) => row.every((c, i) => read[at + i] === c));

function readByOcr(s: Spot) {
  return groupLines(s.words).some((line) => {
    const texts = line.map((w) => w.text);
    if (s.row) return inOrder(ocrAmounts(texts, (c) => s.row!.includes(c)).map((a) => a.cents), s.row);
    return ocrAmounts(texts, (c) => c === s.current).some((a) => a.cents === s.current);
  });
}

const values = (n: number) => `${n} ${n === 1 ? "value" : "values"}`;

/**
 * For each amount the model wrote on an OCR page that arithmetic doesn't prove: a match with what OCR read there proves it
 * (ocr_match); otherwise one focused second look at that spot, without the OCR text or the value, which proves it
 * (two_reads) if it reads the same. What neither settles is left for the two models to read.
 */
export async function reconcile(run: Run, report: CheckReport) {
  const spots = spotsOf(run, report);
  const matched = spots.filter(readByOcr);
  if (matched.length) {
    run.rulebook = applyPatches(run.rulebook, proven(run.rulebook, matched.map((s) => s.patch), "ocr_match"));
    run.log.push(`OCR read ${values(matched.length)} on scanned pages as the model wrote them ✓`);
  }

  const groups = new Map<string, Spot[]>();
  for (const s of spots.filter((x) => !matched.includes(x))) {
    const key = JSON.stringify([s.doc, s.page, s.crop ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const group of groups.values()) {
    const { doc, page, crop } = group[0]!;
    try {
      const [answers] = await askPages(run, [run.claude], { doc, pages: [page], region: crop }, group);
      const confirmed = group.filter((s, i) => same(readCell(answers![i]!), s.current));
      for (const s of group) if (s.crop && !confirmed.includes(s) && !run.crops.has(s.questionId)) run.crops.set(s.questionId, s.crop);
      if (!confirmed.length) continue;
      run.rulebook = applyPatches(run.rulebook, proven(run.rulebook, confirmed.map((s) => s.patch)));
      run.log.push(`p.${page} (${doc}): a second look confirms ${values(confirmed.length)} ✓`);
    } catch (err) {
      run.log.push(`p.${page} (${doc}): the second look could not be done (${err instanceof Error ? err.message : "it could not be read"})`);
    }
  }
}
