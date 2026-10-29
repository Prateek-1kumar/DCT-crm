import { AMOUNT_IN_NAME, type BudgetGrid, type PageBox, type Provenance, type ReviewItem, type Rulebook, type ValueEvidence } from "@dct/shared";
import { amounts, bare, boxOf, centsOf, frame, inventory, NUMBER, sentences, type Span, type TextPage, visualLines, type Word } from "./textlayer";

/**
 * Binder (ADR-001 §5), no AI: each money value in a rulebook is looked up at its own position in the PDF's text, and
 * every inventory span no value is bound to comes back as unaccounted.
 */

type Line = { words: Word[]; dir: Word["dir"]; v: number; h: number };
/** `before`: the word printed ahead of one, in the text's own order. `sentence`: the text of the sentence a word is in. */
type Page = { p: TextPage; lines: Line[]; orders: Word[][]; before: (w: Word) => Word | undefined; sentence: (w: Word) => string };
type Cols = { dir: Word["dir"]; at: Map<string, [number, number]>; unit: [number, number] | null; left: number; pitch: number; line: Line };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const cents = (s: string | null) => {
  const t = bare((s ?? "").replace(/\s/g, ""));
  return NUMBER.test(t) && !t.endsWith("%") ? centsOf(t) : null;
};
const txt = (ws: Word[]) => ws.map((w) => w.text).join(" ");
const mid = (w: Word) => (frame(w)[1] + frame(w)[3]) / 2;

const cache = new WeakMap<TextPage, Page>();
function pageData(p: TextPage): Page {
  const hit = cache.get(p);
  if (hit) return hit;
  const seen = p.words.filter((w) => !w.hidden);
  const lines = visualLines(seen).map((ws) => ({ words: ws, dir: ws[0]!.dir, v: mid(ws[0]!), h: Math.max(...ws.map((w) => frame(w)[3] - frame(w)[1])) }));
  const prev = new Map(seen.slice(1).map((w, i) => [w, seen[i]!]));
  const sentence = new Map(sentences(p).flatMap((s) => s.map((w) => [w, txt(s)] as const)));
  const out = { p, lines, orders: [seen, lines.flatMap((l) => l.words)], before: (w: Word) => prev.get(w), sentence: (w: Word) => sentence.get(w) ?? "" };
  cache.set(p, out);
  return out;
}

// ---------- labels and rows ----------

const STOP = new Set(["the", "of", "and", "a", "an", "per", "for", "to", "in", "with", "or", "on", "at", "by"]);
const tokens = (s: string) => s.split(/\s+/).map(norm).filter((t) => t.length > 1 && !STOP.has(t));
const sameToken = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Longest common subsequence of two token lists, tokens compared loosely (prefixes of 4+ letters). */
function lcs(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = [0];
    b.forEach((y, j) => cur.push(sameToken(x, y) ? prev[j]! + 1 : Math.max(prev[j + 1]!, cur[j]!)));
    prev = cur;
  }
  return prev[b.length]!;
}

type Option = { row: Line; code: Word | null; score: number };

/**
 * The rows a label may belong to, best first, found by the label and never by the value. The label's vertical band is
 * a run of up to 4 consecutive lines (left of `limit`) spelling at least half the name in order, scored by the F1 of the
 * common subsequence (neighbouring rows' descriptions often differ in a word or two). Its row is the candidate (a line
 * carrying numbers) nearest the band, from one line above it to 5 line heights below, since labels sit on their row's
 * line or are centred on it; on the code's line when the item has a printed code. No name: a code printed on exactly one candidate.
 */
function rowsFor(lines: Line[], cands: Line[], code: string | null, name: string, limit = Infinity): Option[] {
  const c = norm(code ?? "");
  const codeOf = (l: Line) => (c ? (l.words.find((w) => norm(w.text) === c) ?? null) : null);
  const byCode = cands.filter(codeOf);
  const pool = byCode.length ? byCode : cands;
  const want = tokens(name);
  const ls = lines.map((l) => ({ l, ts: l.words.filter((w) => frame(w)[2] <= limit).map((w) => norm(w.text)) })).filter((x) => x.ts.length);
  const best = new Map<Line, number>();
  // ponytail: a bottom-aligned label, or a name that skips its label's first line in a top-aligned table, lands on the next row → conflicts. Upgrade: row bands from rulings.
  ls.forEach((first, i) => {
    if (!first.ts.some((t) => want.some((x) => sameToken(x, t)))) return;
    for (let k = i, ts: string[] = []; k < Math.min(ls.length, i + 4); k++) {
      const [cur, prev] = [ls[k]!.l, ls[k - 1]?.l];
      if (k > i && (cur.dir !== prev!.dir || cur.v - prev!.v > 2 * Math.max(cur.h, prev!.h))) break;
      ts = [...ts, ...ls[k]!.ts];
      const common = lcs(want, ts);
      const gap = (l: Line) => Math.max(0, first.l.v - l.v, l.v - cur.v);
      const row = common >= want.length / 2 && pool.filter((l) => l.dir === first.l.dir && l.v >= first.l.v - 1.2 * first.l.h && l.v <= cur.v + 5 * cur.h).sort((a, b) => gap(a) - gap(b))[0];
      if (row) best.set(row, Math.max(best.get(row) ?? 0, (2 * common) / (want.length + ts.length)));
    }
  });
  if (!best.size && byCode.length === 1) best.set(byCode[0]!, 0);
  return [...best].map(([row, score]) => ({ row, code: codeOf(row), score })).sort((a, b) => b.score - a.score);
}

// ---------- grid columns ----------

const UNIT = /unit|cost|price|amount|rate|fee|budget/i;
const OVERHEAD = /overhead|indirect|f\s?&\s?a\b/i;

/** Word runs on one line that spell one of the targets. */
function runs(l: Line, targets: string[]): Word[][] {
  const ts = targets.map(norm).filter(Boolean);
  const max = Math.max(0, ...ts.map((t) => t.length));
  const out: Word[][] = [];
  l.words.forEach((_, i) => {
    let s = "";
    for (let j = i; j < l.words.length && s.length < max; j++) {
      s += norm(l.words[j]!.text);
      if (ts.includes(s)) {
        out.push(l.words.slice(i, j + 1));
        break;
      }
    }
  });
  return out;
}

const span = (ws: Word[]): [number, number] => [Math.min(...ws.map((w) => frame(w)[0])), Math.max(...ws.map((w) => frame(w)[2]))];

/**
 * Visit columns from the header line that names the most visits (code or name), in the text's own direction. `taken`:
 * header lines other grids on this page already use; a grid whose visits head another table just as well takes that one.
 */
function headerColumns(pg: Page, visits: BudgetGrid["visits"], taken: Line[] = []): Cols | null {
  const hits = visits.map((v) => pg.lines.flatMap((l) => runs(l, [v.code, v.name]).map((ws) => ({ l, ws }))));
  const near = (a: Line, b: Line) => a.dir === b.dir && Math.abs(a.v - b.v) <= 3 * Math.max(a.h, b.h);
  const best = (ls: Line[]) =>
    ls.reduce<[Line | null, number]>((b, l) => {
      const n = hits.filter((h) => h.some((x) => near(x.l, l))).length;
      return n > b[1] ? [l, n] : b;
    }, [null, 0]);
  const [top, most] = best(pg.lines);
  // ponytail: one header line per page, visit labels on one line each. Upgrade: join stacked header cells per column.
  if (!top || most < Math.max(2, visits.length / 2)) return null;
  // Another grid's header, and the lines naming visits around it, are busy: an equally good header elsewhere is this grid's.
  const lit = [...new Set(hits.flat().map((x) => x.l))];
  const block = lit.filter((x) => taken.some((t) => near(t, x)));
  const busy = (l: Line) => taken.some((t) => near(t, l)) || block.some((b) => near(b, l));
  const [free, n] = best(lit.filter((l) => !busy(l)));
  const h = busy(top) && free && n === most ? free : top;
  const at = new Map<string, [number, number]>();
  visits.forEach((v, i) => {
    const pick = hits[i]!.filter((x) => near(x.l, h)).sort((a, b) => Math.abs(a.l.v - h.v) - Math.abs(b.l.v - h.v))[0];
    if (pick) at.set(v.code, span(pick.ws));
  });
  const left = Math.min(...[...at.values()].map((c) => c[0]));
  const centres = [...at.values()].map((c) => (c[0] + c[1]) / 2).sort((a, b) => a - b);
  const gaps = centres.slice(1).map((c, i) => c - centres[i]!).sort((a, b) => a - b);
  const unitWord = pg.lines.filter((l) => near(l, h)).flatMap((l) => l.words.filter((w) => UNIT.test(w.text) && frame(w)[2] <= left)).sort((a, b) => frame(b)[0] - frame(a)[0])[0];
  return { dir: h.dir, at, unit: unitWord ? span([unitWord]) : null, left, pitch: gaps[Math.floor(gaps.length / 2)] ?? Infinity, line: h };
}

/** Column of a cell word: most overlap with a header, else (among the visits) the nearest header within half a column. */
function columnOf(cols: Cols, w: Word): string | null {
  const [u0, u1] = span([w]);
  const all: [string, [number, number]][] = [...cols.at, ...(cols.unit ? [["#unit", cols.unit] as [string, [number, number]]] : [])];
  let best: string | null = null;
  let score = -Infinity;
  for (const [k, [a, b]] of all) {
    const overlap = Math.min(u1, b) - Math.max(u0, a);
    const s = overlap > 0 ? overlap : -Math.abs((u0 + u1) / 2 - (a + b) / 2);
    if (s > score) [best, score] = [k, s];
  }
  return score > 0 || (u0 >= cols.left - cols.pitch / 2 && -score < cols.pitch / 2) ? best : null;
}

const cellWords = (cols: Cols, row: Line, key: string) => row.words.filter((w) => columnOf(cols, w) === key);

// ---------- quotes ----------

const QUOTE_WORD = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[­\-‐-―]/g, "")
    .replace(/^[.,;:!?()[\]"'*]+|[.,;:!?()[\]"'*]+$/g, "");

/**
 * Page words that say the quote word for word (whitespace, quote marks, hyphens, case and edge punctuation aside), whole words only.
 * ponytail: a quote the reader shortened with "…" doesn't match → ungrounded. Upgrade: match the parts in order.
 */
function findQuote(pg: Page, quote: string | undefined): Word[] | null {
  const q = (quote ?? "").split(/\s+/).map(QUOTE_WORD).join("");
  if (q.length < 3) return null;
  for (const order of pg.orders) {
    const parts = order.map((w) => QUOTE_WORD(w.text));
    const starts: number[] = [];
    const s = parts.reduce((acc, t) => (starts.push(acc.length), acc + t), "");
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + 1)) {
      const a = starts.indexOf(i);
      const b = starts.findIndex((st, k) => st + parts[k]!.length === i + q.length && parts[k]!.length > 0);
      if (a >= 0 && b >= a) return order.slice(a, b + 1);
    }
  }
  return null;
}

// ---------- figures: %, days, counts, ratios and dates as printed ----------

/** What kind of figure a value is, so only figures of that kind where it's stated can back it. */
type Unit = "pct" | "days" | "months" | "count" | "ratio" | "cents" | "date";
/** A figure printed in some words: what it can mean (an all-number date like 03/04/2025 means two), and where it is. */
type Figure = { words: Word[]; values: (number | string)[]; printed: string; at: PageBox };

/** A number as printed, without the brackets of "forty-five (45)" or the sentence's punctuation: "45", "40%", "30-day" for "(30)-day". */
const core = (s: string) => s.replace(/[.,;:]+$/, "").replace(/^\(/, "").replace(/\)(?=-|$)/, "");
const NUM = /^(\d+(?:\.\d+)?)(%|-(?:calendar-|business-|working-)?(day|week|month|year)s?)?$/i;
const UNIT_WORD = /^(?:(day)|(week)|(month)|(year))s?$/i;
type Scanned = { i: number; n: number; unit: "pct" | "days" | "weeks" | "months" | "years" | null; words: Word[]; printed: string };

/** Every number in some words with the unit printed with it: "40%", "40 percent", "45 days", "(45) business days", "45-day", "net 45". */
function scan(ws: Word[]): Scanned[] {
  const word = (w: Word | undefined) => (w ? w.text.replace(/[.,;:)]+$/, "").toLowerCase() : "");
  return ws.flatMap((w, i): Scanned[] => {
    const m = NUM.exec(core(w.text));
    if (!m) return [];
    const n = Number(m[1]);
    const of = (u: string) => (u.startsWith("day") ? "days" : u.startsWith("week") ? "weeks" : u.startsWith("month") ? "months" : "years");
    if (m[2] === "%") return [{ i, n, unit: "pct", words: [w], printed: `${m[1]}%` }];
    if (m[3]) return [{ i, n, unit: of(m[3].toLowerCase()), words: [w], printed: m[1]! }];
    if (word(ws[i + 1]) === "%" || word(ws[i + 1]) === "percent") return [{ i, n, unit: "pct", words: [w, ws[i + 1]!], printed: `${m[1]}%` }];
    const k = /^(?:calendar|business|working)$/.test(word(ws[i + 1])) ? i + 2 : i + 1;
    if (UNIT_WORD.test(word(ws[k]))) return [{ i, n, unit: of(word(ws[k])), words: ws.slice(i, k + 1), printed: m[1]! }];
    return [{ i, n, unit: word(ws[i - 1]) === "net" ? "days" : null, words: [w], printed: m[1]! }];
  });
}

// "not to exceed ten (10)", "up to a total of 5", "$500 maximum": the number a cap is stated as.
const LIMIT_BEFORE = /\b(?:up to|maximum(?: of)?|max\.?|not to exceed|no more than|exceed(?:s|ing)?|limit(?:ed)? (?:of|to)|cap(?:ped)? (?:of|at)|blocks? of)(?: [^\d\s]+){0,3}$/i;
const LIMIT_AFTER = /^(?:max(?:imum)?|cap|limit)\b/i;
const limited = (ws: Word[], from: number, to: number) => LIMIT_BEFORE.test(txt(ws.slice(Math.max(0, from - 7), from))) || LIMIT_AFTER.test(ws[to + 1]?.text ?? "");

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const month = (s: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(s.slice(0, 3).toLowerCase()) + 1;
/** The ISO date of a calendar day, or null when there is none (31 June). Two-digit years are 20xx. */
const iso = (y: number, m: number, d: number) => {
  const year = y < 100 ? 2000 + y : y;
  const t = new Date(Date.UTC(year, m - 1, d));
  return t.getUTCFullYear() === year && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};
/**
 * How contracts print a date: 2025-08-22 · August 22, 2025 · Aug. 22nd 2025 · 22 August 2025 · 22-Aug-25 · the 22nd day of
 * August, 2025 · 8/22/2025 · 22.08.2025. All in numbers, it's read both ways (month/day and day/month): only a day over 12
 * or the same number twice makes it one date.
 * ponytail: dates in words ("the twenty-second day") aren't read; such a date is asked. Upgrade: number words.
 */
const DATES: [RegExp, (m: RegExpExecArray) => (string | null)[]][] = [
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m) => [iso(+m[1]!, +m[2]!, +m[3]!)]],
  [new RegExp(`\\b${MONTH}\\s?(\\d{1,2})(?:st|nd|rd|th)?,?\\s?(\\d{4})\\b`, "gi"), (m) => [iso(+m[3]!, month(m[1]!), +m[2]!)]],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s(?:day\\s)?of)?[\\s-]?${MONTH},?[\\s-]?(\\d{4}|\\d{2})\\b`, "gi"), (m) => [iso(+m[3]!, month(m[2]!), +m[1]!)]],
  [/\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/g, (m) => [iso(+m[4]!, +m[1]!, +m[3]!), iso(+m[4]!, +m[3]!, +m[1]!)]],
];
/** The dates printed in a text, first reading first, with where each sits. */
function datesIn(s: string): { values: string[]; printed: string; from: number; to: number }[] {
  const out: { values: string[]; printed: string; from: number; to: number }[] = [];
  for (const [re, read] of DATES)
    for (const m of s.matchAll(re)) {
      const [from, to] = [m.index, m.index + m[0].length];
      const values = [...new Set(read(m).filter((v): v is string => v !== null))];
      if (values.length && !out.some((d) => d.from < to && from < d.to)) out.push({ values, printed: m[0], from, to });
    }
  return out;
}
function dates(ws: Word[]): { words: Word[]; values: string[]; printed: string }[] {
  const starts: number[] = [];
  const s = ws.reduce((acc, w, i) => (starts.push(acc.length + (i ? 1 : 0)), acc + (i ? " " : "") + w.text), "");
  return datesIn(s).map(({ values, printed, from, to }) => ({ words: ws.filter((w, i) => starts[i]! < to && starts[i]! + w.text.length > from), values, printed }));
}

/**
 * The ISO date a printed text says ("Aug. 22nd, 2025" → "2025-08-22"), as the binder reads it; null unless it holds exactly
 * one date that can be read only one way. For comparing a typed date with a value's `printed` text.
 */
export function isoDate(text: string): string | null {
  const d = datesIn(text);
  return d.length === 1 && d[0]!.values.length === 1 ? d[0]!.values[0]! : null;
}

/** The figures of one kind in some words of a page. A cap is the number stated as a limit ("up to 10"), else the only plain number. */
function figures(pg: Page, ws: Word[], unit: Unit): Figure[] {
  const fig = (words: Word[], values: (number | string)[], printed: string): Figure => ({ words, values, printed, at: boxOf(pg.p, words) });
  if (unit === "date") return dates(ws).map((d) => fig(d.words, d.values, d.printed));
  const money = amounts(ws, false, pg.before);
  if (unit === "cents") return money.filter((a) => limited(ws, ws.indexOf(a.words[0]!), ws.indexOf(a.words.at(-1)!))).map((a) => fig(a.words, [a.cents], txt(a.words)));
  const taken = new Set([...money, ...dates(ws)].flatMap((x) => x.words));
  const nums = scan(ws).filter((x) => !x.words.some((w) => taken.has(w)));
  if (unit === "pct" || unit === "days" || unit === "months") return nums.filter((x) => x.unit === unit).map((x) => fig(x.words, [x.n], x.printed));
  const plain = nums.filter((x) => x.unit === null);
  if (unit === "count") {
    const caps = plain.filter((x) => limited(ws, x.i, x.i));
    return (caps.length ? caps : plain.filter((x) => Number.isInteger(x.n))).map((x) => fig(x.words, [x.n], x.printed));
  }
  // ratio: "1:3", or "1 screen failure per 3 randomized", "one (1) for every three (3)": the first number over the second
  // ponytail: other ways of writing a ratio find none, so the value is asked.
  const colon = ws.flatMap((w) => {
    const m = /^(\d+)\s?:\s?(\d+)$/.exec(core(w.text));
    return m && +m[2]! ? [fig([w], [+m[1]! / +m[2]!], core(w.text))] : [];
  });
  const per = plain.flatMap((a) => {
    const b = plain.find((x) => x.i > a.i && x.i - a.i <= 10);
    const between = b ? txt(ws.slice(a.i + 1, b.i)) : "";
    return b && b.n && /\b(?:per|for (?:every|each))\b/i.test(between) ? [fig(ws.slice(a.i, b.i + 1), [a.n / b.n], txt(ws.slice(a.i, b.i + 1)))] : [];
  });
  return [...colon, ...per];
}

// ---------- binding ----------

/**
 * The words a rule's sentence must have, as the 4 contracts word each term (their quotes and the COPD original) and the
 * prompt names it. Prefixes: "pay" covers payment and payable, "overpa" overpaid, "submi" submitted.
 * ponytail: dates and invoiceable caps have no word of their own here (an amendment says "effective" of the agreement it
 * amends too), so they bind on the quote alone. Upgrade: words measured on the held-out set.
 */
const ABOUT = {
  netDays: /\b(?:pay|paid|invoic|net\b)/i,
  due: /\b(?:pay|paid|due\b|invoic)/i,
  refund: /\b(?:refund|overpa|over-pa)/i,
  holdback: /\b(?:hold|held\b|withh|retain|retention|final\b)/i,
  overhead: OVERHEAD,
  screenFail: /\bscreen/i,
  deadline: {
    invoice_days_from_expense: /\b(?:invoic|submi)/i,
    invoice_months_after_study_close: /\b(?:invoic|submi)/i,
    final_invoice_days_after_closeout: /\b(?:invoic|submi)/i,
    query_resolution_days: /\bquer/i,
    dispute_days_after_final_payment: /\bdisput/i,
    edc_entry_business_days: /\b(?:edc|e?crfs?|data|entry|enter)/i,
  } satisfies Record<Rulebook["deadlines"][number]["kind"], RegExp>,
};

export type Bound = { evidence: ValueEvidence[]; unaccounted: Span[] };

export function bindEvidence(rulebook: Rulebook, pages: TextPage[]): Bound {
  const data = new Map(pages.filter((p) => p.source === "text").map((p) => [`${p.documentId}#${p.page}`, pageData(p)]));
  const pageAt = (src: Provenance["source"]) => (src ? data.get(`${src.documentId}#${src.page}`) : undefined);
  const evidence: ValueEvidence[] = [];
  const bound = new Set<Word>();
  const put = (path: string, status: ValueEvidence["status"], where: PageBox[], printed: string | null, note: string | null = null, used: Word[] = []) => {
    used.forEach((w) => bound.add(w));
    evidence.push({ path, status, where, printed, note });
  };
  const nowhere = (src: Provenance["source"]): PageBox[] => (src ? [{ documentId: src.documentId, page: src.page, box: null }] : []);
  /**
   * A value against the figures of its kind printed where it's stated: confirmed only when every one of them says exactly
   * this value. When they differ, which one is this value's can't be told, so it's asked; when none says it, a conflict.
   */
  const settle = (path: string, value: number | string, figs: Figure[], fallback: PageBox[]) => {
    const own = figs.filter((f) => f.values.includes(value));
    const one = figs.every((f) => f.values.length === 1 && f.values[0] === figs[0]!.values[0]);
    if (own.length && own.length === figs.length && one) return put(path, "confirmed", [own[0]!.at], own[0]!.printed, null, own.flatMap((f) => f.words));
    if (own.length) return put(path, "ungrounded", fallback, null, own.some((f) => f.values.length > 1) ? "the date can be read as month/day or day/month" : "printed with another figure of the same kind, so which one it is can't be told", own.flatMap((f) => f.words));
    if (figs.length && one) return put(path, "conflict", [figs[0]!.at], figs[0]!.printed, null, figs.flatMap((f) => f.words));
    put(path, figs.length ? "conflict" : "ungrounded", fallback, null);
  };

  // Each grid's columns on each of its pages. Grids that share a page and head their tables with the same visits take
  // distinct header lines, in the order the read lists them; a grid's rows are then the lines under its own header.
  // ponytail: two such tables read in the opposite order swap bands (their cells conflict unless both read the same
  // numbers). Upgrade: match each grid's printed title above its header.
  const headersOn = new Map<string, Line[]>();
  const claimed: { row: Line; header: Line; visits: Set<string> }[] = [];
  const layout = rulebook.budgetGrids.map((g) => {
    const pagesOf = [...new Set([...g.procedures, ...g.visits].flatMap((x) => (x.prov.source ? [`${x.prov.source.documentId}#${x.prov.source.page}`] : [])))].sort((a, b) => Number(a.split("#")[1]) - Number(b.split("#")[1]));
    // A continuation page without its own header uses the columns of the grid page before it.
    // ponytail: assumes continuation pages keep the layout; a changed layout gives conflicts, not confirmations.
    const colsOn = new Map<string, Cols | null>();
    let last: Cols | null = null;
    for (const k of pagesOf) {
      const pg = data.get(k);
      const own = pg && headerColumns(pg, g.visits, headersOn.get(k));
      if (own) headersOn.set(k, [...(headersOn.get(k) ?? []), own.line]);
      last = own || last;
      colsOn.set(k, pg ? last : null);
    }
    return { pagesOf, colsOn };
  });

  rulebook.budgetGrids.forEach((g, gi) => {
    const gp = `/budgetGrids/${gi}`;
    const { pagesOf, colsOn } = layout[gi]!;
    const ctx = (src: Provenance["source"]) => {
      const pg = pageAt(src);
      const k = src ? `${src.documentId}#${src.page}` : "";
      const cols = colsOn.get(k);
      if (!pg || !cols) return null;
      // With another grid's header on the page, this grid's rows run from its own header down to the next one.
      const others = pg.lines.includes(cols.line) ? (headersOn.get(k) ?? []).filter((h) => h !== cols.line && h.dir === cols.dir) : [];
      const end = Math.min(...others.filter((h) => h.v > cols.line.v).map((h) => h.v));
      const band = (l: Line) => !others.length || (l.dir === cols.dir && l.v > cols.line.v && l.v < end);
      const lines = pg.lines.filter(band);
      const cands = lines.filter((l) => l.dir === cols.dir && l.words.some((w) => (NUMBER.test(bare(w.text)) || /invoic/i.test(w.text)) && columnOf(cols, w)));
      return { pg, cols, lines, band, cands };
    };
    const cell = (path: string, c: NonNullable<ReturnType<typeof ctx>>, row: Line, key: string, value: number | "invoiceable", used: Word[] = []) => {
      const ws = cellWords(c.cols, row, key);
      const printed = ws.length ? txt(ws) : null;
      const ok = value === "invoiceable" ? /invoic/i.test(printed ?? "") : cents(printed) === value;
      put(path, ok ? "confirmed" : "conflict", [boxOf(c.pg.p, ws.length ? ws : row.words)], printed, null, [...ws, ...used]);
    };

    // Grid cells, by the row's label and the visit's column. One printed row per item: best label matches claim rows first.
    const options = g.procedures.flatMap((p, pi) => {
      const c = ctx(p.prov.source);
      return c ? rowsFor(c.lines, c.cands, p.code, p.name, c.cols.left).map((o) => ({ ...o, pi, header: c.cols.line })) : [];
    });
    const rowOf = new Map<number, Option>();
    const procRows = new Set<Line>();
    // Under a header another grid with the same visits uses too (it continues onto the page where this one starts), a
    // row that grid holds isn't this grid's: each printed cell confirms one grid's value at most.
    const visits = new Set(g.visits.map((v) => v.code));
    const theirs = (o: (typeof options)[number]) => claimed.some((c) => c.row === o.row && c.header === o.header && [...c.visits].some((v) => visits.has(v)));
    for (const o of options.sort((a, b) => b.score - a.score)) if (!rowOf.has(o.pi) && !procRows.has(o.row) && !theirs(o)) (rowOf.set(o.pi, o), procRows.add(o.row));
    for (const o of options) if (rowOf.get(o.pi) === o) claimed.push({ row: o.row, header: o.header, visits });
    g.procedures.forEach((p, pi) => {
      const pp = `${gp}/procedures/${pi}`;
      const c = ctx(p.prov.source);
      const found = rowOf.get(pi);
      // Numbers outside the price columns of a row the master holds (code, count) belong to that row; they aren't prices.
      if (c && found) for (const w of found.row.words) if (NUMBER.test(bare(w.text)) && frame(w)[2] <= c.cols.left && !columnOf(c.cols, w)) bound.add(w);
      const entries: [string, string, number | "invoiceable"][] = Object.entries(p.cells).map(([k, v]) => [`${pp}/cells/${ptr(k)}`, k, v]);
      if (p.unitCents !== null) entries.push([`${pp}/unitCents`, "#unit", p.unitCents]);
      for (const [path, key, value] of entries) {
        if (!c || !found || (key === "#unit" ? !c.cols.unit : !c.cols.at.has(key))) put(path, "ungrounded", found && c ? [boxOf(c.pg.p, found.row.words)] : nowhere(p.prov.source), null);
        else cell(path, c, found.row, key, value, found.code ? [found.code] : []);
      }
    });

    // Visit totals and subtotals: rows found by their printed label.
    const LABELS: Record<"totalCents" | "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents", (s: string) => boolean> = {
      totalCents: (s) => /\btotal/i.test(s) && !/sub[\s-]?total|patient|subject/i.test(s),
      procedureSubtotalCents: (s) => /sub[\s-]?total/i.test(s) && !/non[\s-]?proc/i.test(s),
      nonProcedureCents: (s) => /non[\s-]?proc/i.test(s),
      overheadCents: (s) => OVERHEAD.test(s) && !/\btotal/i.test(s),
    };
    g.visits.forEach((v, vi) => {
      const c = ctx(v.prov.source);
      for (const f of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        const value = v[f];
        if (value === null) continue;
        const path = `${gp}/visits/${vi}/${f}`;
        const rows = c ? c.cands.filter((l) => !procRows.has(l) && LABELS[f](txt(l.words.filter((w) => frame(w)[2] <= c.cols.left)))) : [];
        // ponytail: a subtotal the grid doesn't print as its own row is ungrounded; arithmetic checks it. Upgrade: confirm it from the printed cells it sums.
        if (c && rows.length === 1) cell(path, c, rows[0]!, v.code, value);
        else put(path, "ungrounded", nowhere(v.prov.source), null, rows.length > 1 ? "several rows carry this label" : null);
      }
    });
    g.perPatientTotals.forEach((t, ti) => item(`${gp}/perPatientTotals/${ti}`, null, t.label, t.prov, [["cents", t.cents]], ctx(t.prov.source)?.band));

    // The overhead % the grid states: a % within 3 words of "overhead" on a line of the grid's pages ("Overhead (30%)",
    // "30% overhead", "Indirect costs @ 30%"), so another % on the same line can't back it.
    if (g.statedOverheadPct !== null) {
      const own = [...new Set([...pagesOf, ...(g.prov.source ? [`${g.prov.source.documentId}#${g.prov.source.page}`] : [])])].flatMap((k) => data.get(k) ?? []);
      const near = (l: Line, f: Figure) => {
        const [a, b] = [l.words.indexOf(f.words[0]!), l.words.indexOf(f.words.at(-1)!)];
        return OVERHEAD.test(txt(l.words.slice(Math.max(0, a - 3), b + 4)));
      };
      const figs = own.flatMap((pg) => pg.lines.flatMap((l) => figures(pg, l.words, "pct").filter((f) => near(l, f))));
      settle(`${gp}/statedOverheadPct`, g.statedOverheadPct, figs, nowhere(g.prov.source ?? g.visits[0]?.prov.source ?? null));
    }
  });

  /**
   * Label + amount on one row of the cited page, or the amount inside the quote; else a wrong page reference. `within`:
   * the lines the row may be on (a grid's band, when another grid shares the page).
   */
  function item(base: string, code: string | null, name: string, prov: Provenance, fields: [string, number | null][], within: (l: Line) => boolean = () => true) {
    const src = prov.source;
    const pg = pageAt(src);
    const lineAmounts = (pg: Page) => pg.lines.filter((l) => within(l) && amounts(l.words).length);
    const found = pg ? rowsFor(pg.lines.filter(within), lineAmounts(pg), code, name)[0] : undefined;
    // Numbers on the item's row other than amounts and figures with a unit (code, count) belong to it; "30 days" or "10%" is a term of its own.
    const rowNumbers = (l: Line) => {
      const units = new Set(scan(l.words).flatMap((x) => (x.unit ? x.words : [])));
      return l.words.filter((w) => NUMBER.test(bare(w.text)) && !units.has(w) && !amounts(l.words).some((a) => a.words.includes(w)));
    };
    const onRow = found ? amounts(found.row.words, false, pg!.before) : [];
    if (found) rowNumbers(found.row).forEach((w) => bound.add(w));
    const quote = pg ? findQuote(pg, src?.quote) : null;
    const inQuote = quote ? amounts(quote, false, pg!.before) : [];
    const want = fields.filter((f): f is [string, number] => f[1] !== null);
    // Two prices and two amounts on the row (or in the quote): by position, base price then price with overhead, as tables print them.
    // ponytail: a table printing them the other way round gives conflicts. Upgrade: read the order from the column headers.
    const positional = want.length === 2 && onRow.length >= 2;
    // One amount wanted, a row printing others too ("$500.00, up to $5,000.00"; "$100.00 $130.00" with one of them read):
    // which one is this value can't be told, so as settle() does, it's asked, and the others stay unaccounted.
    const alone = (as: { cents: number }[], value: number, i: number) => (want.length === 2 && as.length >= 2 ? as[i]!.cents === value : as.every((a) => a.cents === value));
    want.forEach(([field, value], i) => {
      const path = `${base}/${field}`;
      const spot = positional ? onRow[i] : onRow.find((a) => a.cents === value);
      const used = found?.code ? [found.code] : [];
      if (spot?.cents === value && !alone(onRow, value, i))
        return put(path, "ungrounded", [boxOf(pg!.p, found!.row.words)], null, "printed with another amount on the same line, so which one it is can't be told", [...onRow.filter((a) => a.cents === value).flatMap((a) => a.words), ...used]);
      if (spot?.cents === value) return put(path, "confirmed", [boxOf(pg!.p, spot.words)], txt(spot.words), null, [...spot.words, ...used]);
      if (onRow.length) {
        const shown = positional ? [onRow[i]!] : onRow.filter((a) => !want.some(([, c]) => c === a.cents));
        return put(path, "conflict", [boxOf(pg!.p, found!.row.words)], txt(shown.flatMap((a) => a.words)) || null, null, [...onRow.flatMap((a) => a.words), ...used]);
      }
      if (inQuote.length) {
        const figs = (want.length === 2 && inQuote.length === 2 ? [inQuote[i]!] : inQuote).map((a) => ({ words: a.words, values: [a.cents], printed: txt(a.words), at: boxOf(pg!.p, a.words) }));
        return settle(path, value, figs, [boxOf(pg!.p, quote!)]);
      }
      // Wrong page reference: label and this amount on one line of exactly one other page of the same document.
      const elsewhere = [...data.values()].flatMap((o) => {
        if (!src || o.p.documentId !== src.documentId || o.p.page === src.page) return [];
        const lines = o.lines.filter((l) => {
          const as = amounts(l.words, false, o.before);
          return rowsFor([l], [l], code, name).length && as.some((a) => a.cents === value) && alone(as, value, i);
        });
        return lines.length ? [{ o, l: lines[0]! }] : [];
      });
      if (elsewhere.length === 1) {
        const { o, l } = elsewhere[0]!;
        const a = amounts(l.words, false, o.before).find((x) => x.cents === value)!;
        return put(path, "confirmed", [boxOf(o.p, a.words)], txt(a.words), `page reference corrected from ${src!.page} to ${o.p.page}`, [...a.words, ...rowNumbers(l)]);
      }
      put(path, "ungrounded", nowhere(src), null);
    });
  }

  rulebook.invoiceables.forEach((x, i) => item(`/invoiceables/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents], ["amountWithOverheadCents", x.amountWithOverheadCents]]));
  rulebook.siteFees.forEach((x, i) => item(`/siteFees/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents]]));
  if (rulebook.screenFail) item("/screenFail", null, "screen failure", rulebook.screenFail.prov, [["amountCents", rulebook.screenFail.amountCents]]);

  /**
   * Rules (%, days, caps, dates): the value must be the figure of its kind inside a quote that matches the cited page word
   * for word, in a sentence about the term (`about`): "within 30 days" quoted from the refund clause can't back the
   * payment term. A quote that isn't on that page, or holds no such figure, leaves the value to be typed.
   * ponytail: a rule given without a quote is asked, not looked up by its wording. Upgrade: a label line, as fees have.
   */
  const rule = (path: string, value: number | string | null | undefined, prov: Provenance | undefined, unit: Unit, about?: RegExp) => {
    if (value === null || value === undefined || !prov) return;
    const pg = pageAt(prov.source);
    const quote = pg ? findQuote(pg, prov.source?.quote) : null;
    if (!pg || !quote) return put(path, "ungrounded", nowhere(prov.source), null);
    const all = figures(pg, quote, unit);
    const figs = about ? all.filter((f) => about.test(pg.sentence(f.words[0]!))) : all;
    // Not boxed: the quoted clause is the wrong one to show the person typing the value.
    if (all.length && !figs.length) return put(path, "ungrounded", nowhere(prov.source), null, "the quote isn't from a sentence about this term");
    settle(path, value, figs, [boxOf(pg.p, quote)]);
  };
  const cap = (base: string, c: Rulebook["invoiceables"][number]["cap"], prov: Provenance, about?: RegExp) => {
    rule(`${base}/cap/n`, c.n, prov, c.kind === "amount" ? "cents" : "count", about);
    rule(`${base}/cap/ratio`, c.ratio, prov, "ratio", about);
  };
  rule("/study/effectiveDate/value", rulebook.study.effectiveDate.value, rulebook.study.effectiveDate.prov, "date");
  rule("/appliesFrom/value", rulebook.appliesFrom.value, rulebook.appliesFrom.prov, "date");
  rule("/overhead/pct/value", rulebook.overhead.pct.value, rulebook.overhead.pct.prov, "pct", ABOUT.overhead);
  rule("/holdback/pct", rulebook.holdback?.pct, rulebook.holdback?.prov, "pct", ABOUT.holdback);
  rule("/payment/netDays/value", rulebook.payment.netDays.value, rulebook.payment.netDays.prov, "days", ABOUT.netDays);
  rulebook.deadlines.forEach((d, i) => rule(`/deadlines/${i}/value`, d.value, d.prov, d.kind.includes("months") ? "months" : "days", ABOUT.deadline[d.kind]));
  rule("/overpayment/refundDays", rulebook.overpayment?.refundDays, rulebook.overpayment?.prov, "days", ABOUT.refund);
  rulebook.siteFees.forEach((x, i) => rule(`/siteFees/${i}/dueDays`, x.dueDays, x.prov, "days", ABOUT.due));
  rulebook.invoiceables.forEach((x, i) => cap(`/invoiceables/${i}`, x.cap, x.prov));
  if (rulebook.screenFail) cap("/screenFail", rulebook.screenFail.cap, rulebook.screenFail.prov, ABOUT.screenFail);

  const unaccounted = inventory(pages).filter((s) => !s.words.some((w) => bound.has(w)));
  return { evidence, unaccounted };
}

// ---------- review queue ----------

const DEADLINE: Record<Rulebook["deadlines"][number]["kind"], string> = {
  invoice_days_from_expense: "Within how many days of an expense must it be invoiced?",
  invoice_months_after_study_close: "Within how many months after the study closes must the last invoices be sent?",
  final_invoice_days_after_closeout: "Within how many days after close-out must the final invoice be sent?",
  query_resolution_days: "Within how many days must data queries be resolved?",
  dispute_days_after_final_payment: "Within how many days after the final payment can a payment be disputed?",
  edc_entry_business_days: "Within how many business days must visit data be entered?",
};
const VISIT_FIELD: Record<string, string> = { totalCents: "total", procedureSubtotalCents: "procedure subtotal", overheadCents: "overhead", nonProcedureCents: "non-procedure subtotal" };

/** The question for one value, never the value itself (blind entry): amounts and % inside a name are blanked too. */
function ask(rb: Rulebook, path: string): Pick<ReviewItem, "question" | "input"> {
  const q = (s: string) => `"${s.replace(AMOUNT_IN_NAME, "…").trim()}"`;
  const [, top, i, sub, j, field, key] = path.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const money = (question: string) => ({ question, input: "money" as const });
  const number = (question: string) => ({ question, input: "number" as const });
  // `many`: "times can "Re-consent" be billed" or "screen failures can be billed"; `what`: what an amount cap is the most for.
  const capOf = (c: Rulebook["invoiceables"][number]["cap"], many: string, what: string, f: string | undefined) =>
    f === "ratio" ? number(`How many ${many} for each randomized subject?`)
    : c.kind === "amount" ? money(`What is the most that can be billed for ${what}?`)
    : number(c.kind === "blocks_with_reauth" ? `How many ${many} before the sponsor has to approve more?` : `How many ${many} at most?`);
  if (top === "budgetGrids") {
    const g = rb.budgetGrids[Number(i)]!;
    if (sub === "statedOverheadPct") return { question: `What overhead percentage is printed on the budget grid ${q(g.label)}?`, input: "percent" };
    if (sub === "procedures") {
      const p = g.procedures[Number(j)]!;
      if (field === "unitCents") return money(`What unit price is printed for ${q(p.name)}?`);
      return money(`What amount is printed for ${q(p.name)} at ${g.visits.find((v) => v.code === key)?.name || key}?`);
    }
    if (sub === "visits") return money(`What amount is printed for the ${g.visits[Number(j)]!.name} ${VISIT_FIELD[field!] ?? "amount"}?`);
    return money(`What amount is printed for ${q(g.perPatientTotals[Number(j)]!.label)}?`);
  }
  if (top === "invoiceables" || top === "siteFees") {
    const x = (top === "invoiceables" ? rb.invoiceables : rb.siteFees)[Number(i)]!;
    if (sub === "cap" && "cap" in x) return capOf(x.cap, `times can ${q(x.name)} be billed`, q(x.name), j);
    if (sub === "dueDays") return number(`Within how many days is ${q(x.name)} due?`);
    return money(`What amount${sub === "amountWithOverheadCents" ? " including overhead" : ""} is printed for ${q(x.name)}?`);
  }
  if (top === "screenFail") return i === "cap" ? capOf(rb.screenFail!.cap, "screen failures can be billed", "screen failures", sub) : money("What amount is printed for a screen failure?");
  if (top === "overhead") return { question: "What overhead percentage does the contract state?", input: "percent" };
  if (top === "holdback") return { question: "What percentage of each payment is held back?", input: "percent" };
  if (top === "payment") return number("Within how many days must an invoice be paid?");
  if (top === "deadlines") return number(DEADLINE[rb.deadlines[Number(i)]!.kind]);
  if (top === "overpayment") return number("Within how many days must an overpayment be paid back?");
  if (top === "study") return { question: "What effective date does the contract give?", input: "date" };
  if (top === "appliesFrom") return { question: "From what date do the new terms apply?", input: "date" };
  return { question: "What does the contract say for this value?", input: "text" };
}

// No "add it to the master": nothing can add a value to a read draft, so picking it would drop the term silently.
const UNACCOUNTED_OPTIONS = [
  { id: "bill_by_hand", label: "A payment term: list it to bill by hand" },
  { id: "not_payment", label: "Not a payment term" },
  { id: "covered", label: "Already covered by another line" },
];

/**
 * The review queue for a draft: a blind "type what the page says" item for every value the text didn't confirm, and
 * one item per line or sentence of the contract with money terms the master doesn't hold.
 */
export function reviewFromEvidence(evidence: ValueEvidence[], unaccounted: Span[], rulebook: Rulebook): ReviewItem[] {
  const base = { answer: null, outcome: null, compare: null, blocking: true, sentBack: null } as const;
  const confirm: ReviewItem[] = evidence
    .filter((e) => e.status === "conflict" || e.status === "ungrounded")
    .map((e) => ({ ...base, id: `confirm:${e.path}`, kind: "confirm_value", reason: e.status === "conflict" ? "VALUE_CONFLICT" : "UNGROUNDED_VALUE", path: e.path, ...ask(rulebook, e.path), options: [], where: e.where }));
  // One item per line or sentence: a row the master missed is one question, not one per number.
  const groups = new Map<string, Span[]>();
  for (const s of unaccounted) {
    const k = `${s.where.documentId}#${s.where.page}#${s.kind === "grid_number" || s.kind === "amount" ? "row" : "term"}#${s.text}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const perPage = new Map<string, number>();
  const terms: ReviewItem[] = [...groups.values()].map((ss) => {
    const { documentId, page } = ss[0]!.where;
    const n = perPage.get(`${documentId}#${page}`) ?? 0;
    perPage.set(`${documentId}#${page}`, n + 1);
    const what = ss[0]!.kind === "absence" ? "mentions a payment condition" : ss[0]!.kind === "grid_number" || ss[0]!.kind === "amount" ? `has ${ss.length > 1 ? "amounts" : "an amount"}` : "has a payment term";
    return {
      ...base,
      id: `unaccounted:${documentId}:${page}:${n}`,
      kind: "unaccounted",
      reason: "UNACCOUNTED_TERM",
      path: null,
      question: `Page ${page} ${what} that the invoicing master doesn't have: "${ss[0]!.text.replace(/[.;:,]$/, "")}". How should it be handled?`,
      input: null,
      options: UNACCOUNTED_OPTIONS,
      where: ss.map((s) => s.where),
      // the quote is the whole line or sentence: blind entry checks every line it's printed on (quotesWithheld)
      quoted: [...new Map(ss.flatMap((s) => s.lines).map((l) => [JSON.stringify(l), l])).values()],
    };
  });
  return [...confirm, ...terms];
}
