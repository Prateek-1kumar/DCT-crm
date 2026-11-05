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
const OCR_AMOUNT = new RegExp(String.raw`^(\(|[-−])?(US\$|USD|\$|S(?=\d))?([${DIGITS}][${DIGITS},.]*?)(?:[.,]([${DIGITS}]{2}))?\)?[.,;:]?$`);

/**
 * The cents an amount stands for as OCR may have printed it: O/0, l/1/I, S/5, B/8 swapped, spaces inside the number,
 * and a comma or period missing, extra or swapped. A bare number counts only with cents ("1,2OO.OO"), as in a text
 * page. null when it isn't an amount.
 */
export function ocrCents(text: string): number | null {
  const m = OCR_AMOUNT.exec(text.replace(/\s+/g, ""));
  if (!m || !/\d/.test(m[0]) || !(m[2] || m[4])) return null;
  const whole = slipped(m[3]!).replace(/\D/g, "");
  const cents = whole.length > 12 ? Number.NaN : Number(whole) * 100 + Number(slipped(m[4] ?? "00"));
  return Number.isSafeInteger(cents) ? (m[1] ? -cents : cents) : null;
}

/**
 * Amounts OCR may have read in the words of one printed line, as word ranges. A number split by a space ("1 200.00")
 * is joined only when `wanted` says the joined amount is one the caller is looking for: otherwise "2 100.00" would hide
 * the $100.00 next to a quantity.
 */
export function ocrAmounts(words: string[], wanted: (cents: number) => boolean): { cents: number; from: number; to: number }[] {
  const found: { cents: number; from: number; to: number }[] = [];
  for (let at = 0; at < words.length; ) {
    let hit: (typeof found)[number] | undefined;
    for (let len = Math.min(3, words.length - at); len >= 1 && !hit; len--) {
      const cents = ocrCents(words.slice(at, at + len).join(""));
      if (cents !== null && (len === 1 || wanted(cents))) hit = { cents, from: at, to: at + len - 1 };
    }
    if (hit) found.push(hit);
    at = (hit?.to ?? at) + 1;
  }
  return found;
}

const ocrKey = (s: string) => slipped(normalise(s).replace(/[\s,.]/g, ""));
const QUOTE_SLIP_SHARE = 0.1;

function bestDistance(text: string, pattern: string): number {
  let previous = Array.from({ length: pattern.length + 1 }, (_, i) => i);
  let best = previous[pattern.length]!;
  for (const c of text) {
    const row = [0];
    for (let j = 1; j <= pattern.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (pattern[j - 1] === c ? 0 : 1));
    previous = row;
    best = Math.min(best, row[pattern.length]!);
  }
  return best;
}

/** Whether the quote is on an OCR page's text despite OCR slips: the same confusions as an amount, then at most a tenth of the quote's characters wrong. */
export function ocrContains(pageText: string, quote: string): boolean {
  const wanted = ocrKey(quote);
  return bestDistance(ocrKey(pageText), wanted) <= Math.floor(wanted.length * QUOTE_SLIP_SHARE);
}
