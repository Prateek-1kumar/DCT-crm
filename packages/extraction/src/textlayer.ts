import type { PageBox } from "@dct/shared";
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
};

/** COPD's signed budget grid is set in 3.2 pt type, so the ADR's "under 4 pt" would hide a real grid. */
export const MIN_VISIBLE_PT = 2;

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
export const KEYWORDS = {
  money: /\b(?:pay|paid|invoic|fees?\b|cost|reimburs|overhead|indirect|f\s?&\s?a\b|holdback|withh|retain|refund|offset|interest|late\b|cap(?:ped)?\s(?:of|at|on)\b|not to exceed|escalat|increas|stipend|screen[\s-]?fail|terminat|budget|compensat)/i,
  /** A sentence with one of these is money-relevant even without a number: the sweep behind "no holdback", "no cap"... */
  absence: /\b(?:holdback|withh|retain|interest|late\b|escalat|increas|inflation|not to exceed|maximum|cap(?:ped)?\s(?:of|at|on)\b|screen[\s-]?fail|terminat)/i,
  /** Bank or payment instructions: excluded from the inventory and never stored (§9), when they also carry a digit run. */
  bank: /\b(?:aba|routing|swift|iban|bic|account|acct|sort code)\b/i,
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
export type Span = { kind: SpanKind; where: PageBox; words: Word[]; /** The line or sentence it sits in. */ text: string };

export const NUMBER = /^\(?(?:US)?\$?\d[\d,]*(?:\.\d+)?\)?%?$/;
/** A number as printed without the sentence punctuation after it: "$7,455.00." → "$7,455.00". Test NUMBER on this. */
export const bare = (s: string) => s.replace(/(?<=[\d)%])[.,;:]+$/, "");
const CURRENCY = /^\(?(?:US\$|\$|USD)$/;

/** Dollar amounts in reading order; a lone "$" joins the number after it. `currencyOnly`: only those with a sign. */
export function amounts(ws: Word[], currencyOnly = false): { words: Word[]; cents: number }[] {
  const out: { words: Word[]; cents: number }[] = [];
  ws.forEach((w, i) => {
    const pair = CURRENCY.test(w.text) && ws[i + 1] && NUMBER.test(bare(ws[i + 1]!.text));
    const t = bare(pair ? w.text + ws[i + 1]!.text : w.text);
    if (CURRENCY.test(ws[i - 1]?.text ?? "") || !NUMBER.test(t) || t.endsWith("%")) return;
    const money = /\$|USD/.test(t) || (!currencyOnly && /\d,\d{3}|\.\d{2}\)?$/.test(t));
    const whole = t.replace(/[^\d.]/g, "").split(".")[0]!;
    if (money && !(whole.length >= 8 && !t.includes(","))) out.push({ words: pair ? [w, ws[i + 1]!] : [w], cents: Math.round(Number(t.replace(/[^\d.]/g, "")) * 100) });
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

/**
 * Where the bank details are on a text page, in page points, to paint over before the page goes to a model (ADR-001 §9):
 * in each bank sentence, every word carrying 3+ digits (account, routing, sort code) or opening like an IBAN. Scans have none.
 */
export function bankRects(p: TextPage): Rect[] {
  if (p.source !== "text") return [];
  return sentences(p)
    .filter(bankSentence)
    .flatMap((s) => s.filter((w) => (w.text.match(/\d/g)?.length ?? 0) >= 3 || /^[A-Z]{2}\d{2}/.test(w.text)).map((w) => w.rect));
}

/**
 * Every money-relevant span on the text pages (ADR-001 §3): currency amounts, numbers in table rows, and %, day,
 * ratio and "up to N" figures or absence keywords in a money sentence. Bank instructions are left out.
 */
export function inventory(pages: TextPage[]): Span[] {
  const out: Span[] = [];
  for (const p of pages.filter((x) => x.source === "text")) {
    const taken = new Set<Word>();
    const add = (kind: SpanKind, ws: Word[], ctx: Word[]) => {
      if (!ws.length || ws.some((w) => taken.has(w))) return;
      ws.forEach((w) => taken.add(w));
      out.push({ kind, where: boxOf(p, ws), words: ws, text: text(ctx).slice(0, 240) });
    };
    const sents = sentences(p);
    for (const s of sents) if (bankSentence(s)) s.forEach((w) => taken.add(w));
    const lines = visualLines(p.words.filter((w) => !w.hidden));
    for (const l of lines) for (const a of amounts(l, true)) add("amount", a.words, l);
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
