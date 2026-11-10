import { parseCents } from "@dct/shared";
import { amountsAt } from "../checks/text";
import { isBankHeading, maskBankDetails } from "../pdf/lines";
import type { Doubt, Word } from "../types";
import { DOUBTS, type Field, type Transcription } from "./transcribe";
import { hide } from "./words";

/**
 * What a scanned cell or line prints, the one reading of it every check shares: each amount-shaped figure, or the one bare
 * number it is ("1500") when it prints nothing else.
 */
export const amountsOf = (text: string) => {
  const found = amountsAt(text).map((a) => a.cents);
  const bare = parseCents(text);
  return found.length || bare === null ? found : [bare];
};

/** The one amount a cell prints, words beside it allowed ("$260.00 per visit"); null when it prints none or several. */
export const centsOf = (text: string) => {
  const found = amountsOf(text);
  return found.length === 1 ? found[0]! : null;
};

/** One cell, heading or line of a transcribed page, with an id derived from where it sits in the transcription. */
export interface ScanCell {
  id: string;
  page: number;
  table: number | null;
  row: number | null;
  col: number | null;
  text: string;
  doubts: Doubt[];
  heading?: string;
  rowLabel?: string;
  /** The parts of its text that are printed and struck out, such as a value a handwritten one replaces. */
  struck?: string[];
}

interface Laid {
  id: string;
  table: number | null;
  row: number | null;
  col: number | null;
  doubts: Doubt[];
  parts: { words: Word[]; doubts: Doubt[] }[];
}

const TAGS: Record<Doubt, string> = { handwritten: "{hw}", struck_out: "{x}", initialed: "{in}", unsure: "{?}" };
const doubtsOf = (f: Field): Doubt[] => [...f.marks, ...(f.unsure ? ["unsure" as const] : [])];
const plain = (text: string): Field => ({ text, unsure: false, marks: [] });
const textOf = (l: Laid) => l.parts.map((p) => p.words.map((w) => w.text).join(" ")).filter(Boolean).join(" ");
const shownOf = (l: Laid) => l.parts.map((p) => p.words.map((w) => w.text).join(" ") + p.doubts.map((d) => TAGS[d]).join("")).filter(Boolean).join(" ");

/** The page's titles, headings, rows and lines in reading order, one array per printed line, with bank details masked as on a text page. */
function laidOut(page: number, t: Transcription): Laid[][] {
  const lay = (id: string, table: number | null, row: number | null, col: number | null, f: Field, masked = false): Laid => ({
    id, table, row, col, doubts: doubtsOf(f),
    parts: (f.parts ?? [f]).map((p) => ({ doubts: doubtsOf(p), words: p.text.split(/\s+/).filter(Boolean).map((w) => ({ text: masked ? hide(w) : w, x0: 0, y0: 0, x1: 0, y1: 0 })) })),
  });
  const blocks: { top: number; lines: Laid[][] }[] = t.lines.map((l, i) => ({ top: l.top, lines: [[lay(`p${page}.l${i + 1}`, null, null, null, l)]] }));
  t.tables.forEach((table, i) => {
    const n = i + 1;
    const id = `p${page}.t${n}`;
    // a bank column's cells are hidden by their heading, since nothing in a cell says what it is
    const bank = table.columns.map(isBankHeading);
    const lines = [[lay(`${id}.title`, n, null, null, plain(table.title))]];
    if (table.columns.some(Boolean)) lines.push(table.columns.map((h, c) => lay(`${id}.h${c}`, n, null, c, plain(h))));
    table.rows.forEach((r, j) => lines.push([plain(r.label), ...r.cells].map((f, c) => lay(`${id}.r${j + 1}.c${c}`, n, j + 1, c, f, bank[c]))));
    blocks.push({ top: table.top, lines });
  });
  const lines = blocks.sort((a, b) => a.top - b.top).flatMap((b) => b.lines);
  maskBankDetails(lines.map((line) => line.flatMap((l) => l.parts.flatMap((p) => p.words))));
  return lines;
}

const isTitle = (l: Laid) => l.table !== null && l.col === null;

/**
 * Every heading, cell (c0 is the row label) and line of a page: `p{page}.t{table}.h{col}`, `p{page}.t{table}.r{row}.c{col}`
 * and `p{page}.l{line}`, counted from 1 except columns, and each table's title, `p{page}.t{table}.title`, which is read
 * like a line. Derived on load, so a saved transcription always gets the same ids.
 */
export function cellsOf(page: number, t: Transcription): ScanCell[] {
  const headings = new Map<string, string>();
  return laidOut(page, t).flatMap((line) =>
    line.flatMap((l): ScanCell[] => {
      if (isTitle(l)) return textOf(l) ? [{ id: l.id, page, table: null, row: null, col: null, text: textOf(l), doubts: l.doubts }] : [];
      const struck = l.parts.filter((p) => p.doubts.includes("struck_out")).map((p) => p.words.map((w) => w.text).join(" "));
      const cell: ScanCell = { id: l.id, page, table: l.table, row: l.row, col: l.col, text: textOf(l), doubts: l.doubts, ...(struck.length > 0 && { struck }) };
      if (l.row === null) {
        if (l.table !== null) headings.set(`${l.table}.${l.col}`, cell.text);
        return [cell];
      }
      const heading = headings.get(`${l.table}.${l.col}`);
      return [{ ...cell, ...(heading !== undefined && { heading }), rowLabel: textOf(line[0]!) }];
    }),
  );
}

/** What the agent reads for a scanned page: each table with its ids and every column kept, blanks included, and each line with its id; doubts follow the value they apply to. */
export function scanText(page: number, t: Transcription): string {
  return laidOut(page, t)
    .map((line) => {
      const first = line[0]!;
      if (isTitle(first)) return `TABLE ${first.id.replace(/\.title$/, "")} ${JSON.stringify(textOf(first))}`;
      if (first.table === null) return `${first.id} | ${shownOf(first)}`;
      if (first.row === null) return `p${page}.t${first.table}.h | ${line.map((l) => `c${l.col} ${shownOf(l)}`).join(" | ")}`;
      return `p${page}.t${first.table}.r${first.row} | ${line.map(shownOf).join(" | ")}`;
    })
    .join("\n");
}

const HEADINGS = /^p\d+\.t\d+\.h \|/;

/** scanText as printed: without its ids, column numbers, doubt marks and separators. */
export const printedText = (text: string) =>
  text
    .split("\n")
    .map((l) => (HEADINGS.test(l) ? l.replace(/(?<=\| )c\d+\b/g, "") : l).replace(/^(?:TABLE )?p\d+\.\S+/, "").replace(DOUBTS, "").replaceAll("|", " "))
    .join("\n");
