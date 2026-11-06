import { isAmount, isBankHeading } from "../pdf/lines";
import type { Doubt, Word } from "../types";
import type { Transcription } from "./transcribe";

const CHAR = 1 / 120;
const LEFT = 0.05;
const SLOT_GAP = 2;
const PAGE_CHARS = Math.floor((1 - 2 * LEFT) / CHAR);
const MIN_HEIGHT = 0.002;

interface Element {
  top: number;
  /** Words with the character column each starts at. */
  words: { text: string; column: number; doubt?: Doubt }[];
}

type Doubtful = { unsure: boolean; marks: Doubt[] };
const doubtOf = ({ unsure, marks }: Doubtful): Doubt | undefined => marks[0] ?? (unsure ? "unsure" : undefined);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const hide = (word: string) => (isAmount(word) ? word : word.replace(/[A-Za-z0-9]/g, "#"));

function place(text: string, column: number, doubt: Doubt | undefined, into: Element["words"], masked = false) {
  const last = into.at(-1);
  let at = Math.max(column, last ? last.column + last.text.length + 1 : 0);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    into.push({ text: masked ? hide(word) : word, column: at, doubt });
    at += word.length + 1;
  }
}

function elementsOf(t: Transcription, height: number): Element[] {
  const lines = t.lines.map((l) => {
    const words: Element["words"] = [];
    place(l.text, 0, doubtOf(l), words);
    return { top: l.top, words };
  });
  const tables = t.tables.flatMap((table) => {
    const slots = Math.max(table.columns.length, ...table.rows.map((r) => r.cells.length + 1));
    const texts = [...table.columns, ...table.rows.flatMap((r) => [r.label, ...r.cells.map((c) => c.text)])];
    const slotWidth = Math.min(Math.max(0, ...texts.map((s) => s.length)) + SLOT_GAP, Math.floor(PAGE_CHARS / slots));
    // a bank column's cells are hidden by their heading, since nothing in a cell says what it is
    const bank = table.columns.map(isBankHeading);
    const out: Element[] = [];
    const first = Math.min(table.top, ...table.rows.map((r) => r.top));
    const headerTop = Math.max(0, first - height);
    if (table.title.trim()) {
      const words: Element["words"] = [];
      place(table.title, 0, undefined, words);
      out.push({ top: Math.max(0, Math.min(table.top, headerTop - height)), words });
    }
    if (table.rows.length) {
      const words: Element["words"] = [];
      table.columns.forEach((c, i) => place(c, i * slotWidth, undefined, words));
      out.push({ top: headerTop, words });
    }
    for (const r of table.rows) {
      const words: Element["words"] = [];
      place(r.label, 0, undefined, words, bank[0]);
      r.cells.forEach((c, i) => place(c.text, (i + 1) * slotWidth, doubtOf(c), words, bank[i + 1]));
      out.push({ top: r.top, words });
    }
    return out;
  });
  return [...lines, ...tables];
}

/**
 * The transcription as positioned words: lines, then each table's title, column headings and rows. Horizontal positions
 * are made up, from a fixed character width, with a table row's label and cells in equal slots so a blank cell keeps its
 * column. Every element gets the same height (the median reported one) and is pushed down past the one before it, so
 * two elements are never one line however their reported bands overlap or collapse.
 */
export function toWords(t: Transcription): Word[] {
  const reported = [...t.lines, ...t.tables.flatMap((table) => table.rows)].map((e) => e.bottom - e.top);
  const height = Math.max(median(reported), MIN_HEIGHT);
  let bottom = -Infinity;
  return elementsOf(t, height)
    .sort((a, b) => a.top - b.top)
    .flatMap((e) => {
      const top = Math.max(e.top, bottom);
      bottom = top + height;
      return e.words.map((w) => ({
        text: w.text,
        x0: LEFT + w.column * CHAR,
        x1: LEFT + (w.column + w.text.length) * CHAR,
        y0: top,
        y1: bottom,
        ...(w.doubt && { doubt: w.doubt }),
      }));
    });
}
