import { isAmount, isBankHeading, median } from "../pdf/lines";
import type { Doubt, Word } from "../types";
import type { Transcription } from "./transcribe";

const CHAR = 1 / 120;
const LEFT = 0.05;
const SLOT_GAP = 2;
const PAGE_CHARS = Math.floor((1 - 2 * LEFT) / CHAR);
const MIN_HEIGHT = 0.002;
const SAME_CENTRE = 1e-6;
// groupLines joins centres closer than half a word's height. A nudge just over that splits two elements at one centre, and
// a height of at most 1/1.1 of the closest rows leaves room for a nudged element and the next row both to stay apart.
const NUDGE = 0.55;
const ROOM = 1.1;

interface Element {
  centre: number;
  /** Words with the character column each starts at. */
  words: { text: string; column: number; doubt?: Doubt }[];
}

type Doubtful = { unsure: boolean; marks: Doubt[] };
const doubtOf = ({ unsure, marks }: Doubtful): Doubt | undefined => marks[0] ?? (unsure ? "unsure" : undefined);

const hide = (word: string) => (isAmount(word) ? word : word.replace(/[A-Za-z0-9]/g, "#"));

function place(text: string, column: number, doubt: Doubt | undefined, into: Element["words"], masked = false) {
  const last = into.at(-1);
  let at = Math.max(column, last ? last.column + last.text.length + 1 : 0);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    into.push({ text: masked ? hide(word) : word, column: at, doubt });
    at += word.length + 1;
  }
}

const centreOf = (e: { top: number; bottom: number }) => (e.top + e.bottom) / 2;

function elementsOf(t: Transcription, height: number): Element[] {
  const lines = t.lines.map((l) => {
    const words: Element["words"] = [];
    place(l.text, 0, doubtOf(l), words);
    return { centre: centreOf(l), words };
  });
  const tables = t.tables.flatMap((table) => {
    const slots = Math.max(table.columns.length, ...table.rows.map((r) => r.cells.length + 1));
    const texts = [...table.columns, ...table.rows.flatMap((r) => [r.label, ...r.cells.map((c) => c.text)])];
    const slotWidth = Math.min(Math.max(0, ...texts.map((s) => s.length)) + SLOT_GAP, Math.floor(PAGE_CHARS / slots));
    // a bank column's cells are hidden by their heading, since nothing in a cell says what it is
    const bank = table.columns.map(isBankHeading);
    const out: Element[] = [];
    const first = Math.min(table.top, ...table.rows.map(centreOf));
    const headerCentre = first - height;
    if (table.title.trim()) {
      const words: Element["words"] = [];
      place(table.title, 0, undefined, words);
      out.push({ centre: Math.min(table.top, headerCentre - height), words });
    }
    if (table.rows.length) {
      const words: Element["words"] = [];
      table.columns.forEach((c, i) => place(c, i * slotWidth, undefined, words));
      out.push({ centre: headerCentre, words });
    }
    for (const r of table.rows) {
      const words: Element["words"] = [];
      place(r.label, 0, undefined, words, bank[0]);
      r.cells.forEach((c, i) => place(c.text, (i + 1) * slotWidth, doubtOf(c), words, bank[i + 1]));
      out.push({ centre: centreOf(r), words });
    }
    return out;
  });
  return [...lines, ...tables];
}

/**
 * The transcription as positioned words: lines, then each table's title, column headings and rows. Horizontal positions
 * are made up, from a fixed character width, with a table row's label and cells in equal slots so a blank cell keeps its
 * column. Every element is centred where the model reported it and gets the same height, small enough that rows printed
 * close together stay apart. Only an element that would land on or too near the one before it is moved down, by just
 * enough to stay its own line, so a dense table's rows don't drift down the page.
 */
export function toWords(t: Transcription): Word[] {
  const reported = [...t.lines, ...t.tables.flatMap((table) => table.rows)];
  const centres = reported.map(centreOf).sort((a, b) => a - b);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!).filter((g) => g > SAME_CENTRE);
  const height = Math.max(Math.min(median(reported.map((e) => e.bottom - e.top)), ...gaps.map((g) => g / ROOM)), MIN_HEIGHT);
  let previous = -Infinity;
  return elementsOf(t, height)
    .sort((a, b) => a.centre - b.centre)
    .flatMap((e) => {
      const centre = Math.min(Math.max(e.centre, height / 2, previous + NUDGE * height), 1 - height / 2);
      previous = centre;
      return e.words.map((w) => ({
        text: w.text,
        x0: LEFT + w.column * CHAR,
        x1: LEFT + (w.column + w.text.length) * CHAR,
        y0: centre - height / 2,
        y1: centre + height / 2,
        ...(w.doubt && { doubt: w.doubt }),
      }));
    });
}
