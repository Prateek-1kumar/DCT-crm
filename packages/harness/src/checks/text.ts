import { parseCents } from "@dct/shared";

// The bare form takes unseparated thousands ("1746.00"), which a printed budget often has; missing one is the unsafe error.
const AMOUNT = /(?:US\$|USD|\$)\s?\d[\d,]*(?:\.\d{2})?|\b(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\b/g;

export function amountsAt(text: string): { text: string; cents: number; start: number; end: number }[] {
  return [...text.matchAll(AMOUNT)].flatMap((m) => {
    const cents = parseCents(m[0]);
    return cents === null ? [] : [{ text: m[0], cents, start: m.index, end: m.index + m[0].length }];
  });
}

export const amountsIn = (text: string): number[] => amountsAt(text).map((a) => a.cents);

export function usd(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const SLIPS: Record<string, string> = { O: "0", o: "0", l: "1", I: "1", i: "1", "|": "1", S: "5", s: "5", B: "8" };
export const slipped = (s: string) => s.replace(/[OolIi|SsB]/g, (c) => SLIPS[c]!);
const DIGITS = String.raw`\dOolIi|SsB`;
const LOOSE_AMOUNT = new RegExp(String.raw`^(\(|[-−])?(US\$|USD|\$|S(?=\d))?([${DIGITS}][${DIGITS},.]*?)(?:[.,]([${DIGITS}]{2}))?\)?[.,;:]?$`);

/**
 * The cents an amount stands for as a transcription may have it: O/0, l/1/I, S/5, B/8 swapped, spaces inside the number,
 * and a comma or period missing, extra or swapped. A bare number counts only with cents ("1,2OO.OO"), as in a text
 * page. null when it isn't an amount.
 */
export function looseCents(text: string): number | null {
  const m = LOOSE_AMOUNT.exec(text.replace(/\s+/g, ""));
  if (!m || !/\d/.test(m[0]) || !(m[2] || m[4])) return null;
  const whole = slipped(m[3]!).replace(/\D/g, "");
  const cents = whole.length > 12 ? Number.NaN : Number(whole) * 100 + Number(slipped(m[4] ?? "00"));
  return Number.isSafeInteger(cents) ? (m[1] ? -cents : cents) : null;
}

/**
 * Amounts that may be printed in the words of one line, as word ranges. A number split by a space ("1 200.00")
 * is joined only when `wanted` says the joined amount is one the caller is looking for: otherwise "2 100.00" would hide
 * the $100.00 next to a quantity.
 */
export function looseAmounts(words: string[], wanted: (cents: number) => boolean): { cents: number; from: number; to: number }[] {
  const found: { cents: number; from: number; to: number }[] = [];
  for (let at = 0; at < words.length; ) {
    let hit: (typeof found)[number] | undefined;
    for (let len = Math.min(3, words.length - at); len >= 1 && !hit; len--) {
      const cents = looseCents(words.slice(at, at + len).join(""));
      if (cents !== null && (len === 1 || wanted(cents))) hit = { cents, from: at, to: at + len - 1 };
    }
    if (hit) found.push(hit);
    at = (hit?.to ?? at) + 1;
  }
  return found;
}

// letter/digit swaps fold together, and only letters and digits count, so a quote matches however the words split or punctuation sits
export const looseKey = (s: string) => slipped(normalise(s)).replace(/[^\p{L}\p{N}]/gu, "");
const QUOTE_SLIP_SHARE = 0.1;

/**
 * The first and last of the words a quote covers despite reading slips: the same confusions as an
 * amount, then at most a tenth of the quote's characters wrong. A match starts and ends on whole words, so letters it
 * leaves off a word count as wrong; the closest match wins, then the first. null when the quote isn't there.
 */
export function looseFind(words: string[], quote: string): [first: number, last: number] | null {
  const wanted = looseKey(quote);
  if (!wanted) return null;
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  let run = "";
  words.forEach((w, i) => {
    const key = looseKey(w);
    if (!key) return;
    starts.set(run.length, i);
    run += key;
    ends.set(run.length, i);
  });
  // edit distance of the quote against the page up to each offset, carrying where each alignment began
  let cost = Array.from({ length: wanted.length + 1 }, (_, j) => j);
  let from = cost.map(() => 0);
  let best: { cost: number; from: number; to: number } | undefined;
  for (let at = 1; at <= run.length; at++) {
    const fresh = starts.has(at);
    const row = [fresh ? 0 : cost[0]! + 1];
    const rowFrom = [fresh ? at : from[0]!];
    for (let j = 1; j <= wanted.length; j++) {
      let [c, f] = [cost[j - 1]! + (run[at - 1] === wanted[j - 1] ? 0 : 1), from[j - 1]!];
      if (cost[j]! + 1 < c) [c, f] = [cost[j]! + 1, from[j]!];
      if (row[j - 1]! + 1 < c) [c, f] = [row[j - 1]! + 1, rowFrom[j - 1]!];
      row.push(c);
      rowFrom.push(f);
    }
    cost = row;
    from = rowFrom;
    const found = cost[wanted.length]!;
    if (ends.has(at) && found <= Math.floor(wanted.length * QUOTE_SLIP_SHARE) && found < (best?.cost ?? Infinity)) best = { cost: found, from: from[wanted.length]!, to: at };
  }
  return best ? [starts.get(best.from)!, ends.get(best.to)!] : null;
}

export const looseContains = (pageText: string, quote: string) => looseFind(pageText.split(/\s+/), quote) !== null;
