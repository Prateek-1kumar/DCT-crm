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
  /** The id of the line or row it shows, without the page: "l2", "t1" (a title), "t1.h" (headings), "t1.r5". */
  key: string;
  centre: number;
  /** Words with the character column each starts at. */
  words: { text: string; column: number; doubt?: Doubt }[];
}

type Doubtful = { unsure: boolean; marks: Doubt[] };
type Piece = Doubtful & { text: string };
const doubtOf = ({ unsure, marks }: Doubtful): Doubt | undefined => marks[0] ?? (unsure ? "unsure" : undefined);

export const hide = (word: string) => (isAmount(word) ? word : word.replace(/[A-Za-z0-9]/g, "#"));

function place(text: string, column: number, doubt: Doubt | undefined, into: Element["words"], masked = false) {
  const last = into.at(-1);
  let at = Math.max(column, last ? last.column + last.text.length + 1 : 0);
  for (const word of text.split(/\s+/).filter(Boolean)) {
    into.push({ text: masked ? hide(word) : word, column: at, doubt });
    at += word.length + 1;
  }
}

/** A field that holds several values, each with its own doubt, places each one's words with its own. */
function placeField(f: Piece & { parts?: Piece[] }, column: number, into: Element["words"], masked = false) {
  for (const part of f.parts ?? [f]) place(part.text, column, doubtOf(part), into, masked);
}

const centreOf = (e: { top: number; bottom: number }) => (e.top + e.bottom) / 2;

function elementsOf(t: Transcription, height: number): Element[] {
  const lines = t.lines.map((l, i) => {
    const words: Element["words"] = [];
    placeField(l, 0, words);
    return { key: `l${i + 1}`, centre: centreOf(l), words };
  });
  const tables = t.tables.flatMap((table, i) => {
    const key = `t${i + 1}`;
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
      out.push({ key, centre: Math.min(table.top, headerCentre - height), words });
    }
    if (table.rows.length) {
      const words: Element["words"] = [];
      table.columns.forEach((c, i) => place(c, i * slotWidth, undefined, words));
      out.push({ key: `${key}.h`, centre: headerCentre, words });
    }
    table.rows.forEach((r, j) => {
      const words: Element["words"] = [];
      place(r.label, 0, undefined, words, bank[0]);
      r.cells.forEach((c, k) => placeField(c, (k + 1) * slotWidth, words, bank[k + 1]));
      out.push({ key: `${key}.r${j + 1}`, centre: centreOf(r), words });
    });
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
export const toWords = (t: Transcription): Word[] =>
  placed(t).flatMap(({ words, y0, y1 }) =>
    words.map((w) => ({ text: w.text, x0: LEFT + w.column * CHAR, x1: LEFT + (w.column + w.text.length) * CHAR, y0, y1, ...(w.doubt && { doubt: w.doubt }) })),
  );

/** Where toWords puts each line and row, top and bottom, by its key ("l2", "t1.r5"): for display only. */
export const bandsOf = (t: Transcription) => new Map(placed(t).map((e): [string, [number, number]] => [e.key, [e.y0, e.y1]]));

function placed(t: Transcription): (Element & { y0: number; y1: number })[] {
  const reported = [...t.lines, ...t.tables.flatMap((table) => table.rows)];
  const centres = reported.map(centreOf).sort((a, b) => a - b);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!).filter((g) => g > SAME_CENTRE);
  const height = Math.max(Math.min(median(reported.map((e) => e.bottom - e.top)), ...gaps.map((g) => g / ROOM)), MIN_HEIGHT);
  let previous = -Infinity;
  return elementsOf(t, height)
    .sort((a, b) => a.centre - b.centre)
    .map((e) => {
      const centre = Math.min(Math.max(e.centre, height / 2, previous + NUDGE * height), 1 - height / 2);
      previous = centre;
      return { ...e, y0: centre - height / 2, y1: centre + height / 2 };
    });
}
