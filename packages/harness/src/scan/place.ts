import type { Region } from "@dct/shared";
import { looseFind, looseKey } from "../checks/text";
import type { Page } from "../types";
import type { ScanCell } from "./cells";
import { elementOf } from "./match";

/** A box to draw on a scanned page: `approx` is set unless the words themselves were found there. */
export interface Place {
  box: Region;
  approx?: true;
}

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** What a page with no located words shows: the padded, full-width band of the row where the model's guess put it. */
export function stripe(page: Page, id: string): Place {
  const band = page.bands?.[elementOf(id)];
  if (!band) return { box: [0, 0, 1, 1], approx: true };
  const pad = (band[1] - band[0]) / 2;
  return { box: [0, Math.max(0, band[0] - pad), 1, Math.min(1, band[1] + pad)], approx: true };
}

/** The row's real box, else the band between its found neighbours, else the stripe; always approximate. */
function around(page: Page, id: string): Place {
  const element = elementOf(id);
  const box = page.located?.rows[element] ?? page.located?.bands[element];
  return box ? { box, approx: true } : stripe(page, id);
}

const union = (boxes: Region[]): Region => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];

/** The boxes of words [from, from + count) of a cell, when every one that carries a letter or digit was found. */
function wordBoxes(page: Page, cell: ScanCell, from: number, count: number): Region[] | null {
  const found = page.located?.words[cell.id];
  if (!found) return null;
  const parts = wordsOf(cell.text);
  const boxes: Region[] = [];
  for (let i = from; i < from + count; i++) {
    if (!looseKey(parts[i] ?? "")) continue;
    const box = found[i];
    if (!box) return null;
    boxes.push(box);
  }
  return boxes.length ? boxes : null;
}

/** Where a whole cell or line is: its own words when all were found, else around it. */
export function cellPlace(page: Page, cell: ScanCell): Place {
  const boxes = wordBoxes(page, cell, 0, wordsOf(cell.text).length);
  return boxes ? { box: union(boxes) } : around(page, cell.id);
}

/**
 * Where one amount printed in a cell or line is: the amount's own words when found, else around its row. `occurrence` says
 * which copy, for an amount printed twice in one cell.
 */
export function amountPlace(page: Page, cell: ScanCell, text: string, occurrence: number): Place {
  const parts = wordsOf(cell.text);
  const amount = wordsOf(text);
  const at = parts.flatMap((_, i) => (amount.length && amount.every((a, k) => parts[i + k] === a) ? [i] : []))[occurrence];
  const boxes = at === undefined ? null : wordBoxes(page, cell, at, amount.length);
  return boxes ? { box: union(boxes) } : around(page, cell.id);
}

/** One box per printed line: a word joins the line before it when its centre is within half its height of that line's first word's. */
function perLine(boxes: Region[]): Region[] {
  const lines: Region[][] = [];
  for (const b of boxes) {
    const line = lines.at(-1);
    if (line && Math.abs((b[1] + b[3]) / 2 - (line[0]![1] + line[0]![3]) / 2) <= (b[3] - b[1]) / 2) line.push(b);
    else lines.push([b]);
  }
  return lines.map(union);
}

/**
 * Where a quote is on a located scan: one tight box per printed line when every word of it was found, and around the row of
 * any line where one wasn't. null when the page isn't located or the quote isn't in its cells, so the caller's own way applies.
 */
export function quoteSpots(page: Page, quote: string): { boxes: Region[]; approx?: true } | null {
  if (!page.located || !page.cells) return null;
  const words = page.cells.flatMap((cell) => wordsOf(cell.text).map((text, index) => ({ cell, index, text })));
  const hit = looseFind(words.map((w) => w.text), quote);
  if (!hit) return null;
  const groups: (typeof words)[] = [];
  for (const w of words.slice(hit[0], hit[1] + 1).filter((w) => looseKey(w.text))) {
    const group = groups.at(-1);
    if (group && elementOf(group[0]!.cell.id) === elementOf(w.cell.id)) group.push(w);
    else groups.push([w]);
  }
  const boxes: Region[] = [];
  let approx = false;
  for (const group of groups) {
    const found = group.map((w) => page.located!.words[w.cell.id]?.[w.index] ?? null);
    if (found.every((b) => b)) boxes.push(...perLine(found as Region[]));
    else {
      approx = true;
      const box = around(page, group[0]!.cell.id).box;
      if (!boxes.some((b) => b.every((v, i) => v === box[i]))) boxes.push(box);
    }
  }
  return { boxes, ...(approx && { approx: true as const }) };
}
