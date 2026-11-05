import type { Region } from "@dct/shared";
import type { Word } from "../types";

const LINE_TOLERANCE = 0.5;
const MASK_PAD = 0.004;
// A label's value sits after it on the same line or, in remittance tables, opens the next line.
const LOOKAHEAD_WORDS = 12;
const MIN_BANK_DIGITS = 5;
const AMOUNT = /^\(?(?:US)?\$|^\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?[.,;:]?$/;
const BIC = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
// OCR can add or drop a character in a SWIFT code ("TESTUSS33"); a heading word caught by this after a label is the price.
const OCR_BIC = /^[A-Z]{4}[A-Z0-9]{3,8}$/;
// IBANs print in groups of four, some all letters ("GB29 NWBK 6016 …").
const IBAN_GROUP = /^[A-Z]{4}$/;

const median = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)] ?? 0;
};

const centre = (w: Word) => (w.y0 + w.y1) / 2;

export function groupLines(words: Word[]): Word[][] {
  const tolerance = LINE_TOLERANCE * median(words.map((w) => w.y1 - w.y0));
  const lines: { words: Word[]; sum: number }[] = [];
  for (const w of [...words].sort((p, q) => centre(p) - centre(q))) {
    const last = lines.at(-1);
    if (last && Math.abs(centre(w) - last.sum / last.words.length) <= tolerance) {
      last.words.push(w);
      last.sum += centre(w);
    } else lines.push({ words: [w], sum: centre(w) });
  }
  return lines.map((l) => l.words.sort((p, q) => p.x0 - q.x0));
}

export const rawLine = (line: Word[]) => line.map((w) => w.text).join(" ");

const bare = (t: string | undefined, ocr: boolean) => (t ?? "").toLowerCase().replace(ocr ? /[^a-z0-9|]/g : /[^a-z]/g, "");
// Labels glue to their value or to each other: "Acct#900123456", "ABA/Routing:", "A/C".
const labelParts = (t: string) => t.toLowerCase().replace("a/c", "ac").split(/[^a-z]+/).filter(Boolean);
const digitCount = (t: string) => t.replace(/\D/g, "").length;
const alnum = (t: string) => t.replace(/[^A-Za-z0-9]/g, "");

// OCR reads digits as these letters; "S" also stands in for "$".
const DIGIT_LIKE: Record<string, string> = { O: "0", o: "0", D: "0", l: "1", I: "1", "|": "1", i: "1", S: "5", s: "5", B: "8", Z: "2", g: "9" };
const MIN_DIGIT_LIKE_SHARE = 0.6;
const toDigits = (t: string) => t.replace(/[OoDlI|iSsBZg]/g, (c) => DIGIT_LIKE[c]!);
// A word with at least one real digit that is mostly digit-like reads as digits; one with none is left to the fail-closed rule.
function ocrDigitCount(t: string) {
  const chars = t.replace(/[^A-Za-z0-9|]/g, "");
  const digits = digitCount(toDigits(chars));
  return /\d/.test(chars) && digits >= MIN_DIGIT_LIKE_SHARE * chars.length ? digits : 0;
}

const LABELS = ["account", "acct", "ac", "aba", "routing", "swift", "bic", "iban", "bank", "transit"];
const SLIP_MIN_LENGTH = 5;
const SLIP_CHARS: [RegExp, string][] = [[/0/g, "o"], [/[1l|]/g, "i"], [/5/g, "s"], [/8/g, "b"], [/2/g, "z"], [/9/g, "g"]];
const canon = (t: string) => SLIP_CHARS.reduce((s, [from, to]) => s.replace(from, to), t);
// A long label may be one character off after OCR's usual swaps; a short one only ever differs by those swaps.
function slips(part: string, label: string) {
  const [p, l] = [canon(part), canon(label)];
  if (p.length !== l.length) return false;
  const off = [...p].filter((c, i) => c !== l[i]).length;
  return off <= (label.length >= SLIP_MIN_LENGTH ? 1 : 0);
}
const ocrLabelParts = (t: string) =>
  t.toLowerCase().replace("a/c", "ac").split(/[^a-z0-9|]+/).filter(Boolean).flatMap((p) => [p, p.match(/^[a-z]+/)?.[0] ?? p]);

function isLabel(line: Word[], i: number, ocr: boolean) {
  const same = ocr ? slips : (p: string, l: string) => p === l;
  const parts = (ocr ? ocrLabelParts : labelParts)(line[i]!.text);
  return parts.some((p) => LABELS.some((l) => same(p, l))) || (same(parts.at(-1) ?? "", "sort") && same(bare(line[i + 1]?.text, ocr), "code"));
}

const isAmount = (t: string, ocr: boolean) => AMOUNT.test(t) || (ocr && AMOUNT.test(toDigits(t)));

// What a garbled number looks like after OCR: any digit, a run of digit-like letters, or mostly punctuation. Words and amounts stay readable.
function couldBeNumber(t: string) {
  if (isAmount(t, true)) return false;
  const chars = t.replace(/[^A-Za-z0-9|]/g, "");
  return /\d/.test(chars) || (chars.length >= MIN_BANK_DIGITS && /^[OoDlI|iSsBZg]+$/.test(chars)) || chars.length < t.length / 2;
}

function valueAfter(window: Word[], ocr: boolean): Word[] {
  const digitsOf = ocr ? ocrDigitCount : digitCount;
  const bic = ocr ? OCR_BIC : BIC;
  const run: Word[] = [];
  for (const w of window) {
    const t = w.text;
    const amount = isAmount(t, ocr);
    const part = !amount && (digitsOf(t) > 0 || bic.test(alnum(t)) || (run.length > 0 && IBAN_GROUP.test(alnum(t))));
    if (part) run.push(w);
    else if (run.length) break;
  }
  const digits = run.reduce((n, w) => n + digitsOf(w.text), 0);
  return digits >= MIN_BANK_DIGITS || (run.length === 1 && bic.test(alnum(run[0]!.text))) ? run : [];
}

export function bankLabels(lines: Word[][], ocr = false): Word[] {
  return lines.flatMap((line) => line.filter((_, wi) => isLabel(line, wi, ocr)));
}

/**
 * On an OCR page, digit-like misreads count as digits and labels may carry a slip. A label with no readable number after
 * it hides whatever near it could be a garbled number, since a number OCR mangled is still a number; the words and
 * amounts around it stay readable, because labels like "account" and "bank" are common in contract prose.
 */
export function maskBankDetails(lines: Word[][], ocr = false): Region[] {
  const masked = new Set<Word>();
  const digitsOf = ocr ? ocrDigitCount : digitCount;
  lines.forEach((line, li) => {
    line.forEach((label, wi) => {
      if (!isLabel(line, wi, ocr)) return;
      const glued = digitsOf(label.text) >= MIN_BANK_DIGITS;
      if (glued) masked.add(label);
      const window = [...line.slice(wi + 1), ...(lines[li + 1] ?? [])].slice(0, LOOKAHEAD_WORDS);
      const value = valueAfter(window, ocr);
      const failClosed = ocr && !glued && value.length === 0;
      for (const w of failClosed ? window.filter((w) => couldBeNumber(w.text)) : value) masked.add(w);
    });
  });
  return [...masked].map((w) => {
    w.text = w.text.replace(/[A-Za-z0-9]/g, "#");
    return [Math.max(0, w.x0 - MASK_PAD), Math.max(0, w.y0 - MASK_PAD), Math.min(1, w.x1 + MASK_PAD), Math.min(1, w.y1 + MASK_PAD)] satisfies Region;
  });
}

export function layoutText(lines: Word[][]): string {
  const widths = lines.flat().map((w) => (w.x1 - w.x0) / w.text.length);
  const charWidth = median(widths) || 0.01;
  return lines
    .map((line) => {
      let out = "";
      for (const w of line) out += " ".repeat(Math.max(Math.round(w.x0 / charWidth) - out.length, out ? 1 : 0)) + w.text;
      return out;
    })
    .join("\n");
}
