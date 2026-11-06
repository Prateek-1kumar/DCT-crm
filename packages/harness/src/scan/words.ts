import type { Doubt, Word } from "../types";
import type { Transcription } from "./transcribe";

const CHAR = 1 / 120;
const LEFT = 0.05;
const SLOT_GAP = 2;
const PAGE_CHARS = Math.floor((1 - 2 * LEFT) / CHAR);
// groupLines tolerates half a median height, so a zero-height band would merge with its neighbour
const MIN_BAND = 0.002;

interface Element {
  top: number;
  bottom: number;
  /** Words with the character column each starts at. */
  words: { text: string; column: number; doubt?: Doubt }[];
}

type Doubtful = { unsure: boolean; marks: Doubt[] };
const doubtOf = ({ unsure, marks }: Doubtful): Doubt | undefined => marks[0] ?? (unsure ? "unsure" : undefined);

function place(text: string, column: number, doubt: Doubt | undefined, into: Element["words"]) {
  const last = into.at(-1);
  let at = Math.max(column, last ? last.column + last.text.length + 1 : 0);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    into.push({ text: word, column: at, doubt });
    at += word.length + 1;
  }
}

function elementsOf(t: Transcription): Element[] {
  const lines = t.lines.map((l) => {
    const words: Element["words"] = [];
    place(l.text, 0, doubtOf(l), words);
    return { top: l.top, bottom: l.bottom, words };
  });
  const rows = t.tables.flatMap((table) => {
    const slots = Math.max(0, ...table.rows.map((r) => r.cells.length)) + 1;
    const widest = Math.max(0, ...table.rows.flatMap((r) => [r.label, ...r.cells.map((c) => c.text)]).map((s) => s.length));
    const slotWidth = Math.min(widest + SLOT_GAP, Math.floor(PAGE_CHARS / slots));
    return table.rows.map((r) => {
      const words: Element["words"] = [];
      place(r.label, 0, undefined, words);
      r.cells.forEach((c, i) => place(c.text, (i + 1) * slotWidth, doubtOf(c), words));
      return { top: r.top, bottom: r.bottom, words };
    });
  });
  return [...lines, ...rows];
}

/**
 * The transcription as positioned words. Horizontal positions are made up, from a fixed character width, with a table
 * row's label and cells in equal slots so a blank cell keeps its column. Vertical positions are the reported ones,
 * except that an element reported inside the previous one's band is moved just below it, so two elements are never one line.
 */
export function toWords(t: Transcription): Word[] {
  let previous: { top: number; bottom: number } | undefined;
  return elementsOf(t)
    .sort((a, b) => a.top - b.top)
    .flatMap((e) => {
      const height = Math.max(e.bottom - e.top, MIN_BAND);
      const top = previous && e.top + height / 2 <= previous.bottom ? previous.bottom : e.top;
      previous = { top, bottom: top + height };
      return e.words.map((w) => ({
        text: w.text,
        x0: LEFT + w.column * CHAR,
        x1: LEFT + (w.column + w.text.length) * CHAR,
        y0: top,
        y1: top + height,
        ...(w.doubt && { doubt: w.doubt }),
      }));
    });
}
