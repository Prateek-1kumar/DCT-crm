import type { Region } from "@dct/shared";
import type { Word } from "../types";

const LINE_TOLERANCE = 0.5;
const MASK_PAD = 0.004;
// Account numbers sit right after their label ("Account Number: 123…"); further away the digits are probably something else.
const LABEL_REACH = 40;
const MIN_BANK_DIGITS = 5;
const BANK_LABEL = /\b(?:account|acct|a\/c|aba|routing|swift|iban|bank|sort code)\b/gi;
// Not preceded by $ . , so the tail of an amount like $1,234,567 is never read as an account number.
const DIGIT_RUN = /(?<![\d$.,])\d(?:[ -]?\d)*/g;

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

export function maskBankDetails(lines: Word[][]): Region[] {
  const boxes: Region[] = [];
  for (const line of lines) {
    const raw = rawLine(line);
    const hit: boolean[] = [];
    for (const label of raw.matchAll(BANK_LABEL)) {
      const from = label.index + label[0].length;
      for (const run of raw.matchAll(DIGIT_RUN)) {
        if (run.index < from || run.index - from > LABEL_REACH || run[0].replace(/\D/g, "").length < MIN_BANK_DIGITS) continue;
        for (let i = 0; i < run[0].length; i++) hit[run.index + i] = true;
      }
    }
    let offset = 0;
    let group: Word[] = [];
    const closeGroup = () => {
      if (!group.length) return;
      boxes.push([
        Math.max(0, Math.min(...group.map((w) => w.x0)) - MASK_PAD),
        Math.max(0, Math.min(...group.map((w) => w.y0)) - MASK_PAD),
        Math.min(1, Math.max(...group.map((w) => w.x1)) + MASK_PAD),
        Math.min(1, Math.max(...group.map((w) => w.y1)) + MASK_PAD),
      ]);
      group = [];
    };
    for (const w of line) {
      const masked = [...w.text].map((ch, i) => (hit[offset + i] && /\d/.test(ch) ? "#" : ch)).join("");
      if (masked !== w.text) {
        w.text = masked;
        group.push(w);
      } else closeGroup();
      offset += w.text.length + 1;
    }
    closeGroup();
  }
  return boxes;
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
