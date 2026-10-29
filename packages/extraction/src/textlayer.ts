import { type PageBox, parseCents } from "@dct/shared";
import { MIN_PAGE_TEXT } from "./checks";
import { pageCount, textPage } from "./render";

/** The PDF's own text (mupdf structured text), no AI: words with boxes, each page's text source, hidden text. */

/** x0, y0, x1, y1 in points, in the space renderPage draws (the page's /Rotate applied). */
export type Rect = [number, number, number, number];

export type Word = {
  text: string;
  rect: Rect;
  /** Reading direction in quarter turns clockwise: 0 left→right, 1 top→bottom, 2 upside down, 3 bottom→top. */
  dir: 0 | 1 | 2 | 3;
  block: number;
  line: number;
  /** White, under MIN_VISIBLE_PT, off the page, or invisible render mode: no reader sees it. Never evidence. */
  hidden: boolean;
};

export type TextPage = {
  documentId: string;
  page: number;
  width: number;
  height: number;
  /** ocr_layer: text over a full-page image (a scanner's OCR), not the signed characters. */
  source: "text" | "image_only" | "ocr_layer";
  words: Word[];
  hidden: number;
  /**
   * A text page that also shows a picture (a budget table pasted in as an image, a screenshot): images that touch
   * count as one, visible text covers under 5% of it, and it fills at least 5% of the page with its centre in the body,
   * or 15% with its centre in the top or bottom tenth, where letterheads sit. What it prints can't be swept for money
   * terms, so a person attests the page, as for a scan (ADR-001 §3, I5). Signatures, initials and logos are smaller.
   * Always false on scans and OCR layers, which are attested whole.
   */
  largePicture: boolean;
};

/** COPD's signed budget grid is set in 3.2 pt type, so the ADR's "under 4 pt" would hide a real grid. */
const MIN_VISIBLE_PT = 2;

/** Every page's text, read in the mupdf worker (render.ts), one page at a time: a page that hangs fails the read, it can't hang the server. */
export async function readTextLayer(pdfPath: string, documentId: string): Promise<TextPage[]> {
  const out: TextPage[] = [];
  for (let i = 1, n = await pageCount(pdfPath); i <= n; i++) out.push(await textPage(pdfPath, i, documentId, MIN_VISIBLE_PT, MIN_PAGE_TEXT));
  return out;
}

export const union = (rs: Rect[]): Rect => [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];

/** The shared PageBox (fractions of the page) around some words. */
export const boxOf = (p: TextPage, ws: Word[]): PageBox => {
  if (!ws.length) return { documentId: p.documentId, page: p.page, box: null };
  const [x0, y0, x1, y1] = union(ws.map((w) => w.rect));
  return { documentId: p.documentId, page: p.page, box: [x0 / p.width, y0 / p.height, (x1 - x0) / p.width, (y1 - y0) / p.height] };
};

/** A word's box in its own reading frame: u runs along the text, v down to the next line. */
export function frame(w: Word): Rect {
  const [x0, y0, x1, y1] = w.rect;
  return [[x0, y0, x1, y1], [y0, -x1, y1, -x0], [-x1, -y1, -x0, -y0], [-y1, x0, -y0, x1]][w.dir] as Rect;
}

/** Words grouped into visual lines, each in its own reading direction: a table row is one line even when its cells are separate text lines. */
export function visualLines(words: Word[]): Word[][] {
  const out: Word[][] = [];
  for (const d of [0, 1, 2, 3]) {
    const ws = words.filter((w) => w.dir === d).map((w) => ({ w, f: frame(w) }));
    ws.sort((a, b) => a.f[1] + a.f[3] - b.f[1] - b.f[3]);
    let line: typeof ws = [];
    for (const x of ws) {
      const last = line[0];
      // ponytail: centres within half a word height join one line; a cell centred on a two-line label joins neither. Upgrade: row bands from rulings.
      if (last && (x.f[1] + x.f[3]) / 2 - (last.f[1] + last.f[3]) / 2 > Math.min(x.f[3] - x.f[1], last.f[3] - last.f[1]) / 2) {
        out.push(line.sort((a, b) => a.f[0] - b.f[0]).map((y) => y.w));
        line = [];
      }
      line.push(x);
    }
    if (line.length) out.push(line.sort((a, b) => a.f[0] - b.f[0]).map((y) => y.w));
  }
  return out;
}

// ---------- money-relevant inventory (ADR-001 §3) ----------

/**
 * The sweep's keywords, ADR-001 §3. Prefixes on purpose: "pay" covers payment, payable. "cap" only as "cap of / capped at":
 * a medication list's "cap" (capsule) otherwise makes every dose line a money sentence.
 */
const KEYWORDS = {
  money: /\b(?:pay|paid|invoic|fees?\b|cost|reimburs|overhead|indirect|f\s?&\s?a\b|holdback|withh|retain|refund|offset|interest|late\b|cap(?:ped)?\s(?:of|at|on)\b|not to exceed|escalat|increas|stipend|screen[\s-]?fail|terminat|budget|compensat)/i,
  /** A sentence with one of these is money-relevant even without a number: the sweep behind "no holdback", "no cap"... */
  absence: /\b(?:holdback|withh|retain|interest|late\b|escalat|increas|inflation|not to exceed|maximum|cap(?:ped)?\s(?:of|at|on)\b|screen[\s-]?fail|terminat)/i,
  /** Bank or payment instructions: excluded from the inventory and never stored (§9), when they also carry a digit run. */
  bank: /\b(?:aba|routing|swift|iban|bic|account|acct|sort code)\b/i,
  /** A line naming bank details: its number may sit on the same line or the next one or two, in another text block. */
  bankLabel: /\b(?:aba|routing|swift|iban|bic|account|acct|sort code|wire|ach|bank)\b/i,
};

/**
 * Spans inside a money sentence. `limit` is "up to / maximum of N" without a currency sign.
 * ponytail: digits only; "ten percent" in words isn't swept (ADR §3). Upgrade: number-word patterns.
 */
const RULES: [SpanKind, RegExp][] = [
  ["percent", /\d+(?:\.\d+)?\s?(?:%|percent\b)/gi],
  ["days", /\(?\d+\)?[\s-]?(?:calendar\s|business\s|working\s)?(?:days?|weeks?|months?)\b/gi],
  ["ratio", /\b\d+\s?:\s?\d+\b/g],
  ["limit", /\b(?:up to|maximum of|max(?:imum)?\.?|not to exceed|no more than)\s\(?\d[\d,]*/gi],
];

export type SpanKind = "amount" | "grid_number" | "percent" | "days" | "ratio" | "limit" | "absence";
export type Span = {
  kind: SpanKind;
  where: PageBox;
  words: Word[];
  /** The line or sentence it sits in. */
  text: string;
  /** Where that line or sentence is printed, one box per line: a sentence can run over lines the span isn't on. */
  lines: PageBox[];
  /** An amount's cents, read with the word before it (centsOf: brackets restating words aren't a credit). */
  cents?: number;
};

export const NUMBER = /^\(?(?:US)?\$?\d[\d,]*(?:\.\d+)?\)?%?$/;
/** A number as printed without the sentence punctuation after it: "$7,455.00." → "$7,455.00". Test NUMBER on this. */
export const bare = (s: string) => s.replace(/(?<=[\d)%])[.,;:]+$/, "");
const CURRENCY = /^\(?(?:US\$|\$|USD)$/;

const UNITS = "one|two|three|four|five|six|seven|eight|nine";
/** The word before "($3,000.00)" when the brackets restate an amount written in words: "Three Thousand Dollars ($3,000.00)". */
const RESTATES = new RegExp(`^(?:dollars?|usd|u\\.?s\\.?|\\d+/100|zero|${UNITS}|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:${UNITS}))?|hundred|thousand|million)$`, "i");

/**
 * The cents an amount prints (parseCents, @dct/shared: one reading of amounts everywhere). In brackets, "(1,500.00)" is a
 * credit and comes out below zero, so it can't back a positive value; unless the brackets restate the words before them
 * (`before`, the word printed just ahead). null when it isn't an amount (a fraction of a cent, say).
 */
export const centsOf = (t: string, before = ""): number | null => parseCents(t, { restates: RESTATES.test(before.replace(/[.,;:]+$/, "")) });

/**
 * Dollar amounts in reading order; a lone "$" joins the number after it. `currencyOnly`: only those with a sign.
 * `before` gives the word printed ahead of one (default: the one before it in `ws`), for "Dollars ($3,000.00)" across a line break.
 */
export function amounts(ws: Word[], currencyOnly = false, before?: (w: Word) => Word | undefined): { words: Word[]; cents: number }[] {
  const out: { words: Word[]; cents: number }[] = [];
  ws.forEach((w, i) => {
    const pair = CURRENCY.test(w.text) && ws[i + 1] && NUMBER.test(bare(ws[i + 1]!.text));
    const t = bare(pair ? w.text + ws[i + 1]!.text : w.text);
    if (CURRENCY.test(ws[i - 1]?.text ?? "") || !NUMBER.test(t) || t.endsWith("%")) return;
    const money = /\$|USD/.test(t) || (!currencyOnly && /\d,\d{3}|\.\d{2}\)?$/.test(t));
    const whole = t.replace(/[^\d.]/g, "").split(".")[0]!;
    const cents = centsOf(t, (before ? before(w) : ws[i - 1])?.text);
    if (money && cents !== null && !(whole.length >= 8 && !t.includes(","))) out.push({ words: pair ? [w, ws[i + 1]!] : [w], cents });
  });
  return out;
}

/** Sentences per text block, as word lists. */
export function sentences(p: TextPage): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  const ws = p.words.filter((w) => !w.hidden);
  ws.forEach((w, i) => {
    cur.push(w);
    const next = ws[i + 1];
    // ponytail: naive splitter (". " before a capital, ";", block end); a few abbreviations kept. Upgrade: a real sentence segmenter.
    const stop = /[.;]$/.test(w.text) && !/^(?:[a-z]\.){1,3}$|^(?:no|inc|dr|mr|ms|vs|sec|art)\.$/i.test(w.text) && (!next || /^[A-Z(\d]/.test(next.text));
    if (!next || next.block !== w.block || stop) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
}

const text = (ws: Word[]) => ws.map((w) => w.text).join(" ");

/** Bank or payment instructions: a bank keyword and a digit run in one sentence (ADR-001 §9). */
const bankSentence = (s: Word[]) => KEYWORDS.bank.test(text(s)) && /\d[\d\s-]{4,}\d/.test(text(s));
const digits = (w: Word) => w.text.match(/\d/g)?.length ?? 0;
/** An account, routing or sort-code number (or an IBAN's opening), never an amount, a % or a date like 8/22/2025. */
const accountNo = (w: Word) => {
  const t = w.text.replace(/^[(#:]+|[.,;:)]+$/g, "");
  return (/^[A-Z]{0,4}\d[\d-]*$/i.test(t) && digits(w) >= 3) || /^[A-Z]{2}\d{2}/.test(t);
};

/**
 * The words holding bank details on a text page (ADR-001 §9): in each bank sentence, every word carrying 3+ digits or
 * opening like an IBAN; and every account-like number on a line naming bank details or on the next one or two lines
 * (a table's label cell, or "Wire to account:" above its number, are often a text block of their own).
 * ponytail: up to 2 lines below a label, each within 2.5 line heights; a number further down isn't masked. Upgrade: the label's own block.
 */
function bankWords(p: TextPage): Word[] {
  if (p.source !== "text") return [];
  const out = new Set(sentences(p).filter(bankSentence).flatMap((s) => s.filter((w) => digits(w) >= 3 || /^[A-Z]{2}\d{2}/.test(w.text))));
  const lines = visualLines(p.words);
  const v = (l: Word[]) => (frame(l[0]!)[1] + frame(l[0]!)[3]) / 2;
  const h = (l: Word[]) => Math.max(...l.map((w) => frame(w)[3] - frame(w)[1]));
  lines.forEach((l, i) => {
    if (!KEYWORDS.bankLabel.test(text(l))) return;
    for (let k = i; k <= i + 2 && lines[k]; k++) {
      const [cur, prev] = [lines[k]!, lines[k - 1]!];
      if (k > i && (cur[0]!.dir !== prev[0]!.dir || v(cur) - v(prev) > 2.5 * Math.max(h(cur), h(prev)))) break;
      cur.filter(accountNo).forEach((w) => out.add(w));
    }
  });
  return [...out];
}

/** Where the bank details are, in page points, to paint over before the page goes to a model. Scans have none. */
export const bankRects = (p: TextPage): Rect[] => bankWords(p).map((w) => w.rect);

/**
 * Every money-relevant span on the text pages (ADR-001 §3): currency amounts, numbers in table rows, and %, day,
 * ratio and "up to N" figures or absence keywords in a money sentence. Bank instructions are left out.
 */
export function inventory(pages: TextPage[]): Span[] {
  const out: Span[] = [];
  for (const p of pages.filter((x) => x.source === "text")) {
    const taken = new Set<Word>();
    const add = (kind: SpanKind, ws: Word[], ctx: Word[], cents?: number) => {
      if (!ws.length || ws.some((w) => taken.has(w))) return;
      ws.forEach((w) => taken.add(w));
      const text = ctx.map((w) => (bank.has(w) ? "…" : w.text)).join(" ").slice(0, 240);
      out.push({ kind, where: boxOf(p, ws), words: ws, text, lines: visualLines(ctx).map((l) => boxOf(p, l)), ...(cents !== undefined ? { cents } : {}) });
    };
    const sents = sentences(p);
    for (const s of sents) if (bankSentence(s)) s.forEach((w) => taken.add(w));
    // Bank numbers found by their label line too, never stored, even as the line around another span: every bank word
    // is "…" in a span's text. A short run (3–5 digits) under a line that only mentions an account may be a price or a
    // count, so it stays in the sweep: masked from the model and in its text, it's then asked, never dropped.
    const bank = new Set(bankWords(p));
    const secret = new Set([...bank].filter((w) => taken.has(w) || digits(w) >= 6 || /^[A-Z]{2}\d{2}/.test(w.text)));
    secret.forEach((w) => taken.add(w));
    const lines = visualLines(p.words.filter((w) => !w.hidden));
    for (const l of lines) for (const a of amounts(l, true)) add("amount", a.words, l, a.cents);
    for (const l of lines) {
      // Table row ("grid row band"): 2+ numbers, each set off from the word before it by a column gap.
      const cells = l.filter((w, i) => NUMBER.test(bare(w.text)) && (i === 0 || frame(w)[0] - frame(l[i - 1]!)[2] >= frame(w)[3] - frame(w)[1]));
      if (cells.length >= 2) for (const w of cells) add("grid_number", [w], l);
    }
    for (const s of sents) {
      const t = text(s);
      const starts: number[] = [];
      s.reduce((n, w) => (starts.push(n), n + w.text.length + 1), 0);
      const at = (from: number, to: number) => s.filter((w, i) => starts[i]! < to && starts[i]! + w.text.length > from);
      const before = out.length;
      if (KEYWORDS.money.test(t)) for (const [kind, re] of RULES) for (const m of t.matchAll(re)) add(kind, at(m.index, m.index + m[0].length), s);
      if (out.length === before && KEYWORDS.absence.test(t) && !s.some((w) => taken.has(w))) add("absence", s, s);
    }
  }
  return out;
}
