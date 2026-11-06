import type { Region } from "@dct/shared";
import type { Word } from "../types";

const LINE_TOLERANCE = 0.5;
const MASK_PAD = 0.004;
// A label's value sits after it on the same line or, in remittance tables, opens the next line.
const LOOKAHEAD_WORDS = 12;
const MIN_BANK_DIGITS = 5;
const AMOUNT = /^\(?(?:US)?\$|^\(?\d{1,3}(?:,\d{3})*\.\d{2}\)?[.,;:]?$/;
const BIC = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
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

const bare = (t: string | undefined) => (t ?? "").toLowerCase().replace(/[^a-z]/g, "");
// Labels glue to their value or to each other: "Acct#900123456", "ABA/Routing:", "A/C".
const labelParts = (t: string) => t.toLowerCase().replace("a/c", "ac").split(/[^a-z]+/).filter(Boolean);
const digitCount = (t: string) => t.replace(/\D/g, "").length;
const alnum = (t: string) => t.replace(/[^A-Za-z0-9]/g, "");

const LABELS = ["account", "acct", "ac", "aba", "routing", "swift", "bic", "iban", "bank", "transit"];
function isLabel(line: Word[], i: number) {
  const parts = labelParts(line[i]!.text);
  return parts.some((p) => LABELS.includes(p)) || (parts.at(-1) === "sort" && bare(line[i + 1]?.text) === "code");
}

const isAmount = (t: string) => AMOUNT.test(t);

function valueAfter(window: Word[]): Word[] {
  const run: Word[] = [];
  for (const w of window) {
    const t = w.text;
    const part = !isAmount(t) && (digitCount(t) > 0 || BIC.test(alnum(t)) || (run.length > 0 && IBAN_GROUP.test(alnum(t))));
    if (part) run.push(w);
    else if (run.length) break;
  }
  const digits = run.reduce((n, w) => n + digitCount(w.text), 0);
  return digits >= MIN_BANK_DIGITS || (run.length === 1 && BIC.test(alnum(run[0]!.text))) ? run : [];
}

/** Hides, in place, the bank number, routing number, SWIFT code or IBAN printed after a label, and returns where each was. */
export function maskBankDetails(lines: Word[][]): Region[] {
  const masked = new Set<Word>();
  lines.forEach((line, li) => {
    line.forEach((label, wi) => {
      if (!isLabel(line, wi)) return;
      if (digitCount(label.text) >= MIN_BANK_DIGITS) masked.add(label);
      const window = [...line.slice(wi + 1), ...(lines[li + 1] ?? [])].slice(0, LOOKAHEAD_WORDS);
      for (const w of valueAfter(window)) masked.add(w);
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
