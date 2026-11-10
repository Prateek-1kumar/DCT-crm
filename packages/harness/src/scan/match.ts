import { createHash } from "node:crypto";
import type { Region } from "@dct/shared";
import { looseCents, looseKey, slipped } from "../checks/text";
import type { Located } from "../types";
import { cellsOf } from "./cells";
import type { OcrWord } from "./detect";
import type { Transcription } from "./transcribe";
import { bandsOf } from "./words";

/**
 * Where the vision model's transcribed lines, rows and words really sit on the page, found by lining its words up with the
 * words OCR located (§5.1). OCR's own text is only ever compared, never used: nothing here can change a value. A mark is
 * never confidently wrong: a word is placed only when it lines up one way and no other, otherwise the spot is left
 * approximate.
 */

/** The line or row a cell belongs to: "p7.t1.r5.c3" is on "p7.t1.r5", a heading cell on "p7.t1.h"; a line and a title are their own. */
export const elementOf = (id: string) => id.replace(/\.c\d+$/, "").replace(/\.h\d+$/, ".h");

// an element is placed when words carrying at least this many of its letters and digits, and this share of them, lined up: one
// long word is enough, a repeat OCR missed copies of doesn't unplace its row, and a lone "a" is not
const MIN_WEIGHT = 6;
const MIN_SHARE = 0.25;
// a word that lines up one way beats every other way it could by this share of its own weight, or it is left unplaced
const CLEAR = 0.8;
const MAX_WEIGHT = 12;
// what a near miss (a letter or two misread) is worth against a word read exactly
const NEAR = 0.6;
// a line's words can't spread over more of the page than this and still be one line (a wrapped quote spans a few)
const MAX_SPAN = 0.1;
const PAD = 0.002;
// how far past the model's own guess a line with nothing placed around it is drawn
const GENEROUS = 0.03;
// how many found lines each side of one OCR didn't place bound its band
const NEIGHBOURS = 2;
// two elements with the same words closer than this by the model's guesses can't be told apart by the order it gave them: a
// guess a line off swaps them, and nothing on the page says which is which
const TWINS = 0.04;
// the model's guess of where a line sits breaks only ties between equally good ways to line up; it is often a row off
const PRIOR = 0.05;
const PRIOR_RANGE = 0.15;
// beyond this many words times words the lining up isn't tried, and the page stays approximate
const MAX_CELLS = 2.5e7;

interface Token {
  cell: string;
  index: number;
  element: string;
  key: string;
  weight: number;
  /** Digits can't be near misses: an amount is found only if its own digits were. */
  exactOnly: boolean;
  /** Set on a word that is an amount ("$1,500.00", "200.00"), never on a label like "V1" or a bare number: what OCR may have set a stray letter against. */
  amount?: { digits: string; tail: string };
  guess: number;
}

interface Reading {
  /** The height of a typical printed line. */
  height: number;
  words: OcrWord[];
  /** Top and bottom of the printed line each word sits on, which is wider than the word. */
  band: [number, number][];
  /** Which printed line each word sits on, counted from the top. */
  line: number[];
}

const centreY = (b: Region) => (b[1] + b[3]) / 2;

/**
 * OCR's words in reading order, line by line: OCR's lines that overlap vertically are one printed line (a table row it cut
 * into pieces), and a line's words go left to right.
 */
function readingOrder(ocr: OcrWord[]): Reading {
  const lines = new Map<number, OcrWord[]>();
  for (const w of ocr) lines.set(w.line, [...(lines.get(w.line) ?? []), w]);
  const boxes = [...lines.values()].map((words) => ({ words, y0: Math.min(...words.map((w) => w.box[1])), y1: Math.max(...words.map((w) => w.box[3])) }));
  boxes.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const bands: { words: OcrWord[]; y0: number; y1: number; height: number }[] = [];
  for (const line of boxes) {
    const height = line.y1 - line.y0;
    const same = [...bands].reverse().find((b) => Math.min(line.y1, b.y1) - Math.max(line.y0, b.y0) >= 0.5 * Math.min(height, b.height));
    if (same) {
      same.words.push(...line.words);
      same.y0 = Math.min(same.y0, line.y0);
      same.y1 = Math.max(same.y1, line.y1);
    } else bands.push({ ...line, height, words: [...line.words] });
  }
  bands.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const words: OcrWord[] = [];
  const band: Reading["band"] = [];
  const line: number[] = [];
  bands.forEach((b, n) => {
    for (const w of b.words.sort((p, q) => p.box[0] - q.box[0])) {
      words.push(w);
      band.push([b.y0, b.y1]);
      line.push(n);
    }
  });
  const heights = bands.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  return { height: heights[Math.floor(heights.length / 2)] ?? 0, words, band, line };
}

/** Edit distance up to `max`, or max + 1 when it is more. */
function distance(a: string, b: string, max: number): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    if (Math.min(...next) > max) return max + 1;
    row = next;
  }
  return row[b.length]!;
}

// A misread currency sign or a speck glued to an amount ("S1,500.00", "£1,500.00") changes its key but not its digits.
const MIN_DIGITS = 3;
const EXTRAS = 2;
/** The two digits after a last decimal mark, so "500.00" and "50,000", which share their digits, stay apart. */
const tail = (text: string) => /[.,](\d{2})\D*$/.exec(slipped(text))?.[1] ?? "";
/** The OCR words that carry digits with up to two letters or symbols besides, by their digits. */
function byDigits(words: OcrWord[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  words.forEach((w, at) => {
    const digits = w.text.replace(/\D/g, "");
    if (digits.length >= MIN_DIGITS && w.text.replace(/[\d$,.()\-\s]/g, "").length <= EXTRAS) out.set(digits, [...(out.get(digits) ?? []), at]);
  });
  return out;
}

const slips = (key: string) => (key.length >= 10 ? 2 : key.length >= 5 ? 1 : 0);

/** The words a token could be: the same letters and digits, or for a word of letters one or two characters off. */
function candidates(token: Token, keys: string[], exact: Map<string, number[]>, digits: Map<string, number[]>, texts: string[]): { at: number; score: number }[] {
  // an amount also stands on its digits alone: the same digits and cents, whatever else OCR glued to them
  // (and the cents must agree: "$500.00" is not "$50,000", though they share their digits and so their key)
  const same = [...new Set([...(exact.get(token.key) ?? []), ...(token.amount ? (digits.get(token.amount.digits) ?? []) : [])])].filter((at) => !token.amount || tail(texts[at]!) === token.amount.tail);
  if (same.length) return same.map((at) => ({ at, score: token.weight }));
  const allowed = token.exactOnly ? 0 : slips(token.key);
  if (!allowed) return [];
  const out: { at: number; score: number }[] = [];
  keys.forEach((k, at) => {
    if (Math.abs(k.length - token.key.length) > allowed || (k[0] !== token.key[0] && k.at(-1) !== token.key.at(-1))) return;
    if (distance(token.key, k, allowed) <= allowed) out.push({ at, score: token.weight * NEAR });
  });
  return out;
}

const bounds = (boxes: Region[]): Region => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];

/**
 * Lines the transcription up with OCR's words as one sequence against another, so a repeated amount is told apart by what
 * surrounds it and by order. A word is placed when the best way to line the two up puts it on one OCR word and every other
 * way is clearly worse; two equally good ways (a repeat OCR missed one of) place neither.
 */
function place(tokens: Token[], reading: Reading): (number | null)[] {
  const n = tokens.length;
  const m = reading.words.length;
  const none = tokens.map(() => null);
  if (!n || !m || n * m > MAX_CELLS) return none;
  const keys = reading.words.map((w) => looseKey(w.text));
  const exact = new Map<string, number[]>();
  keys.forEach((k, at) => k && exact.set(k, [...(exact.get(k) ?? []), at]));
  const digits = byDigits(reading.words);
  const texts = reading.words.map((w) => w.text);
  const options = tokens.map((t) => candidates(t, keys, exact, digits, texts).map(({ at, score }) => ({ at, score: score + PRIOR * Math.max(0, 1 - Math.abs(t.guess - centreY(reading.words[at]!.box)) / PRIOR_RANGE) })));

  const w = m + 2;
  const F = new Float32Array((n + 2) * w);
  const B = new Float32Array((n + 2) * w);
  const row = new Float32Array(w);
  const score = (i: number) => {
    row.fill(0);
    for (const o of options[i - 1]!) row[o.at + 1] = o.score;
    return row;
  };
  // F: best total for the first i tokens against the first j words; B: the same for the rest
  for (let i = 1; i <= n; i++) {
    const s = score(i);
    for (let j = 1; j <= m; j++) F[i * w + j] = Math.max(F[(i - 1) * w + j]!, F[i * w + j - 1]!, s[j]! > 0 ? F[(i - 1) * w + j - 1]! + s[j]! : 0);
  }
  for (let i = n; i >= 1; i--) {
    const s = score(i);
    for (let j = m; j >= 1; j--) B[i * w + j] = Math.max(B[(i + 1) * w + j]!, B[i * w + j + 1]!, s[j]! > 0 ? B[(i + 1) * w + j + 1]! + s[j]! : 0);
  }
  const total = F[n * w + m]!;

  return tokens.map((_, k) => {
    const i = k + 1;
    const forced = options[k]!.map((o) => ({ at: o.at, score: o.score, total: F[(i - 1) * w + o.at]! + o.score + B[(i + 1) * w + o.at + 2]! }));
    if (!forced.length) return null;
    const best = forced.reduce((a, b) => (b.total > a.total ? b : a));
    // not in any best way of lining up, so something else explains the words around it
    if (best.total < total - 1e-3) return null;
    let rival = -Infinity;
    for (let j = 0; j <= m; j++) rival = Math.max(rival, F[(i - 1) * w + j]! + B[(i + 1) * w + j + 1]!);
    for (const f of forced) if (f !== best) rival = Math.max(rival, f.total);
    return best.total - rival >= CLEAR * best.score ? best.at : null;
  });
}

const memo = new Map<string, Located>();
const MEMO = 200;

/**
 * Real positions for a transcription's lines, rows and words, from the words OCR found on the same picture. Pure and
 * deterministic, and kept by content, so loading a contract again doesn't redo it.
 */
export function locate(page: number, t: Transcription, ocr: OcrWord[]): Located {
  const key = createHash("sha1").update(JSON.stringify([page, t, ocr])).digest("hex");
  const known = memo.get(key);
  if (known) return known;
  const found = locateNow(page, t, ocr);
  memo.set(key, found);
  if (memo.size > MEMO) memo.delete(memo.keys().next().value!);
  return found;
}

function locateNow(page: number, t: Transcription, ocr: OcrWord[]): Located {
  const guesses = new Map([...bandsOf(t)].map(([k, [y0, y1]]) => [`p${page}.${k}`, [y0, y1] as const]));
  const guessOf = (element: string): readonly [number, number] => guesses.get(element) ?? guesses.get(element.replace(/\.title$/, "")) ?? [0, 1];

  const cells = cellsOf(page, t);
  const elements: string[] = [];
  const words: Located["words"] = {};
  const tokens: Token[] = [];
  for (const cell of cells) {
    const element = elementOf(cell.id);
    if (!elements.includes(element)) elements.push(element);
    const parts = cell.text.split(/\s+/).filter(Boolean);
    words[cell.id] = parts.map(() => null);
    const [g0, g1] = guessOf(element);
    parts.forEach((part, index) => {
      const key = looseKey(part);
      const amount = looseCents(part) !== null && /^\d{3,}$/.test(key) ? { digits: key, tail: tail(part) } : undefined;
      if (key) tokens.push({ cell: cell.id, index, element, key, weight: Math.min(key.length, MAX_WEIGHT), exactOnly: /\d/.test(key), ...(amount && { amount }), guess: (g0 + g1) / 2 });
    });
  }

  const reading = readingOrder(ocr);
  const at = place(tokens, reading);

  // what each printed line holds and what each element holds, as counts of letters-and-digits words
  const held = new Map<number, Map<string, number>>();
  reading.words.forEach((w, j) => {
    const key = looseKey(w.text);
    const counts = held.get(reading.line[j]!) ?? new Map<string, number>();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    held.set(reading.line[j]!, counts);
  });
  const wanted = new Map<string, Map<string, number>>();
  for (const tk of tokens) {
    const counts = wanted.get(tk.element) ?? new Map<string, number>();
    counts.set(tk.key, (counts.get(tk.key) ?? 0) + 1);
    wanted.set(tk.element, counts);
  }
  /** The weight of the element's words a printed line holds, ignoring order. */
  const holds = (element: string, line: number) => [...wanted.get(element)!].reduce((sum, [key, n]) => sum + Math.min(n, held.get(line)?.get(key) ?? 0) * Math.min(key.length, MAX_WEIGHT), 0);

  const signature = new Map<string, string>();
  for (const tk of tokens) signature.set(tk.element, `${signature.get(tk.element) ?? ""} ${tk.key}`);
  const centre = (element: string) => (guessOf(element)[0] + guessOf(element)[1]) / 2;
  const twins = (element: string) => elements.some((other) => other !== element && signature.get(other) === signature.get(element) && Math.abs(centre(other) - centre(element)) < TWINS);

  const rows: Located["rows"] = {};
  const bands: Located["bands"] = {};
  // the printed line each placed row sits on, and the words already given to a token
  const home = new Map<string, number>();
  const taken = new Set<number>();
  const total = new Map<string, number>();
  for (const tk of tokens) total.set(tk.element, (total.get(tk.element) ?? 0) + tk.weight);
  for (const element of elements) {
    if (twins(element)) continue;
    const mine = tokens.flatMap((tk, i) => (tk.element === element && at[i] !== null ? [{ tk, word: at[i]! }] : []));
    const weight = mine.reduce((sum, { tk }) => sum + tk.weight, 0);
    if (weight < MIN_WEIGHT || weight / (total.get(element) || Infinity) < MIN_SHARE) continue;
    const lines = bounds(mine.map(({ word }) => [0, reading.band[word]![0], 1, reading.band[word]![1]]));
    if (lines[3] - lines[1] > MAX_SPAN) continue;
    // The order the model gave can be wrong (it is read from its guesses of position), so two rows that differ in one
    // character, swapped, line up crosswise. A row is placed only if no other printed line holds more of its words.
    const byLine = new Map<number, number>();
    for (const { tk, word } of mine) byLine.set(reading.line[word]!, (byLine.get(reading.line[word]!) ?? 0) + tk.weight);
    const [line, found] = [...byLine].reduce((a, b) => (b[1] > a[1] ? b : a));
    if ([...held.keys()].some((other) => other !== line && holds(element, other) > Math.max(found, holds(element, line)))) continue;
    rows[element] = [0, Math.max(0, lines[1] - PAD), 1, Math.min(1, lines[3] + PAD)];
    home.set(element, line);
    for (const { tk, word } of mine) {
      words[tk.cell]![tk.index] = reading.words[word]!.box;
      taken.add(word);
    }
  }

  // Why a second pass inside the row: once a row is on its printed line, the words left on that line can only be its own, so
  // a repeat the first pass couldn't order (three $50.00 cells, OCR found them all) is settled by column order, left to
  // right, provided the count of its unplaced copies equals the count of free words. Any other count stays approximate.
  const digits = byDigits(reading.words);
  /** Whether OCR word `j` is the token's words: the same key or, for an amount, its digits, and then the same cents. */
  const fits = (tk: Token, j: number) => {
    const text = reading.words[j]!.text;
    if (!tk.amount) return looseKey(text) === tk.key;
    return tail(text) === tk.amount.tail && (looseKey(text) === tk.key || !!digits.get(tk.amount.digits)?.includes(j));
  };
  const unplaced = (element: string) => tokens.filter((tk) => tk.element === element && words[tk.cell]![tk.index] === null);
  for (const [element, line] of home) {
    const left = unplaced(element);
    const group = (tk: Token) => `${tk.key}|${tk.amount?.tail ?? ""}`;
    for (const id of new Set(left.map(group))) {
      const mine = left.filter((tk) => group(tk) === id);
      const free = reading.words.flatMap((_, j) => (reading.line[j] === line && !taken.has(j) && fits(mine[0]!, j) ? [j] : []));
      if (mine.length !== free.length) continue;
      mine.forEach((tk, n) => {
        words[tk.cell]![tk.index] = reading.words[free[n]!]!.box;
        taken.add(free[n]!);
      });
    }
  }

  // an element not placed lies between the nearest placed ones above and below it, in the order the page is read
  elements.forEach((element, i) => {
    if (rows[element]) return;
    // the order the page is read in comes from the model's own guesses, which can put a line one off, so the last two
    // found above and the next two below set the band
    const above = elements.slice(0, i).reverse().filter((e) => rows[e]).slice(0, NEIGHBOURS);
    const below = elements.slice(i + 1).filter((e) => rows[e]).slice(0, NEIGHBOURS);
    const [g0, g1] = guessOf(element);
    // with neither, today's stripe padded generously; with one, the page's edge on the other side. A line reaches into its
    // neighbours by a line's height: OCR may have found its words and set them in a neighbour's row.
    let top = above.length ? Math.max(0, Math.min(...above.map((e) => rows[e]![3])) - reading.height) : below.length ? 0 : Math.max(0, g0 - GENEROUS);
    let bottom = below.length ? Math.min(1, Math.max(...below.map((e) => rows[e]![1])) + reading.height) : above.length ? 1 : Math.min(1, g1 + GENEROUS);
    if (top > bottom) [top, bottom] = [bottom, top];
    bands[element] = [0, top, 1, bottom];
  });

  // Why an amount can stand on its own in a band: an element OCR couldn't place may still print an amount whose digits sit
  // once, free, inside its band and off every placed row's line, with no other unplaced element near it wanting them. The
  // element stays unplaced, so its row and quote boxes remain the band; only that amount's word gets its box.
  const homeLines = new Set(home.values());
  const lost = elements.filter((e) => !rows[e]);
  const wants = (element: string) => unplaced(element).filter((tk) => tk.amount);
  const overlap = (a: Region, b: Region) => a[1] < b[3] && b[1] < a[3];
  const spots = new Map<string, number>();
  for (const element of lost) {
    for (const tk of wants(element)) {
      const near = reading.words.flatMap((w, j) =>
        !taken.has(j) && !homeLines.has(reading.line[j]!) && centreY(w.box) >= bands[element]![1] && centreY(w.box) <= bands[element]![3] && fits(tk, j) ? [j] : [],
      );
      const rivals = lost.some((other) => other !== element && overlap(bands[other]!, bands[element]!) && wants(other).some((o) => o.amount!.digits === tk.amount!.digits && o.amount!.tail === tk.amount!.tail));
      if (near.length === 1 && !rivals && wants(element).filter((o) => o.amount!.digits === tk.amount!.digits && o.amount!.tail === tk.amount!.tail).length === 1) spots.set(`${tk.cell}#${tk.index}`, near[0]!);
    }
  }
  // two elements may not claim one word
  const claimed = [...spots.values()];
  for (const [id, j] of spots) {
    if (claimed.filter((c) => c === j).length > 1) continue;
    const [cell, index] = id.split("#") as [string, string];
    words[cell]![Number(index)] = reading.words[j]!.box;
  }
  return { rows, bands, words };
}
