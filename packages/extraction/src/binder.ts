import { type BlankCheck, type BudgetGrid, datesIn, type PageBox, type Provenance, type ReviewItem, ROW_ARITHMETIC, type Rulebook, type ValueEvidence } from "@dct/shared";
import { ocrCandidates } from "./candidates";
import { patientCounts, patientsTimes } from "./checks";
import { amounts, bare, boxOf, centsOf, frame, inventory, NUMBER, sentences, type Span, type TextPage, visualLines, type Word } from "./textlayer";

/**
 * Binder (ADR-001 §5), no AI: each money value in a rulebook is looked up at its own position in the PDF's text, and
 * every inventory span no value is bound to comes back as unaccounted.
 */

type Line = { words: Word[]; dir: Word["dir"]; v: number; h: number };
/** `before`: the word printed ahead of one, in the text's own order. `sentence`: the text of the sentence a word is in. */
type Page = { p: TextPage; lines: Line[]; orders: Word[][]; before: (w: Word) => Word | undefined; sentence: (w: Word) => string };
/** `numbers`: the number columns of the table under the header, to find the same columns on a continuation page. */
type Cols = { dir: Word["dir"]; at: Map<string, [number, number]>; unit: [number, number] | null; left: number; pitch: number; line: Line; numbers: [number, number][] };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const ptr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const cents = (s: string | null) => {
  const t = bare((s ?? "").replace(/\s/g, ""));
  return NUMBER.test(t) && !t.endsWith("%") ? centsOf(t) : null;
};
const txt = (ws: Word[]) => ws.map((w) => w.text).join(" ");
/**
 * Our OCR's usual misreadings ("$" as 5, a comma or colon for the point, a lost point: candidates.ts) are allowed for words of
 * OUR OCR only (page source "ocr"), never for a PDF's own text, which is exact. Every place the binder holds a read value up to
 * a printed word goes through `readOf` (or `says`/`saysAmount` for cells and amounts), so the rule is one rule. What stays on the
 * plain parse on purpose: the page agreeing with itself (a column's arithmetic, the overhead %, sums of printed cells, which
 * cost column is which), because noise must not build a pattern that confirms; and what makes a word clean enough to be a
 * conflict: a word whose plain parse is a price that matches no candidate is still a conflict.
 */
const NOISY = "the scan's digits were read allowing for its usual misreadings";
type Read = "plain" | "noisy" | null;
const readOf = (printed: string | null, value: number, ocr: boolean): Read => (cents(printed) === value ? "plain" : ocr && printed !== null && ocrCandidates(printed).has(value) ? "noisy" : null);
const saysAmount = (a: { words: Word[]; cents: number | null }, value: number, ocr: boolean): Read => (a.cents === value ? "plain" : ocr ? readOf(txt(a.words), value, true) : null);
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
 * a run of up to LABEL_LINES consecutive lines (left of `limit`) spelling most of the name in order, scored by the F1 of the
 * common subsequence (neighbouring rows' descriptions often differ in a word or two). Its row is the candidate (a line
 * carrying numbers) nearest the band, from one line above it to 5 line heights below, since labels sit on their row's
 * line or are centred on it; on the code's line when the item has a printed code. No name: a code printed on exactly one candidate.
 * Half the name isn't enough: one shared word ("visit" of "Unscheduled visit") would take another term's line.
 */
/** A row's name can wrap over many lines in a narrow first column (8 measured on a scanned budget table). */
const LABEL_LINES = 10;

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
    for (let k = i, ts: string[] = []; k < Math.min(ls.length, i + LABEL_LINES); k++) {
      const [cur, prev] = [ls[k]!.l, ls[k - 1]?.l];
      if (k > i && (cur.dir !== prev!.dir || cur.v - prev!.v > 2 * Math.max(cur.h, prev!.h))) break;
      ts = [...ts, ...ls[k]!.ts];
      const common = lcs(want, ts);
      const gap = (l: Line) => Math.max(0, first.l.v - l.v, l.v - cur.v);
      const row = common > want.length / 2 && pool.filter((l) => l.dir === first.l.dir && l.v >= first.l.v - 1.2 * first.l.h && l.v <= cur.v + 5 * cur.h).sort((a, b) => gap(a) - gap(b))[0];
      if (row) best.set(row, Math.max(best.get(row) ?? 0, (2 * common) / (want.length + ts.length)));
    }
  });
  if (!best.size && byCode.length === 1) best.set(byCode[0]!, 0);
  return [...best].map(([row, score]) => ({ row, code: codeOf(row), score })).sort((a, b) => b.score - a.score);
}

// ---------- grid columns ----------

const UNIT = /unit|cost|price|amount|rate|fee|budget/i;
/** Our OCR's confidence below which a word confirms nothing (ocr.ts). */
const MIN_OCR_CONF = 0.8;
const OVERHEAD = /overhead|indirect|f\s?&\s?a\b/i;

/**
 * A label as printed (normalized) against a visit's code or name: equal; or, `loose`, a name of 5+ characters with one
 * letter misread, as OCR of a scan does. Digits must agree exactly: they tell visits apart ("visit 10" is never "visit 11").
 */
function sameLabel(printed: string, target: string, loose: boolean): boolean {
  if (printed === target) return true;
  if (!loose || target.length < 5 || printed.replace(/\D/g, "") !== target.replace(/\D/g, "")) return false;
  let i = 0;
  while (i < printed.length && i < target.length && printed[i] === target[i]) i++;
  let j = 0;
  while (j < printed.length - i && j < target.length - i && printed.at(-1 - j) === target.at(-1 - j)) j++;
  return Math.max(printed.length, target.length) - i - j === 1;
}

/** Labels a visit may be printed as: its code exactly; its name, or code and name together, with one letter misread. */
const labelsOf = (v: BudgetGrid["visits"][number]): [string, boolean][] =>
  ([[v.code, false], [v.name, true], [`${v.code}${v.name}`, true], [`${v.name}${v.code}`, true]] as [string, boolean][]).map(([t, loose]): [string, boolean] => [norm(t), loose]).filter(([t]) => t);

/** Word runs on one line that spell one of the labels. */
function runs(l: Line, labels: [string, boolean][]): Word[][] {
  const max = Math.max(0, ...labels.map(([t]) => t.length + 1));
  const out: Word[][] = [];
  l.words.forEach((_, i) => {
    let s = "";
    for (let j = i; j < l.words.length && s.length < max; j++) {
      s += norm(l.words[j]!.text);
      if (labels.some(([t, loose]) => sameLabel(s, t, loose))) {
        out.push(l.words.slice(i, j + 1));
        break;
      }
    }
  });
  return out;
}

const span = (ws: Word[]): [number, number] => [Math.min(...ws.map((w) => frame(w)[0])), Math.max(...ws.map((w) => frame(w)[2]))];

/** A line's words cut into cells at gaps wider than the text is tall: a table's columns, as printed. */
const cellsOf = (ws: Word[]) =>
  ws.reduce<Word[][]>((cs, w, i) => {
    const prev = ws[i - 1];
    if (prev && frame(w)[0] - frame(prev)[2] < frame(w)[3] - frame(w)[1]) cs.at(-1)!.push(w);
    else cs.push([w]);
    return cs;
  }, []);

/**
 * Header cells stacked over two or three lines ("Visit 1" above "Day 1"), with their top on line `l`: each line's words
 * are cut into cells (cellsOf), and cells on `l` and the lines just below it that overlap along the text are one column.
 * Read top to bottom.
 */
function stacked(pg: Page, l: Line): Word[][] {
  // the header ends where the table's prices start
  const below = pg.lines.filter((x) => x.dir === l.dir && x.v >= l.v && x.v - l.v <= 2.5 * l.h).sort((a, b) => a.v - b.v);
  const end = below.findIndex((x) => x.words.some(priceLike));
  const lines = end < 0 ? below : below.slice(0, end);
  if (lines.length < 2) return [];
  const cells = lines.flatMap((x) => cellsOf(x.words));
  const cols: Word[][][] = [];
  for (const c of cells) {
    const [u0, u1] = span(c);
    const col = cols.find((cs) => cs.some((x) => Math.min(span(x)[1], u1) - Math.max(span(x)[0], u0) > 0));
    if (col) col.push(c);
    else cols.push([c]);
  }
  return cols.filter((cs) => cs.length > 1 && cs[0]!.some((w) => l.words.includes(w))).map((cs) => cs.flat());
}

type Span2 = [number, number];
const mid2 = (s: Span2) => (s[0] + s[1]) / 2;

/**
 * Columns run in visit order. A label printed again elsewhere ("Day 1" in another visit's header) would put a visit in
 * another visit's column, where the same price often stands: of each visit's candidate spots, keep the most visits whose
 * columns run in visit order (the spots nearest the header line on a tie). A visit out of that order has no column, so
 * its cells are asked.
 */
function inOrder(visits: BudgetGrid["visits"], cands: (i: number) => { at: Span2; off: number }[]): Map<string, Span2> {
  type Pick = { code: string; at: Span2; n: number; off: number; prev: Pick | null };
  const ends: Pick[] = [];
  let best: Pick | null = null;
  for (const { v, i } of visits.map((v, i) => ({ v, i })).sort((a, b) => a.v.order - b.v.order)) {
    const made = cands(i).map((c): Pick => {
      const prev = ends.filter((e) => e.at[1] <= mid2(c.at) && mid2(e.at) < c.at[0]).sort((a, b) => b.n - a.n || a.off - b.off)[0] ?? null;
      return { code: v.code, at: c.at, n: (prev?.n ?? 0) + 1, off: (prev?.off ?? 0) + c.off, prev };
    });
    for (const m of made) {
      ends.push(m);
      if (!best || m.n > best.n || (m.n === best.n && m.off < best.off)) best = m;
    }
  }
  const at = new Map<string, Span2>();
  for (let p = best; p; p = p.prev) at.set(p.code, p.at);
  return at;
}

/** A number printed like money: with cents, a thousands comma or a dollar sign. */
const priceLike = (w: Word) => NUMBER.test(bare(w.text)) && /\$|\d,\d{3}|\.\d{2}\)?$/.test(bare(w.text));
/**
 * The numbers of a table row: none unless the line prints money, then every number but a visit's tag ("Visit 12",
 * "Week 4": a plain number after a word). A header's "1 2 3" isn't a row.
 */
const cellNumbers = (l: Line) =>
  l.words.some(priceLike) ? l.words.filter((w, i) => NUMBER.test(bare(w.text)) && (priceLike(w) || !/^[a-z]+$/i.test(l.words[i - 1]?.text ?? ""))) : [];

/** A table's number columns along the text: the numbers of its rows (cellNumbers), merged where they overlap, in order. */
function numberColumns(lines: Line[]): Span2[] {
  const spans = lines.flatMap((l) => {
    const ns = cellNumbers(l);
    return ns.length >= 3 ? ns.map((w) => span([w])) : [];
  });
  const out: [number, number, number][] = [];
  for (const s of spans.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s[0] <= last[1]) (last[1] = Math.max(last[1], s[1]), last[2]++);
    else out.push([s[0], s[1], 1]);
  }
  return out.map(([a, b]): Span2 => [a, b]);
}

/** "Visit 2", "Week 12", "Day-1": a word and the number after it, which tell one visit from another. */
const tagsOf = (s: string) => new Set([...s.toLowerCase().matchAll(/([a-z]+)\s*[-#.:]?\s*(\d+)/g)].map((m) => m[1]! + m[2]!));

/**
 * When the read's visit names aren't printed as such (it joins a phase heading spanning several columns to each visit's
 * own header, or makes up a short code), the columns come from the table itself: its number columns, and the header
 * words printed above each. A visit takes a column whose header carries every tag of its name ("week12"), or, for a name
 * without one, its whole name; only when that column is the visit's alone and the visit has no other. Still in visit order.
 * ponytail: one table per page; a second table's columns could be taken. Upgrade: bound the region by the grid's title.
 */
function byTags(pg: Page, visits: BudgetGrid["visits"]): { at: Map<string, Span2>; h: Line } | null {
  const dirs = [0, 1, 2, 3].map((d) => pg.lines.filter((l) => l.dir === d && cellNumbers(l).length >= 3));
  const data = dirs.reduce((a, b) => (b.length > a.length ? b : a));
  if (data.length < 2) return null;
  const topV = Math.min(...data.map((l) => l.v));
  const lh = data.map((l) => l.h).sort((a, b) => a - b)[Math.floor(data.length / 2)]!;
  const head = pg.lines.filter((l) => l.dir === data[0]!.dir && l.v < topV && topV - l.v <= 12 * lh);
  const cols = numberColumns(data);
  if (!head.length || cols.length < 2) return null;
  const pitch = Math.min(...cols.slice(1).map((c, i) => mid2(c) - mid2(cols[i]!)));
  const text = cols.map((c) => norm(head.flatMap((l) => l.words.filter((w) => Math.abs(mid2(span([w])) - mid2(c)) <= pitch / 2)).map((w) => w.text).join(" ")));
  const raw = cols.map((c) => head.flatMap((l) => l.words.filter((w) => Math.abs(mid2(span([w])) - mid2(c)) <= pitch / 2)).map((w) => w.text).join(" "));
  const fits = (v: BudgetGrid["visits"][number], k: number) => {
    const want = tagsOf(v.name);
    if (want.size) return [...want].every((t) => tagsOf(raw[k]!).has(t));
    return norm(v.name).length >= 5 && text[k]!.includes(norm(v.name));
  };
  const options = visits.map((v) => cols.flatMap((_, k) => (fits(v, k) ? [k] : [])));
  const claims = cols.map((_, k) => options.filter((o) => o.includes(k)).length);
  const at = inOrder(visits, (i) => (options[i]!.length === 1 && claims[options[i]![0]!] === 1 ? [{ at: cols[options[i]![0]!]!, off: 0 }] : []));
  const h = head.reduce((a, b) => (b.v > a.v ? b : a));
  return at.size ? { at, h } : null;
}

/**
 * Visits without a column of their own, between two that have one: when exactly as many number columns lie between those
 * two as visits do, they take them in order. Any other count, and they stay without a column (their cells are asked).
 */
function fillBetween(at: Map<string, Span2>, visits: BudgetGrid["visits"], cols: Span2[]): Map<string, Span2> {
  if (cols.length < 2) return at;
  const out = new Map(at);
  const pitch = Math.min(...cols.slice(1).map((c, i) => mid2(c) - mid2(cols[i]!)));
  const colOf = (s: Span2) => cols.findIndex((c) => Math.abs(mid2(c) - mid2(s)) <= pitch / 2);
  const order = [...visits].sort((a, b) => a.order - b.order).map((v) => v.code);
  const known = order.flatMap((code, i) => {
    const s = at.get(code);
    const k = s ? colOf(s) : -1;
    return k >= 0 ? [{ i, k }] : [];
  });
  known.slice(1).forEach((b, j) => {
    const a = known[j]!;
    if (b.i - a.i > 1 && b.k - a.k === b.i - a.i) for (let n = 1; n < b.i - a.i; n++) out.set(order[a.i + n]!, cols[a.k + n]!);
  });
  return out;
}

/**
 * The columns of a continuation page that prints no header, from the page before. A scan sits a little differently on
 * each page: the shift that lines up most of that page's number columns with this page's (within a quarter column) moves
 * each visit to its column here; a visit whose column this page doesn't print has none (its cells are asked). With no
 * clear shift (fewer than 3 or 60% lined up, or two shifts as good), the positions carry over as they are (a PDF's pages
 * line up).
 */
function carried(prev: Cols, pg: Page): Cols {
  const nums = numberColumns(pg.lines.filter((l) => l.dir === prev.dir));
  if (nums.length < 2 || prev.numbers.length < 2 || !Number.isFinite(prev.pitch)) return prev;
  const tol = prev.pitch / 4;
  const near = (c: number, t: number) => nums.findIndex((n) => Math.abs(mid2(n) - (c + t)) <= tol);
  const score = (t: number) => prev.numbers.filter((c) => near(mid2(c), t) >= 0).length;
  const shifts = [...new Set(prev.numbers.flatMap((c) => nums.map((n) => Math.round((mid2(n) - mid2(c)) * 10) / 10)))].map((t) => ({ t, n: score(t) })).sort((a, b) => b.n - a.n);
  const [best, next] = shifts;
  if (!best || best.n < Math.max(3, 0.6 * prev.numbers.length) || (next && next.n === best.n && Math.abs(next.t - best.t) > tol)) return prev;
  const move = (s: Span2): Span2 | null => {
    const k = near(mid2(s), best.t);
    return k < 0 ? null : nums[k]!;
  };
  const at = new Map([...prev.at].flatMap(([code, s]): [string, Span2][] => {
    const m = move(s);
    return m ? [[code, m]] : [];
  }));
  if (!at.size) return prev;
  return { ...prev, at, unit: prev.unit && move(prev.unit), left: Math.min(...[...at.values()].map((c) => c[0])), numbers: nums };
}

/**
 * Visit columns from the header line that names the most visits (code or name, on one line or stacked), in the text's
 * own direction. `taken`: header lines other grids on this page already use; a grid whose visits head another table just
 * as well takes that one.
 */
function headerColumns(pg: Page, visits: BudgetGrid["visits"], taken: Line[] = []): Cols | null {
  const columns = pg.lines.map((l) => stacked(pg, l));
  const hits = visits.map((v) => {
    const labels = labelsOf(v);
    return pg.lines.flatMap((l, li) => [
      ...runs(l, labels).map((ws) => ({ l, ws })),
      ...columns[li]!.filter((ws) => labels.some(([t, loose]) => sameLabel(norm(ws.map((w) => w.text).join("")), t, loose))).map((ws) => ({ l, ws })),
    ]);
  });
  const near = (a: Line, b: Line) => a.dir === b.dir && Math.abs(a.v - b.v) <= 3 * Math.max(a.h, b.h);
  const best = (ls: Line[]) =>
    ls.reduce<[Line | null, number]>((b, l) => {
      const n = hits.filter((h) => h.some((x) => near(x.l, l))).length;
      return n > b[1] ? [l, n] : b;
    }, [null, 0]);
  const [top, most] = best(pg.lines);
  let found: { at: Map<string, [number, number]>; h: Line } | null = null;
  if (top && most >= Math.max(2, visits.length / 2)) {
    // Another grid's header, and the lines naming visits around it, are busy: an equally good header elsewhere is this grid's.
    const lit = [...new Set(hits.flat().map((x) => x.l))];
    const block = lit.filter((x) => taken.some((t) => near(t, x)));
    const busy = (l: Line) => taken.some((t) => near(t, l)) || block.some((b) => near(b, l));
    const [free, n] = best(lit.filter((l) => !busy(l)));
    const h = busy(top) && free && n === most ? free : top;
    found = { h, at: inOrder(visits, (i) => hits[i]!.filter((x) => near(x.l, h)).map((x) => ({ at: span(x.ws), off: Math.abs(x.l.v - h.v) }))) };
  }
  if (!found || found.at.size < Math.max(2, visits.length / 2)) found = byTags(pg, visits) ?? found;
  if (!found) return null;
  const { h } = found;
  const numbers = numberColumns(pg.lines.filter((l) => l.dir === h.dir && l.v > h.v));
  const at = fillBetween(found.at, visits, numbers);
  if (at.size < Math.max(2, visits.length / 2)) return null;
  const left = Math.min(...[...at.values()].map((c) => c[0]));
  // a column is as wide as the table's own: with only some visits found, the gaps between them would span several columns
  const gapsOf = (cs: number[]) => cs.slice(1).map((c, i) => c - cs[i]!).sort((a, b) => a - b);
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? Infinity;
  const gaps = [Math.min(median(gapsOf([...at.values()].map(mid2).sort((a, b) => a - b))), median(gapsOf(numbers.map(mid2))))];
  const unitWord = pg.lines.filter((l) => near(l, h)).flatMap((l) => l.words.filter((w) => UNIT.test(w.text) && frame(w)[2] <= left)).sort((a, b) => frame(b)[0] - frame(a)[0])[0];
  return { dir: h.dir, at, unit: unitWord ? span([unitWord]) : null, left, pitch: gaps[Math.floor(gaps.length / 2)] ?? Infinity, line: h, numbers };
}

/** Of a row's prices left of the visit columns, the one equal to the price its visit cells print most often; null unless exactly one. */
function unitOnRow(cols: Cols, row: Line): Word | null {
  const printed = [...cols.at.keys()].flatMap((k) => {
    const v = cents(txt(cellWords(cols, row, k)));
    return v === null ? [] : [v];
  });
  const counts = new Map<number, number>();
  for (const v of printed) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [top, next] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!top || (next && next[1] === top[1])) return null;
  const left = row.words.filter((w) => priceLike(w) && frame(w)[2] <= cols.left && cents(w.text) === top[0]);
  return left.length === 1 ? left[0]! : null;
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

// ---------- a table's drawn grid ----------

type Ruled = NonNullable<TextPage["grids"]>[number];
/**
 * A ruled table cut into cells by its drawn rules (grid.ts), in the text's reading frame: `cells[row][col]` are the words
 * whose centre lies inside, left to right. A sideways table's rows and columns come from frame(), not the page's axes.
 * `printed`: each cell's price when it prints one.
 */
/** `alts`: on a page of our OCR, each cell's candidate readings (candidates.ts), else empty; `printed` stays the plain parse. */
type Table = { cells: Word[][][]; u: Span2[]; printed: (number | null)[][]; alts: ReadonlySet<number>[][]; ocr: boolean };
const NONE: ReadonlySet<number> = new Set();
/** A cell holds a number (plain, or on a scan one the OCR noise rules can read), and does it say `v`, and how. */
const present = (t: Table, r: number, c: number) => t.printed[r]![c] != null || (t.alts[r]![c]?.size ?? 0) > 0;
const says = (t: Table, r: number, c: number, v: number): Read => (t.printed[r]![c] === v ? "plain" : t.alts[r]![c]?.has(v) ? "noisy" : null);

const bands = (rs: number[]): Span2[] => rs.slice(1).map((r, i): Span2 => [rs[i]!, r]);
const flip = (xs: number[]) => xs.map((x) => -x).reverse();

/** A drawn table's rules in the reading frame: `us` along the text (the columns), `vs` across it (the rows). */
type Piece = { us: number[]; vs: number[] };
const framed = (g: Ruled, dir: Word["dir"]): Piece => {
  const [us, vs] = ([[g.xs, g.ys], [g.ys, flip(g.xs)], [flip(g.xs), flip(g.ys)], [flip(g.ys), g.xs]] as [number[], number[]][])[dir]!;
  return { us, vs };
};

function tableOf(p: TextPage, { us, vs }: Piece, dir: Word["dir"]): Table | null {
  if (us.length < 2 || vs.length < 2) return null;
  const [u, v] = [bands(us), bands(vs)];
  const cells = v.map(() => u.map((): Word[] => []));
  const into = (bs: Span2[], x: number) => bs.findIndex(([a, b]) => x >= a && x < b);
  for (const w of p.words) {
    if (w.hidden || w.dir !== dir) continue;
    const f = frame(w);
    const [r, c] = [into(v, (f[1] + f[3]) / 2), into(u, (f[0] + f[2]) / 2)];
    if (r >= 0 && c >= 0) cells[r]![c]!.push(w);
  }
  for (const row of cells) for (const ws of row) ws.sort((a, b) => frame(a)[0] - frame(b)[0]);
  // Inside a ruled cell a lone number is a price whatever its format ("150", "45.5"): the cell's own box says it is one.
  const printed = cells.map((row) => row.map((ws) => (ws.some(priceLike) || (ws.length === 1 && NUMBER.test(bare(ws[0]!.text))) ? cents(txt(ws)) : null)));
  // a lone number in a ruled cell, as on a scan it may be printed: its words joined as `cents` joins them
  const ocr = p.source === "ocr";
  const alts = cells.map((row) => row.map((ws) => (ocr && ws.length ? ocrCandidates(txt(ws)) : NONE)));
  return { cells, u, printed, alts, ocr };
}

// A table drawn in pieces (a header strip, a body split in two, extra columns) is one table: pieces that touch and share
// one axis's rules, to within a point and a half, are joined.
const TOL = 1.5;
const GAP = 5;
const holds = (a: number[], b: number[]) => b.every((x) => a.some((y) => Math.abs(x - y) <= TOL));
const union = (a: number[], b: number[]) => [...a, ...b].sort((x, y) => x - y).reduce<number[]>((o, x) => (o.length && x - o.at(-1)! <= TOL ? o : [...o, x]), []);
const apart = (a: number[], b: number[]) => Math.max(a[0]!, b[0]!) - Math.min(a.at(-1)!, b.at(-1)!);
const same = (a: number[], b: number[]) => holds(a, b) || holds(b, a);

function joined(pieces: Piece[]): Piece[] {
  const out = pieces.filter((x) => x.us.length >= 2 && x.vs.length >= 2);
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < out.length && !again; i++)
      for (let j = i + 1; j < out.length && !again; j++) {
        const [a, b] = [out[i]!, out[j]!];
        if ((same(a.us, b.us) && apart(a.vs, b.vs) <= GAP) || (same(a.vs, b.vs) && apart(a.us, b.us) <= GAP)) {
          out[i] = { us: union(a.us, b.us), vs: union(a.vs, b.vs) };
          out.splice(j, 1);
          again = true;
        }
      }
  }
  return out;
}

/** The page's drawn tables that hold numbers, the one holding the most first (a word is in a table when its centre is). */
function tablesOn(p: TextPage, dir: Word["dir"]): { t: Piece; i: number }[] {
  const prices = p.words.filter((w) => !w.hidden && w.dir === dir && NUMBER.test(bare(w.text))).map((w) => [(frame(w)[0] + frame(w)[2]) / 2, (frame(w)[1] + frame(w)[3]) / 2] as const);
  const held = ({ us, vs }: Piece) => prices.filter(([x, y]) => x >= us[0]! && x <= us.at(-1)! && y >= vs[0]! && y <= vs.at(-1)!).length;
  return joined((p.grids ?? []).map((g) => framed(g, dir)))
    .map((t, i) => ({ t, i, n: held(t) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
}

const TOTALISH = /total|overhead|indirect|f\s?&\s?a\b/i;
/** `rows`: the AI's procedure index → the table's row. `cols`: visit code → the table's column; `first`/`last`: the visit columns' ends. */
/** `unitCol`: the one column left of the visits that the headers name a unit price (not one with overhead), else -1. */
/**
 * A grid value the model says it read from word `word` of a page (the token id its read gave, resolved by extract.ts; ADR-002 PR 3).
 * A claim about where, never about what: it places a row in a table row and a visit in a column, and the value is still judged
 * against what that cell prints.
 */
export type Anchor = { grid: number; documentId: string; page: number; word: number; field: "cell" | "procedureSubtotal" | "overhead" | "nonProcedure" | "total"; visit: string; /** index in the grid's procedures; null for a visit's own sum */ procedure: number | null };
const ANCHOR_FIELD = { overheadCents: "overhead", nonProcedureCents: "nonProcedure", procedureSubtotalCents: "procedureSubtotal", totalCents: "total" } as const;

/** Table rows by procedure, and the visit columns in visit order (null unless every visit has one that the model's tokens agree on). */
type Hints = { rows: Map<number, number>; cols: number[] | null };

/** The value most of `xs` is, when at least 60% are; else none. */
const majority = (xs: number[]): number | null => {
  const best = [...new Set(xs)].map((x) => ({ x, n: xs.filter((y) => y === x).length })).sort((a, b) => b.n - a.n)[0];
  return best && best.n >= 0.6 * xs.length ? best.x : null;
};

/**
 * Where the model's tokens sit in the drawn table `t`: each procedure's row is the one most of its tokens are in, each visit's
 * column the one most of its tokens (its cells' and its own sums') are in. Rows in print order, two procedures never one row,
 * columns in visit order and all different, else nothing is taken from it (the placement by prices and headers is what's left).
 */
function hintsFor(t: Table, p: TextPage, mine: readonly Anchor[], visits: BudgetGrid["visits"]): Hints | null {
  const at = new Map<Word, [number, number]>();
  t.cells.forEach((row, r) => row.forEach((ws, c) => ws.forEach((w) => at.set(w, [r, c]))));
  const hit = mine.flatMap((a) => {
    const rc = at.get(p.words[a.word]!);
    return rc ? [{ a, r: rc[0], c: rc[1] }] : [];
  });
  const rows = new Map<number, number>();
  for (const pi of new Set(hit.flatMap(({ a }) => (a.procedure === null ? [] : [a.procedure])))) {
    const r = majority(hit.filter(({ a }) => a.procedure === pi).map((h) => h.r));
    if (r !== null) rows.set(pi, r);
  }
  const order = [...rows].sort((a, b) => a[0] - b[0]);
  const sound = order.every(([, r], i) => i === 0 || r > order[i - 1]![1]);
  const cols = [...visits].sort((a, b) => a.order - b.order).map((v) => majority(hit.filter(({ a }) => a.visit === v.code).map((h) => h.c)));
  const run = cols.every((c, i): c is number => c !== null && (i === 0 || c > cols[i - 1]!));
  return sound && rows.size ? { rows, cols: run ? (cols as number[]) : null } : null;
}

type Plan = { rows: Map<number, number>; cols: Map<string, number>; first: number; last: number; held: boolean; headed: boolean; unitCol: number; unfit: (pi: number, j: number, byPrice: boolean) => boolean };

/**
 * Each header cell against its visit: a "word+number" tag with other digits ("Week 12" over "Week 4") contradicts it, and
 * at least half the visits must positively match (their code as a word, their name, or a tag).
 */
function headerFit(visits: BudgetGrid["visits"], heads: string[]): { contradicts: boolean; hits: number } {
  let hits = 0;
  for (const [k, v] of visits.entries()) {
    const h = heads[k]!;
    const [have, want] = [tagsOf(h), new Set([...tagsOf(v.name), ...tagsOf(v.code)])];
    const word = (t: string) => t.replace(/\d+$/, "");
    if ([...have].some((t) => !want.has(t) && [...want].some((x) => word(x) === word(t)))) return { contradicts: true, hits };
    const code = norm(v.code);
    if ([...want].some((t) => have.has(t)) || (code && h.split(/\s+/).map(norm).includes(code)) || (norm(v.name).length >= 4 && norm(h).includes(norm(v.name)))) hits++;
  }
  return { contradicts: false, hits };
}
const headerAgrees = (visits: BudgetGrid["visits"], heads: string[]) => {
  const f = headerFit(visits, heads);
  return !f.contradicts && f.hits >= Math.ceil(visits.length / 2);
};

/** A row's words left of its first printed number: its label. */
const rowLabels = (t: Table) =>
  t.cells.map((row, r) => {
    const k = t.printed[r]!.findIndex((_, c) => present(t, r, c));
    return row.slice(0, k < 0 ? row.length : k).flat();
  });

/**
 * The AI's rows (`rows`, in its order) lined up with the table's, and its visits with the table's visit columns; null
 * unless all of it is clean, and the caller falls back to finding rows by their labels.
 * A table row fits an AI row when it prints every number the AI read for it (two at least; one, with a word of the row's
 * name printed in it), unless its label names another AI row and not this one: two rows whose prices were swapped must not
 * each find the other's. Rows are the longest in-order matching of those fits, one table row each. Visit columns are a run of
 * columns right of the unit/cost ones, as many as there are visits, with a header over each that doesn't contradict its
 * visit. A fit by prices alone is dropped again once the columns are known (see the end).
 * When no run's headers agree but none contradicts, and the run is the one the printed columns span (or the only one),
 * the mapping is `held`: every check applies, but which visit each column is waits for a person (a table check).
 * ponytail: a visit column blank in every matched row, outside the span of the printed ones, is found only if the headers pick the run. Upgrade: columns from the rules' own spacing.
 */
function plan(t: Table, g: BudgetGrid, rows: number[], taken: (r: number) => boolean, pct: number | null = null, hint: Hints | null = null): Plan | null {
  const labels = rowLabels(t);
  const pinned = new Set(hint?.rows.values());
  const label = labels.map((ws) => ws.map((w) => norm(w.text)).filter(Boolean));
  const owns = (j: number, p: BudgetGrid["procedures"][number]) => tokens(p.name).some((n) => label[j]!.some((l) => sameToken(n, l)));
  /** How well a row's name and the printed label say the same, 0 to 1 (words shared, over both's words). */
  const fit = (j: number, p: BudgetGrid["procedures"][number]) => {
    const [name, shown] = [tokens(p.name), label[j]!.filter((l) => l.length > 1 && !STOP.has(l))];
    return (2 * name.filter((n) => shown.some((l) => sameToken(n, l))).length) / Math.max(1, name.length + shown.length);
  };
  const weight = rows.map((pi, i) => {
    const p = g.procedures[pi]!;
    const want = [...Object.values(p.cells).filter((v): v is number => typeof v === "number"), ...(p.unitCents !== null ? [p.unitCents] : [])];
    return t.cells.map((_, j) => {
      // a row the model pointed at (its tokens sit in this table row) is placed there, whatever the scan made of its prices or its label;
      // a row it didn't point at never takes a pointed row
      const to = hint?.rows.get(pi);
      if (to !== undefined) return j === to && !taken(j) ? 2000 : 0;
      if (taken(j) || pinned.has(j) || (TOTALISH.test(txt(labels[j]!)) && !TOTALISH.test(p.name))) return 0;
      // each value of the read takes one printed cell of the row, a cell that prints it plainly before one that only the scan's
      // noise rules can read as it ("526" says 526 and, on a scan, 26): two values never share a cell
      const have = t.printed[j]!.flatMap((_, c) => (present(t, j, c) ? [c] : []));
      const take = (v: number) => {
        const plain = have.findIndex((c) => says(t, j, c, v) === "plain");
        const k = plain >= 0 ? plain : have.findIndex((c) => says(t, j, c, v) !== null);
        return k >= 0 && have.splice(k, 1);
      };
      if (!want.length || !want.every(take)) return 0;
      const mine = owns(j, p);
      if (want.length < 2 && !mine) return 0;
      if (!mine && rows.some((o, i2) => i2 !== i && owns(j, g.procedures[o]!))) return 0;
      // a sibling row (its name shares a word with the label) fits by prices too when two rows are swapped: another read row
      // that says the label better is its row, even though its own prices fit elsewhere
      if (mine && rows.some((o, i2) => i2 !== i && fit(j, g.procedures[o]!) > fit(j, p))) return 0;
      return 1000 + (mine ? 1 : 0);
    });
  });
  const dp = Array.from({ length: rows.length + 1 }, () => new Array<number>(t.cells.length + 1).fill(0));
  rows.forEach((_, i) => t.cells.forEach((__, j) => (dp[i + 1]![j + 1] = Math.max(dp[i]![j + 1]!, dp[i + 1]![j]!, weight[i]![j]! ? dp[i]![j]! + weight[i]![j]! : 0))));
  const found = new Map<number, number>();
  for (let i = rows.length, j = t.cells.length; i > 0 && j > 0; ) {
    if (weight[i - 1]![j - 1] && dp[i]![j] === dp[i - 1]![j - 1]! + weight[i - 1]![j - 1]!) (found.set(rows[i - 1]!, j - 1), i--, j--);
    else if (dp[i]![j] === dp[i - 1]![j]) i--;
    else j--;
  }
  if (!found.size) return null;
  const used = [...found.values()];
  const head = (c: number) => txt(t.cells.slice(0, Math.min(...used)).flatMap((row) => row[c]!));
  const data = t.u.flatMap((_, c) => (used.some((r) => present(t, r, c)) ? [c] : []));
  // The columns left of the visits: the unit ones by their header, and where a page has no header (a continuation) the cost columns
  // by the page's own arithmetic (costColumns), so a cost column is never taken for a visit.
  const costs = costColumns(t, pct);
  const unit = Math.max(-1, ...data.filter((c) => UNIT.test(head(c)) && !/total/i.test(head(c))), ...(costs && !t.cells.slice(0, Math.min(...used)).some((row) => row.some((ws) => ws.length)) ? [costs.base, costs.incl] : []));
  // The visit columns: a run of as many columns as the read's visits, with every printed column right of the unit ones in
  // it or left of it and a header over each that doesn't contradict its visit. The one such run, or of several the one from
  // the first printed column to the last (a column between two that print is a visit's too, blank in every matched row or
  // not). A total, and a gap between pieces (no word in it anywhere), is no visit's.
  const visits = [...g.visits].sort((a, b) => a.order - b.order);
  const pool0 = t.u.flatMap((_, c) => (c > unit && t.cells.some((row) => row[c]!.length) && !/total/i.test(head(c)) ? [c] : []));
  // A column printing, on most rows, the sum of the columns before it is the table's own total, not a visit (a page whose
  // header is on the page before has no word to say so). The columns after it are the conditional visits.
  const totalCol = (c: number) => {
    const left = pool0.filter((k) => k < c);
    const rs = used.filter((j) => solid(t, j, c) !== null && left.filter((k) => solid(t, j, k) !== null).length >= 2 && left.every((k) => !t.cells[j]![k]!.length || solid(t, j, k) !== null));
    const hit = rs.filter((j) => solid(t, j, c) === left.reduce((a, k) => a + (solid(t, j, k) ?? 0), 0));
    return hit.length >= 2 && hit.length * 2 > rs.length;
  };
  const pool = pool0.filter((c) => !totalCol(c));
  const runs = pool.flatMap((_, i) => (i + visits.length <= pool.length ? [pool.slice(i, i + visits.length)] : []));
  const [first, last] = [data.find((c) => c > unit) ?? -1, pool.filter((c) => c <= data.at(-1)!).at(-1)];
  const clear = runs.filter((r) => data.every((c) => c <= unit || c < r[0]! || r.includes(c) || /total/i.test(head(c)) || (pool0.includes(c) && !pool.includes(c))));
  const pick = (rs: number[][]) => (rs.length === 1 ? rs[0] : rs.find((r) => r[0] === first && r.at(-1) === last));
  const fits = clear.filter((r) => headerAgrees(visits, r.map(head)));
  // ponytail: held only when no run's headers agree at all; several that do, none the printed span, stay unmapped. Upgrade: ask which run.
  const loose = fits.length ? undefined : pick(clear.filter((r) => !headerFit(visits, r.map(head)).contradicts));
  // the model's pointers, when every visit's tokens agree on a column and the columns run in visit order, are the columns: not a guess by count and order
  const visitCols = hint?.cols ?? pick(fits) ?? loose ?? [];
  if (visitCols.length !== visits.length) return null;
  const held = !hint?.cols && !!loose;
  const plain = data.filter((c) => c < visitCols[0]! && UNIT.test(head(c)) && !/total|overhead|incl|with|\boh\b|w\//i.test(head(c)));
  // The unit price is the cost column before overhead. By the page's arithmetic when it has one (costColumns), which a header that
  // names another column contradicts (then none); else the one column the headers name.
  const cost = costColumns(t, pct);
  const unitCol = cost && cost.base < visitCols[0]! ? (plain.length === 0 || (plain.length === 1 && plain[0] === cost.base) ? cost.base : -1) : plain.length === 1 ? plain[0]! : -1;
  // a page without its own header (a continuation) can't say a price under a visit is that visit's
  const headed = !held || visitCols.filter((c) => head(c).trim()).length * 2 >= visitCols.length;
  // A row the prices fit by chance (one price printed all along it) is no match: a value the read has never sits on a blank
  // cell, and a row no label of its own vouches for prints nothing at a visit the read leaves empty.
  const cols = new Map(visits.map((v, k) => [v.code, visitCols[k]!]));
  /** `byPrice`: the row was matched by what it prints, not placed by order (placing needs no pattern of printed cells to tell siblings apart). */
  const unfit = (pi: number, j: number, byPrice: boolean) => {
    const p = g.procedures[pi]!;
    const named = tokens(p.name);
    const [at, alone] = [Object.keys(p.cells).map((code) => cols.get(code)), named.filter((n) => label[j]!.some((l) => sameToken(n, l))).length * 2 <= named.length];
    const blank = Object.entries(p.cells).some(([code, v]) => typeof v === "number" && !present(t, j, cols.get(code) ?? -1));
    // a row the model pointed at: a cell the scan can't read is the scan's, a cell with no word in it at all is blank
    if (hint?.rows.get(pi) === j) return Object.entries(p.cells).some(([code, v]) => typeof v === "number" && !t.cells[j]![cols.get(code) ?? -1]?.length);
    // Held: the columns aren't vouched for, so a row the read gives fewer than two prices (the unit price counts) must print
    // something in every cell the read gives it, "invoiceable" ones too. One price and a shared word of its name fit a
    // sibling row too (a planted digit in a unit price did), and only the pattern of printed cells tells them apart.
    const thin = byPrice && held && Object.values(p.cells).filter((v) => typeof v === "number").length + (p.unitCents !== null ? 1 : 0) < 2 && Object.keys(p.cells).some((code) => !t.cells[j]![cols.get(code) ?? -1]?.length);
    return blank || thin || (alone && [...cols.values()].some((c) => present(t, j, c) && !at.includes(c)));
  };
  for (const [pi, j] of found) if (unfit(pi, j, true)) found.delete(pi);
  if (!found.size) return null;
  return { rows: found, cols, first: visitCols[0]!, last: visitCols.at(-1)!, held, headed, unitCol, unfit };
}

/**
 * The read's rows that `plan` couldn't match by what they print, placed onto the table's body rows by order. Anchors are the
 * rows matched firmly, and the table's own ends; between two of them the read's rows are placed only when there are exactly
 * as many as the table's body rows between them (a blank row and a total or subtotal row aren't body rows). Any other gap is
 * left alone. Never a guess: whoever confirms the table's check picks the procedure for two of these rows.
 * ponytail: a header row above the first anchor is a body row to this count, so a headed table's start is never placed.
 */
function place(t: Table, rows: number[], found: Map<number, number>, free: (pi: number, j: number) => boolean): Map<number, number> {
  const out = new Map<number, number>();
  const label = rowLabels(t);
  const anchors = [[-1, -1] as [number, number], ...[...found].sort((a, b) => a[0] - b[0]), [Infinity, t.cells.length] as [number, number]];
  for (let i = 1; i < anchors.length; i++) {
    const [[pa, ja], [pb, jb]] = [anchors[i - 1]!, anchors[i]!];
    const reads = rows.filter((pi) => pi > pa && pi < pb);
    const body = t.cells.flatMap((row, j) => (j > ja && j < jb && row.some((c) => c.length) && !TOTALISH.test(txt(label[j]!)) ? [j] : []));
    if (!reads.length || reads.length !== body.length) continue;
    if (reads.every((pi, k) => free(pi, body[k]!))) reads.forEach((pi, k) => out.set(pi, body[k]!));
  }
  return out;
}

// ---------- visit summary rows ----------

const NOT = /\b(?:not|without|non|excl\w*)\b/i;
const WITH = /\b(?:with|charged|incl\w*|applied|plus)\b/i;
/**
 * The rows that sum a visit, by the generic words a budget uses (never a sponsor's or a layout's): a total ("total", "per visit"), a
 * subtotal, a non-procedure amount, and overhead itself ("overhead at 30%"): not a row about the costs "with" or "without" it, which
 * is no overhead.
 */
const VISIT_LABELS: Record<"totalCents" | "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents", (s: string) => boolean> = {
  totalCents: (s) => (/\btotal/i.test(s) || (/\bper[\s-]?visit\b/i.test(s) && !OVERHEAD.test(s))) && !/sub[\s-]?total|patient|subject/i.test(s),
  procedureSubtotalCents: (s) => /sub[\s-]?total/i.test(s) && !/non[\s-]?proc/i.test(s),
  nonProcedureCents: (s) => /non[\s-]?proc/i.test(s),
  overheadCents: (s) => OVERHEAD.test(s) && !/\btotal/i.test(s) && !WITH.test(s) && !NOT.test(s),
};

/**
 * A drawn table that holds no rows of the read, but whose rows labelled as a visit's total, subtotal, non-procedure amount or
 * overhead (VISIT_LABELS), or that lost their label to the scan, print a number for each of the grid's visits: those columns, in visit order (one more than the visits, and one
 * of them the sum of the columns before it on every row that prints them all: the table's own total, and no visit's). Held, since nothing but the count and order says which visit
 * a column is, unless the headers agree; null when they contradict, or the count differs.
 */
function summaryPlan(t: Table, g: BudgetGrid): Plan | null {
  const labels = rowLabels(t);
  // rows labelled as a visit's sum, and rows whose label the scan lost (they take part in finding the columns, and name no field)
  const rows = t.cells.flatMap((_, j) => ((Object.values(VISIT_LABELS).some((f) => f(txt(labels[j]!))) || !labels[j]!.length) && t.printed[j]!.filter((x) => x !== null).length >= 2 ? [j] : []));
  if (!rows.length) return null;
  const need = Math.min(2, rows.length);
  let pool = t.u.flatMap((_, c) => (rows.filter((j) => t.printed[j]![c] !== null).length >= need ? [c] : []));
  const visits = [...g.visits].sort((a, b) => a.order - b.order);
  if (pool.length === visits.length + 1) {
    // the table's own total: the one column that, on every row printing all of them (two at least), is the sum of the columns before it
    // (as printed, not as sure: a digit the scan doubts breaks the sum, never makes one)
    const full = rows.filter((j) => pool.every((c) => t.printed[j]![c] !== null));
    const totals = full.length < 2 ? [] : pool.map((_, e) => e).filter((e) => e > 0 && full.every((j) => pool.slice(0, e).reduce((n, c) => n + t.printed[j]![c]!, 0) === t.printed[j]![pool[e]!]));
    if (totals.length === 1) pool = pool.filter((_, e) => e !== totals[0]);
  }
  if (pool.length !== visits.length) return null;
  const head = (c: number) => txt(t.cells.slice(0, rows[0]).flatMap((row) => row[c]!));
  const heads = pool.map(head);
  if (headerFit(visits, heads).contradicts) return null;
  const held = !headerAgrees(visits, heads);
  return { rows: new Map(), cols: new Map(visits.map((v, k) => [v.code, pool[k]!])), first: pool[0]!, last: pool.at(-1)!, held, headed: !held || heads.filter((h) => h.trim()).length * 2 >= pool.length, unitCol: -1, unfit: () => false };
}

// ---------- cost columns ----------

/** The direction most of a page's words read in: the one its tables are cut in. */
const domDir = (p: TextPage): Word["dir"] => {
  const n = [0, 1, 2, 3].map((d) => p.words.filter((w) => !w.hidden && w.dir === d).length);
  return n.indexOf(Math.max(...n)) as Word["dir"];
};
/** What a table's cell prints when the scan is sure of every digit of it, else null. */
const solid = (t: Table, r: number, c: number): number | null => (t.cells[r]![c]!.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF) ? (t.printed[r]![c] ?? null) : null);
/** `says`, only when the scan is sure of every digit of the cell. */
const sayCell = (t: Table, r: number, c: number, v: number): Read => (t.cells[r]![c]!.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF) ? says(t, r, c, v) : null);
/** How well a row's printed label and a name say the same, 0 to 1 (words shared, over both's words). */
const dice = (name: string, label: Word[]) => {
  const [n, s] = [tokens(name), label.map((w) => norm(w.text)).filter((l) => l.length > 1 && !STOP.has(l))];
  return (2 * n.filter((x) => s.some((l) => sameToken(x, l))).length) / Math.max(1, n.length + s.length);
};

/**
 * A table's cost columns: the price before overhead and the price with it, found by arithmetic on what the page prints and
 * never by their headers (a scan's headers are garbled or missing). The one with overhead is the pair's right-hand column
 * where, on rows that print both and differ, the price is the other's plus the contract's overhead % within a cent's
 * rounding (at least two such rows, and most of the rows that differ); the pair with the most such rows, then the left-most,
 * is the table's. A table with no overhead rows at all (fees) has none by arithmetic, but a table of at most four number columns
 * whose only two neighbouring columns that print the same on every row (three at least) says one price twice: both are the
 * price, and `ratio` is false.
 * ponytail: the overhead % is the read's (the grid's stated one, else the contract's): a wrong % finds no pair, so the rows are asked.
 */
type Costs = { base: number; incl: number; ratio: boolean };
function costColumns(t: Table, pct: number | null): Costs | null {
  const busy = t.u.map((_, c) => c).filter((c) => t.cells.filter((_, r) => solid(t, r, c) !== null).length >= 3);
  let best: (Costs & { n: number }) | null = null;
  const same: Costs[] = [];
  for (const a of busy)
    for (const b of busy) {
      if (b <= a) continue;
      let [oh, eq, odd] = [0, 0, 0];
      t.cells.forEach((_, r) => {
        const [x, y] = [solid(t, r, a), solid(t, r, b)];
        if (x === null || y === null || x <= 0) return;
        if (y === x) eq++;
        else if (pct !== null && Math.abs(y - Math.round((x * (100 + pct)) / 100)) <= 1) oh++;
        else odd++;
      });
      if (pct !== null && oh >= 2 && odd * 4 <= oh + odd && (!best || oh > best.n)) best = { base: a, incl: b, ratio: true, n: oh };
      if (oh === 0 && odd === 0 && eq >= 3 && b === busy[busy.indexOf(a) + 1]) same.push({ base: a, incl: b, ratio: false });
    }
  if (best) return best;
  return busy.length <= 4 && same.length === 1 ? same[0]! : null;
}

/**
 * The row of a table a priced thing is on, by its name. `base`, `incl`: the cells at the two cost columns; `ok`: what each prints
 * (OCR digits, every word sure) is the thing's price; `sure`: it prints some number the scan is sure of. `also`: the other cost
 * column's cell when it prints the very amount confirmed (a price printed twice, with no overhead), which is then the row's too.
 */
type CostHit = { base: Word[]; incl: Word[]; ok: { base: boolean; incl: boolean }; noisy: { base: boolean; incl: boolean }; sure: { base: boolean; incl: boolean }; left: Word[]; also: Word[]; row: Word[] };
/**
 * Each thing's row in the page's drawn tables that have cost columns. The row is the one whose label fits the name best, at least
 * half and better than every other row (a tie is nobody's); a row two things want goes to the better fit, and to nobody on a tie.
 * Never a guess: anything else has no hit, and its prices are looked for by label as before. A price is confirmed only by its
 * own column's cell: a hit whose cell prints another amount says so (the label path must not find the price in the row's
 * other cells: with a quantity printed like a price, the first amount of the line is not the price before overhead).
 */
function byCosts(pg: Page, pct: number | null, things: { name: string; base: number | null; incl: number | null }[]): (CostHit | null)[] {
  const dir = domDir(pg.p);
  const tabs = tablesOn(pg.p, dir).flatMap(({ t: ruled }) => {
    const t = tableOf(pg.p, ruled, dir);
    const cc = t && costColumns(t, pct);
    return t && cc ? [{ t, cc, labels: rowLabels(t) }] : [];
  });
  const pick = things.map((th) => {
    const all = tabs.flatMap((tb, ti) => tb.labels.map((l, r) => ({ ti, r, fit: dice(th.name, l) }))).sort((a, b) => b.fit - a.fit);
    const [top, next] = all;
    return top && top.fit >= 0.5 && (!next || next.fit < top.fit) ? top : null;
  });
  return things.map((th, i) => {
    const me = pick[i];
    if (!me || pick.some((o, k) => k !== i && o && o.ti === me.ti && o.r === me.r && o.fit >= me.fit)) return null;
    const { t, cc } = tabs[me.ti]!;
    const [b, w] = [solid(t, me.r, cc.base), solid(t, me.r, cc.incl)];
    // a cell says the price when its digits are all sure and it prints it, on a scan allowing for the OCR's usual misreadings;
    // `sure` (a clean price that says something else is a conflict) stays on the plain parse
    const [rb, ri] = [th.base === null ? null : sayCell(t, me.r, cc.base, th.base), th.incl === null ? null : sayCell(t, me.r, cc.incl, th.incl)];
    const ok = { base: rb !== null, incl: ri !== null };
    return {
      base: t.cells[me.r]![cc.base]!,
      incl: t.cells[me.r]![cc.incl]!,
      ok,
      noisy: { base: rb === "noisy", incl: ri === "noisy" },
      sure: { base: b !== null, incl: w !== null },
      left: t.cells[me.r]!.slice(0, cc.base).flat(),
      also: th.incl === null && ok.base && w === th.base ? t.cells[me.r]![cc.incl]! : [],
      row: t.cells[me.r]!.flat(),
    };
  });
}

// ---------- a row's own arithmetic ----------

/** A quantity as a table may print it: a number with no currency sign, to the hundredth ("22", "22.00", "1.50"); in hundredths. */
const QTY = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/;
type Amount = { words: Word[]; cents: number };
/** A row's quantity × unit price = total; `n`: the quantity, null when it isn't a whole count. */
type RowMath = { qty: Word; n: number | null; unit: Amount; total: Amount };
type Limit = Rulebook["invoiceables"][number]["cap"];

/**
 * What a printed row's own arithmetic says its figures are: the one way three of its cells (cellsOf) give quantity × unit
 * price = total, exactly, in integer cents. A unit price and a total are each a cell holding one positive amount (`amounts`:
 * a "$", cents or a thousands comma); a quantity, a cell holding one number with no currency sign ("400", "400.00", "1.50");
 * three different cells and, on a scan, every word sure. The page's plain figures only, never the read's, a header or the
 * columns' order. Null when no product fits, or more than one: then the row says nothing and its values are judged as before.
 * So "25 | 75.00 | 1,875.00" says 25 × 75.00 (a plain 25 is no price), while "1.50 | 35.00 | 52.50" fits both ways round
 * (either could be the quantity) and "1 | 500.00 | 500.00" two ways: neither says which figure is the price.
 */
export function rowMath(ws: Word[], before: Page["before"] = () => undefined): RowMath | null {
  const found = rowIdentities(ws, before);
  return found.length === 1 ? found[0]! : null;
}

/** Every way three cells of a row give quantity × unit price = total (rowMath's candidates, "1 × X = X" both ways round included). */
export function rowIdentities(ws: Word[], before: Page["before"] = () => undefined): RowMath[] {
  const cells = cellsOf(ws).filter((c) => c.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF));
  const counts = cells.flatMap((c) => {
    const t = c.length === 1 ? bare(c[0]!.text) : "";
    const h = QTY.test(t) ? Math.round(Number(t.replace(/,/g, "")) * 100) : 0;
    return h > 0 ? [{ w: c[0]!, h }] : [];
  });
  const money = cells.flatMap((c): Amount[] => {
    const a = amounts(c, false, before);
    return a.length === 1 && a[0]!.words.length === c.length && a[0]!.cents !== null && a[0]!.cents > 0 ? [{ words: c, cents: a[0]!.cents }] : [];
  });
  return counts.flatMap((q) =>
    money.flatMap((u) => money.flatMap((t) => (u !== t && !u.words.includes(q.w) && !t.words.includes(q.w) && q.h * u.cents === t.cents * 100 ? [{ qty: q.w, n: q.h % 100 ? null : q.h / 100, unit: u, total: t }] : []))),
  );
}

// ---------- quotes ----------

export const QUOTE_WORD = (s: string) =>
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

function dates(ws: Word[]): { words: Word[]; values: string[]; printed: string }[] {
  const starts: number[] = [];
  const s = ws.reduce((acc, w, i) => (starts.push(acc.length + (i ? 1 : 0)), acc + (i ? " " : "") + w.text), "");
  return datesIn(s).map(({ values, printed, from, to }) => ({ words: ws.filter((w, i) => starts[i]! < to && starts[i]! + w.text.length > from), values, printed }));
}

/** The figures of one kind in some words of a page. A cap is the number stated as a limit ("up to 10"), else the only plain number. */
function figures(pg: Page, ws: Word[], unit: Unit): Figure[] {
  const fig = (words: Word[], values: (number | string)[], printed: string): Figure => ({ words, values, printed, at: boxOf(pg.p, words) });
  if (unit === "date") return dates(ws).map((d) => fig(d.words, d.values, d.printed));
  const money = amounts(ws, false, pg.before);
  // an amount the master can't hold ("$0.655") is a figure that says no value: printed where a value is, it's asked
  if (unit === "cents") return money.filter((a) => limited(ws, ws.indexOf(a.words[0]!), ws.indexOf(a.words.at(-1)!))).map((a) => fig(a.words, a.cents === null ? [] : [a.cents], txt(a.words)));
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

/**
 * A table whose columns line up with the read's visits by count and order but whose headers don't say which is which: a
 * person confirms the mapping, blind (one question per check). `columns`: each visit's column, in visit order; `table`:
 * the table's box, which the question shows. Every cell of the table that would be confirmed is held by `id`.
 */
export type TableCheck = {
  id: string;
  grid: number;
  page: number;
  table: PageBox;
  /** The visit columns (a person says which is which; always listed, since a check with none is rejected at once, whether its columns were held or only its rows). */
  columns: { box: PageBox; visit: string }[];
  /** The read's rows placed on the grid's rows by order, not by what they print (`procedure`: index into the grid's procedures); absent: none. */
  rows?: { box: PageBox; procedure: number }[];
};
type Bound = { evidence: ValueEvidence[]; unaccounted: Span[]; tableChecks: TableCheck[]; blankChecks: BlankCheck[]; rows: RowBand[]; itemRows: ItemRow[] };

/**
 * A fee's or an invoiceable's row, found by its label (`item`: the value's path, "/invoiceables/2"), whose figures give quantity
 * × unit price = total with one set of three (`figures`: quantity, unit price and total boxes; "1 × X = X", which reads both ways
 * round, too; a row where the ways use different figures, as a grid row repeating one price does, has none). The sweep reads it
 * (`gateSweep`): beside a bound value of the item, the other figures are that item's own arithmetic, not a term the master lacks.
 */
export type ItemRow = { item: string; documentId: string; page: number; row: Frac; figures: Frac[] };
/** A box in page fractions, as PageBox holds it. */
type Frac = NonNullable<PageBox["box"]>;

/**
 * A rulebook row lined up with its row of a drawn table (ADR-002: the solver's row identity and the sweep's row bands both read
 * it). Boxes are page fractions, like every PageBox. `cells`: each visit's cell of this row. `total`: what the page itself
 * prints as the row's total, in cents (a total column right of the visits, or the printed unit price times a printed quantity),
 * else null: most tables print neither, and then no row identity exists for the row.
 */
export type RowBand = {
  grid: number;
  /** Index into the grid's procedures. */
  procedure: number;
  documentId: string;
  page: number;
  /** The row across the whole table. */
  box: [number, number, number, number];
  /** `ink`: the drawn cell prints a word or holds ink the scan couldn't read (a blank cell has none). */
  cells: { visit: string; box: [number, number, number, number]; ink: boolean }[];
  total: number | null;
  by: "row_total" | "quantity" | null;
  /**
   * The visits the printed total covers: those whose column is left of the total's column. A table can print columns right of its
   * total (an unscheduled or early-termination visit, a pregnancy) that the total leaves out, and the read holds them as visits.
   * null: every visit (no total column to place them by).
   */
  covers: string[] | null;
};

/** What the grid read says a row prints beside its visit cells: its quantity and its own total column (indexes into the rulebook's grids and procedures). */
export type PrintedRow = { grid: number; procedure: number; qty: number | null; totalCents: number | null };

/** The planned tables of one grid, with the rows the plan and the placing by order gave them (`placed`: procedure → table row). */
/** `k`, `ti`: the page (document#page) and which of its drawn tables. */
type Planned = { pg: Page; t: Table; pl: Plan; ruled: Piece; dir: Word["dir"]; placed: Map<number, number>; check: () => string; k: string; ti: number };
type Box4 = [number, number, number, number];

/** A box in a text's reading frame, back in page points (the inverse of frame()). */
const unframe = (dir: Word["dir"], [u0, v0, u1, v1]: Box4): Box4 => [[u0, v0, u1, v1], [-v1, u0, -v0, u1], [-u1, -v1, -u0, -v0], [v0, -u1, v1, -u0]][dir] as Box4;
const overlap = (r: Box4, [a0, b0, a1, b1]: Box4) => r[0] < a1 && a0 < r[2] && r[1] < b1 && b0 < r[3];

/**
 * Cells the read marks "invoiceable" where the page prints nothing: in a planned table (its mapping held or agreed), a read
 * cell whose drawn cell is blank, on a text page or a clear OCR page (the review's own test, `clear` in
 * apps/api/src/review.ts), with none of the page's unread ink in it. The AI marks a table's empty cells that way, and a blank cell can't
 * confirm "invoiceable", so each would be asked on its own; they're one question per table instead (BLANK_INVOICEABLE): how
 * the table bills them. A cell that prints anything, or that the scan leaves unclear, is never grouped. Marks each cell's
 * evidence `blank` (its status stays not confirmed) and its `where` at its row; returns the groups. On a table whose mapping is held, a group waits for that table's check (`after`).
 */
function blankInvoiceable(gi: number, g: BudgetGrid, tables: Planned[], evidence: ValueEvidence[]): BlankCheck[] {
  const out: BlankCheck[] = [];
  tables.forEach((d, n) => {
    const p = d.pg.p;
    // a clear OCR page: as the review's own test of one (reviewDraft's `clear`: 70% of its words read with confidence)
    if (!(p.source === "text" || (p.source === "ocr" && p.words.length > 0 && p.words.filter((w) => (w.conf ?? 1) >= MIN_OCR_CONF).length >= 0.7 * p.words.length))) return;
    const [rows, cells, found] = [new Set<number>(), [] as string[], [] as ValueEvidence[]];
    for (const [pi, j] of [...d.placed].sort((x, y) => x[0] - y[0]))
      for (const [key, value] of Object.entries(g.procedures[pi]!.cells)) {
        const c = d.pl.cols.get(key);
        const path = `/budgetGrids/${gi}/procedures/${pi}/cells/${ptr(key)}`;
        const e = evidence.find((x) => x.path === path);
        if (value !== "invoiceable" || c === undefined || d.t.cells[j]![c]!.length || !e || e.held || (e.status !== "ungrounded" && e.status !== "conflict")) continue;
        // the drawn cell: no word of the page (any direction) a little in from its rules, and no unread ink in it
        const cell = unframe(d.dir, [d.ruled.us[c]!, d.ruled.vs[j]!, d.ruled.us[c + 1]!, d.ruled.vs[j + 1]!]);
        const [dx, dy] = [(cell[2] - cell[0]) / 10, (cell[3] - cell[1]) / 10];
        if (p.words.some((w) => !w.hidden && overlap(w.rect, [cell[0] + dx, cell[1] + dy, cell[2] - dx, cell[3] - dy]))) continue;
        if ((p.unread ?? []).some((u) => u.box && overlap([u.box[0] * p.width, u.box[1] * p.height, (u.box[0] + u.box[2]) * p.width, (u.box[1] + u.box[3]) * p.height], cell))) continue;
        rows.add(pi);
        cells.push(path);
        found.push(e);
        e.where = [boxOf(p, d.t.cells[j]!.flat())];
      }
    if (!cells.length) return;
    const id = `blank:${gi}:${p.documentId}#${p.page}:${n}`;
    for (const e of found) e.blank = id;
    // a held mapping: which column is which visit is still to be confirmed, so the group waits for (and is rejected with) that table's check
    out.push({ id, grid: gi, page: p.page, table: boxOf(p, d.t.cells.flat(2)), rows: [...rows].sort((a, b) => a - b), cells, ...(d.pl.held ? { after: d.check() } : {}) });
  });
  return out;
}

/**
 * What a planned table prints as each row's total, from its own geometry and the scan's or text's own digits (never the read's
 * values): the row identity then compares the read's cells with it, independent of the read's own sum.
 *  - a row total: a column right of the visit columns whose printed value equals the sum of the row's printed visit cells on at
 *    least two rows (one of them with two cells or more) and on most of the rows that print it;
 *  - else a quantity: an integer column left of the visits (not the unit column) whose number is, on at least two rows and most of
 *    the rows that print one, the count of populated visit cells; the row's total is then its printed unit price times it. A
 *    table with a total column keeps that total: the quantity would only repeat it.
 * Rows count only when every visit cell they print is a number the scan is sure of (a totals row is no body row). A table that
 * prints neither gives an empty map. Limits: a quantity needs the unit column the plan names (`unitCol`); a printed total the
 * scan is unsure of, or one that is no sum of the cells (a discount, a row with a one-off), isn't found.
 */
function geometryTotals(t: Table, pl: Plan): Map<number, { cents: number; by: "row_total" | "quantity"; col?: number }> {
  const out = new Map<number, { cents: number; by: "row_total" | "quantity"; col?: number }>();
  const labels = rowLabels(t);
  const visits = [...pl.cols.values()];
  const body = t.cells.flatMap((_, j) => (TOTALISH.test(txt(labels[j]!)) ? [] : [j]));
  // A total column is any column that is no visit's, no unit price and not left of the visits, wherever it sits: right of every
  // visit, or between the scheduled ones and conditional ones (unscheduled, early termination) printed after it. It totals the visit
  // cells left of it; the columns right of it are outside the row's sum.
  for (const c of t.u.keys()) {
    if (c <= pl.first || visits.includes(c) || c === pl.unitCol) continue;
    const left = visits.filter((v) => v < c);
    const rows = body.flatMap((j) => {
      const cells = left.flatMap((v) => (t.cells[j]![v]!.length ? [solid(t, j, v)] : []));
      return cells.length && cells.every((x): x is number => x !== null) ? [{ j, n: cells.length, sum: cells.reduce((a, b) => a + b, 0) }] : [];
    });
    const prints = rows.filter((r) => solid(t, r.j, c) !== null);
    const hit = prints.filter((r) => solid(t, r.j, c) === r.sum);
    if (hit.length < 2 || hit.length * 2 <= prints.length || !hit.some((r) => r.n >= 2)) continue;
    // the column is a total column now: every body row that prints a total the scan is sure of has it, a row with a cell the scan can't
    // read included (its total is then what says what that cell is)
    for (const j of body) if (solid(t, j, c) !== null) out.set(j, { cents: solid(t, j, c)!, by: "row_total", col: c });
    return out;
  }
  // rows whose every visit cell the scan is sure of, for the quantity that equals the count of populated cells
  const rows = body.flatMap((j) => {
    const cells = visits.flatMap((c) => (t.cells[j]![c]!.length ? [solid(t, j, c)] : []));
    return cells.length && cells.every((x): x is number => x !== null) ? [{ j, n: cells.length, sum: cells.reduce((a, b) => a + b, 0) }] : [];
  });
  if (pl.unitCol < 0) return out;
  for (const c of t.u.keys()) {
    if (c >= pl.first || c === pl.unitCol) continue;
    // a quantity prints as "22" or "22.00"
    const q = (j: number) => {
      const ws = t.cells[j]![c]!;
      const m = ws.length === 1 && (ws[0]!.conf ?? 1) >= MIN_OCR_CONF ? /^(\d{1,3})(?:\.00?)?$/.exec(ws[0]!.text) : null;
      return m ? Number(m[1]) : null;
    };
    const prints = rows.filter((r) => q(r.j) !== null && q(r.j)! > 0 && solid(t, r.j, pl.unitCol) !== null);
    // quantity times unit price needs no visit cell, so a row whose cells the scan is unsure of still counts for it
    const sold = body.filter((j) => q(j) !== null && q(j)! > 0 && solid(t, j, pl.unitCol) !== null);
    // a total column: the printed total is the quantity times the unit price (the scan's own figures, never the read's), so a visit
    // cell the scan dropped from a wide row can't hide it; any column but the unit price, the quantity and the visits qualifies, so a
    // column of leftovers right of the total (printing the unit price again) is never taken for it
    for (const tc of t.u.keys()) {
      if (tc === c || tc === pl.unitCol || [...pl.cols.values()].includes(tc)) continue;
      const printed = sold.filter((j) => solid(t, j, tc) !== null);
      const agree = printed.filter((j) => Math.abs(solid(t, j, tc)! - solid(t, j, pl.unitCol)! * q(j)!) <= 1);
      if (agree.length < 2 || agree.length * 2 <= printed.length) continue;
      for (const j of printed) out.set(j, { cents: solid(t, j, tc)!, by: "row_total", col: tc });
      return out;
    }
    const hit = prints.filter((r) => q(r.j) === r.n);
    if (hit.length < 2 || hit.length * 2 <= prints.length) continue;
    for (const r of prints) out.set(r.j, { cents: solid(t, r.j, pl.unitCol)! * q(r.j)!, by: "quantity" });
    return out;
  }
  return out;
}

/**
 * `geometryTotals`, then the read's own claims for the rows it gave nothing for: what the read says a row prints (its own total
 * column, or its quantity) is taken only where the scan prints the same figure in that very row, a total right of the visit
 * columns, a quantity left of them. The read can't make a total up: the scan has to print it there.
 */
function printedTotals(t: Table, pl: Plan, claims: ReadonlyMap<number, PrintedRow>): Map<number, { cents: number; by: "row_total" | "quantity"; col?: number }> {
  const out = geometryTotals(t, pl);
  const visitCols = new Set(pl.cols.values());
  for (const [j, c] of claims) {
    if (out.has(j)) continue;
    if (c.totalCents !== null) {
      const col = [...t.u.keys()].find((k) => k > pl.first && !visitCols.has(k) && k !== pl.unitCol && solid(t, j, k) === c.totalCents);
      if (col !== undefined) out.set(j, { cents: c.totalCents, by: "row_total", col });
    } else if (c.qty !== null && pl.unitCol >= 0 && solid(t, j, pl.unitCol) !== null) {
      const at = [...t.u.keys()].find((k) => k < pl.first && k !== pl.unitCol && ((ws) => ws.length === 1 && (ws[0]!.conf ?? 1) >= MIN_OCR_CONF && ws[0]!.text.replace(/\.00?$/, "") === String(c.qty))(t.cells[j]![k]!));
      if (at !== undefined) out.set(j, { cents: solid(t, j, pl.unitCol)! * c.qty, by: "quantity" });
    }
  }
  return out;
}

/** The rows a grid's planned tables hold, each with its boxes and what the page prints as its total (see `printedTotals`). */
function rowBandsOf(gi: number, planned: readonly Planned[], printedRows: readonly PrintedRow[]): RowBand[] {
  return planned.flatMap((d) => {
    if (!d.placed.size) return [];
    const { us, vs } = d.ruled;
    const [w, h] = [d.pg.p.width, d.pg.p.height];
    const box = (b: Box4): RowBand["box"] => {
      const [x0, y0, x1, y1] = unframe(d.dir, b);
      return [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h];
    };
    // the read's claims, by the table row each procedure was placed on
    const claims = new Map(printedRows.flatMap((c) => (c.grid === gi && d.placed.has(c.procedure) ? [[d.placed.get(c.procedure)!, c] as const] : [])));
    const totals = printedTotals(d.t, d.pl, claims);
    return [...d.placed].sort((a, b) => a[0] - b[0]).map(([pi, j]): RowBand => ({
      grid: gi,
      procedure: pi,
      documentId: d.pg.p.documentId,
      page: d.pg.p.page,
      box: box([us[0]!, vs[j]!, us.at(-1)!, vs[j + 1]!]),
      cells: [...d.pl.cols].map(([visit, c]) => {
        const cell = box([us[c]!, vs[j]!, us[c + 1]!, vs[j + 1]!]);
        const unread = (d.pg.p.unread ?? []).some((u) => u.box && u.box[0] < cell[0] + cell[2] && cell[0] < u.box[0] + u.box[2] && u.box[1] < cell[1] + cell[3] && cell[1] < u.box[1] + u.box[3]);
        return { visit, box: cell, ink: d.t.cells[j]![c]!.some((w) => !w.hidden) || unread };
      }),
      total: totals.get(j)?.cents ?? null,
      by: totals.get(j)?.by ?? null,
      covers: totals.get(j)?.col === undefined ? null : [...d.pl.cols].filter(([, c]) => c < totals.get(j)!.col!).map(([visit]) => visit),
    }));
  });
}

export function bindEvidence(rulebook: Rulebook, pages: TextPage[], printedRows: readonly PrintedRow[] = [], anchors: readonly Anchor[] = []): Bound {
  const data = new Map(pages.filter((p) => p.source === "text" || p.source === "ocr").map((p) => [`${p.documentId}#${p.page}`, pageData(p)]));
  const pageAt = (src: Provenance["source"]) => (src ? data.get(`${src.documentId}#${src.page}`) : undefined);
  const evidence: ValueEvidence[] = [];
  const bound = new Set<Word>();
  const put = (path: string, status: ValueEvidence["status"], where: PageBox[], printed: string | null, note: string | null = null, used: Word[] = [], held?: string) => {
    used.forEach((w) => bound.add(w));
    // OCR that wasn't sure of a word confirms nothing with it: the value is asked, or the contract's totals decide
    if (status === "confirmed" && used.some((w) => (w.conf ?? 1) < MIN_OCR_CONF)) return evidence.push({ path, status: "ungrounded", where, printed: null, note: "the scan is unclear here" });
    // held: asked by its table's check instead
    evidence.push({ path, status, where, printed: held ? null : printed, note, ...(held ? { held } : {}) });
  };
  const tableChecks: TableCheck[] = [];
  const blankChecks: BlankCheck[] = [];
  const rowBands: RowBand[] = [];
  // an item's row by its label and that row's own arithmetic, when every value of the item agrees with it (item(); its cap reads it)
  const rowMaths = new Map<string, { m: RowMath; p: TextPage }>();
  const itemRows: ItemRow[] = [];
  // a held table's visit columns' rules (reading frame), to tell whether a continuation page's columns are the same ones
  const ruling = new Map<string, { dir: Word["dir"]; rules: [number, number][] }>();
  const ALIGNED = 3;
  const nowhere = (src: Provenance["source"]): PageBox[] => (src ? [{ documentId: src.documentId, page: src.page, box: null }] : []);
  /**
   * A value against the figures of its kind printed where it's stated: confirmed only when every one of them says exactly
   * this value. When they differ, which one is this value's can't be told, so it's asked; when none says it, a conflict.
   * A conflict consumes nothing: none of the figures is this value, so each may be another term's (the quote was another
   * clause), and a consumed one would never be asked. One of several figures that says this value is consumed: the
   * others keep the sentence in the sweep, where it's asked with all of them.
   */
  const settle = (path: string, value: number | string, figs: Figure[], fallback: PageBox[]) => {
    const own = figs.filter((f) => f.values.includes(value));
    const one = figs.every((f) => f.values.length === 1 && f.values[0] === figs[0]!.values[0]);
    if (own.length && own.length === figs.length && one) return put(path, "confirmed", [own[0]!.at], own[0]!.printed, null, own.flatMap((f) => f.words));
    if (own.length) return put(path, "ungrounded", fallback, null, own.some((f) => f.values.length > 1) ? "the date can be read as month/day or day/month" : "printed with another figure of the same kind, so which one it is can't be told", own.flatMap((f) => f.words));
    if (figs.length && one) return put(path, "conflict", [figs[0]!.at], figs[0]!.printed, null);
    put(path, figs.length ? "conflict" : "ungrounded", fallback, null);
  };

  // Each grid's columns on each of its pages. Grids that share a page and head their tables with the same visits take
  // distinct header lines, in the order the read lists them; a grid's rows are then the lines under its own header.
  // ponytail: two such tables read in the opposite order swap bands (their cells conflict unless both read the same
  // numbers). Upgrade: match each grid's printed title above its header.
  const headersOn = new Map<string, Line[]>();
  const claimed: { row: Line; header: Line; visits: Set<string> }[] = [];
  // the drawn grid's rows (page#table#row) a grid has bound: one printed row confirms one grid's cells at most
  const gridTaken = new Set<string>();
  // the drawn tables (page#table) a grid's visit summary rows were taken from: one table belongs to one grid
  const summaryTaken = new Set<string>();
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
      last = own || (pg && last ? carried(last, pg) : last);
      colsOn.set(k, pg ? last : null);
    }
    return { pagesOf, colsOn };
  });

  // the overhead % a table's cost columns are found with: the grid's own stated one, else the contract's
  const overheadPct = (g?: BudgetGrid) => g?.statedOverheadPct ?? rulebook.overhead.pct.value ?? null;

  rulebook.budgetGrids.forEach((g, gi) => {
    const gp = `/budgetGrids/${gi}`;
    const pct = overheadPct(g);
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
    type Judged = { status: ValueEvidence["status"]; where: PageBox[]; printed: string | null; note: string | null; used: Word[]; held?: string };
    const judge = (pg: TextPage, ws: Word[], rowWords: Word[], value: number | "invoiceable", used: Word[], own: boolean, unitCents: number | null): Judged => {
      const printed = ws.length ? txt(ws) : null;
      // An "invoiceable" cell is there when the cell says so, or prints the row's price: tables print a price only under the
      // visits it applies to (owner, from the scans, 2026-10-29). Only under the page's own header: on a continuation page
      // the columns are carried over, and a price under the visit next door is the same price (one shared visit pattern
      // was confirmed there for 5 rows the read didn't list). How the row is billed is a meaning, asked as such.
      // An "invoiceable" cell keeps the plain parse: the unit price standing in for the word is an inference already, and noise
      // on top of it would stack two guesses (planted wrong-visit errors passed that way once).
      const how: Read = value === "invoiceable" ? (/invoic/i.test(printed ?? "") || (own && unitCents !== null && cents(printed) === unitCents) ? "plain" : null) : readOf(printed, value, pg.source === "ocr");
      const ok = how !== null;
      // On a scan, a blank or garbled cell is as likely the OCR's miss as the page's: it says nothing either way, so the
      // value is unfound (the totals or a person decide), not contradicted. A PDF's own blank cell is a real blank.
      // "Invoiceable" is how the read says a cell is billed, not a number the OCR can check: it decides nothing there either.
      const unread = pg.source === "ocr" && !ok && (value === "invoiceable" || printed === null || cents(printed) === null || ws.some((w) => (w.conf ?? 1) < MIN_OCR_CONF));
      const where = [boxOf(pg, ws.length ? ws : rowWords)];
      // what the cell prints belongs to a row the master holds, and its value is asked: it isn't another money term too
      if (unread) return { status: "ungrounded", where, printed: null, note: "the scan is unclear here", used: ws };
      // digits that agree but that the OCR wasn't sure of: put() downgrades them the same way
      if (ok && [...ws, ...used].some((w) => (w.conf ?? 1) < MIN_OCR_CONF)) return { status: "ungrounded", where, printed: null, note: "the scan is unclear here", used: [...ws, ...used] };
      return { status: ok ? "confirmed" : "conflict", where, printed, note: how === "noisy" ? NOISY : null, used: [...ws, ...used] };
    };
    const emit = (path: string, j: Judged) => put(path, j.status, j.where, j.printed, j.note, j.used, j.held);
    /** The table check a held table's cells ride on: an earlier one of this grid whose visit columns have the same rules, else a new one. */
    const checkFor = (pg: Page, k: string, ti: number, ruled: Piece, t: Table, pl: Plan, dir: Word["dir"]): string => {
      const order = [...g.visits].sort((a, b) => a.order - b.order);
      const rules = order.map((v): [number, number] => [ruled.us[pl.cols.get(v.code)!]!, ruled.us[pl.cols.get(v.code)! + 1]!]);
      const same = tableChecks.find((c) => {
        const r = ruling.get(c.id)!;
        return c.grid === gi && r.dir === dir && r.rules.every((x, i) => Math.abs(x[0] - rules[i]![0]) <= ALIGNED && Math.abs(x[1] - rules[i]![1]) <= ALIGNED);
      });
      if (same) return same.id;
      const id = `table:${gi}:${k}:${ti}`;
      ruling.set(id, { dir, rules });
      tableChecks.push({ id, grid: gi, page: pg.p.page, table: boxOf(pg.p, t.cells.flat(2)), columns: order.map((v) => ({ box: boxOf(pg.p, t.cells.flatMap((row) => row[pl.cols.get(v.code)!]!)), visit: v.code })), rows: [] });
      return id;
    };
    const cell = (path: string, c: NonNullable<ReturnType<typeof ctx>>, row: Line, key: string, value: number | "invoiceable", used: Word[] = [], unitCents: number | null = null) =>
      emit(path, judge(c.pg.p, cellWords(c.cols, row, key), row.words, value, used, c.pg.lines.includes(c.cols.line), unitCents));

    // Cells by the table's drawn grid, where the cited page has one that holds the table: rows lined up in order by what
    // they print, visits by their columns' headers. Anything it can't do cleanly is left to the label path below.
    const viaGrid = new Set<number>();
    // A held table's cells wait for the label path below: a cell it confirms on its own needs no person, and a table check is
    // made only when some cell is held by it. Rows in a held table aren't `viaGrid`, so the label path judges them all.
    const heldRows = new Set<number>();
    const queued: { path: string; j: Judged; check: () => string; row?: NonNullable<TableCheck["rows"]>[number] }[] = [];
    // the drawn tables this grid's rows were placed in: where the totals cascade looks for what the page prints
    const planned: (Planned & { peek: () => string | undefined })[] = [];
    const byPage = new Map<string, number[]>();
    g.procedures.forEach((p, pi) => p.prov.source && byPage.set(`${p.prov.source.documentId}#${p.prov.source.page}`, [...(byPage.get(`${p.prov.source.documentId}#${p.prov.source.page}`) ?? []), pi]));
    for (const [k, idx] of byPage) {
      const pg = data.get(k);
      if (!pg?.p.grids?.length) continue;
      const dirs = [0, 1, 2, 3].map((d) => pg.p.words.filter((w) => !w.hidden && w.dir === d).length);
      const dir = dirs.indexOf(Math.max(...dirs)) as Word["dir"];
      for (const { t: ruled, i: ti } of tablesOn(pg.p, dir)) {
        const t = tableOf(pg.p, ruled, dir);
        const rest = idx.filter((pi) => !viaGrid.has(pi) && !heldRows.has(pi));
        const mine = anchors.filter((a) => a.grid === gi && `${a.documentId}#${a.page}` === k);
        const hint = t && mine.length ? hintsFor(t, pg.p, mine, g.visits) : null;
        const pl = t && rest.length ? plan(t, g, rest, (r) => gridTaken.has(`${k}#${ti}#${r}`), pct, hint) : null;
        if (!t || !pl) continue;
        let id: string | undefined;
        const check = () => (id ??= checkFor(pg, k, ti, ruled, t, pl, dir));
        planned.push({ pg, t, pl, ruled, dir, placed: new Map(pl.rows), check, peek: () => id, k, ti });
        // rows the prices don't place, placed by order between the firm ones: held on their rows, whatever the columns
        const byOrder = place(t, idx, pl.rows, (pi, j) => !viaGrid.has(pi) && !heldRows.has(pi) && !gridTaken.has(`${k}#${ti}#${j}`));
        for (const [pi, j] of byOrder) if (pl.unfit(pi, j, false)) byOrder.delete(pi);
        for (const [pi, j] of byOrder) planned.at(-1)!.placed.set(pi, j);
        for (const [pi, j] of [...pl.rows, ...byOrder]) {
          const heldBy = pl.held || byOrder.has(pi) ? check : undefined;
          gridTaken.add(`${k}#${ti}#${j}`);
          (heldBy ? heldRows : viaGrid).add(pi);
          const p = g.procedures[pi]!;
          const pp = `${gp}/procedures/${pi}`;
          const row = t.cells[j]!;
          const rowWords = row.flat();
          // codes and counts left of the visit columns belong to this row; its prices are bound only where a value is read
          if (!heldBy) row.slice(0, pl.first).flat().forEach((w) => NUMBER.test(bare(w.text)) && !priceLike(w) && bound.add(w));
          const out = new Map<string, Judged>();
          for (const [key, value] of Object.entries(p.cells)) {
            const col = pl.cols.get(key);
            out.set(`${pp}/cells/${ptr(key)}`, col === undefined ? { status: "ungrounded", where: [boxOf(pg.p, rowWords)], printed: null, note: null, used: [] } : judge(pg.p, row[col]!, rowWords, value, [], pl.headed || !!heldBy, p.unitCents));
          }
          // The unit price: the one price left of the visit columns, or of several the one its own visit cells print most often.
          if (p.unitCents !== null) {
            const left = row.slice(0, pl.first).filter((ws, c) => t.printed[j]![c] !== null);
            const seen = [...pl.cols.values()].flatMap((c) => (t.printed[j]![c] === null ? [] : [t.printed[j]![c]!]));
            const top = [...new Set(seen)].map((v) => ({ v, n: seen.filter((x) => x === v).length })).sort((a, b) => b.n - a.n);
            // with several costs and no visit price to tell which is the unit price (an invoiceable-only row), the unit column the headers name, if no cell of the row contradicts the mapping
            const named = pl.unitCol >= 0 && t.printed[j]![pl.unitCol] !== null && ![...out.values()].some((x) => x.status === "conflict") ? row[pl.unitCol] : undefined;
            const pick = (left.length === 1 ? left[0] : top.length && !(top[1] && top[1].n === top[0]!.n) ? left.find((ws) => cents(txt(ws)) === top[0]!.v) : undefined) ?? named;
            out.set(`${pp}/unitCents`, pick ? judge(pg.p, pick, rowWords, p.unitCents, [], true, null) : { status: "ungrounded", where: [boxOf(pg.p, rowWords)], printed: null, note: null, used: [] });
          }
          // Third check, from the printed page alone: the row's own total. With every other visit cell confirmed (or blank on
          // both sides) and exactly one the scan leaves unread, the cell whose read value makes the sum exact is confirmed.
          // Two unconfirmed cells would let a wrong pair cancel out, so then nothing is confirmed by it.
          let [sum, open, clean] = [0, null as string | null, true];
          for (const [key, col] of pl.cols) {
            const value = p.cells[key];
            const r = out.get(`${pp}/cells/${ptr(key)}`);
            if (value === undefined) clean &&= !row[col]!.length;
            else if (value === "invoiceable") clean = false;
            else if (r?.status === "confirmed") sum += value;
            else if (r?.status === "ungrounded" && open === null) open = key;
            else clean = false;
          }
          if (Object.keys(p.cells).some((key) => !pl.cols.has(key))) clean = false;
          const target = open === null ? null : p.cells[open];
          if (clean && open !== null && typeof target === "number" && sum + target > 0) {
            const total = row.slice(pl.last + 1).find((ws) => says(t, j, row.indexOf(ws), sum + target) !== null && ws.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF));
            const path = `${pp}/cells/${ptr(open)}`;
            if (total) {
              const was = out.get(path)!;
              row[pl.cols.get(open)!]!.forEach((w) => bound.add(w));
              out.set(path, { status: "confirmed", where: was.where, printed: null, note: "the row's printed total confirms it" + (says(t, j, row.indexOf(total), sum + target) === "noisy" ? ` (${NOISY})` : ""), used: total });
            }
          }
          // held: what would be confirmed waits for the person's word on the columns; anything else is left to the label path
          for (const [path, j2] of out) {
            if (!heldBy) emit(path, j2);
            else if (j2.status === "confirmed") queued.push({ path, j: { ...j2, status: "ungrounded", note: "waiting for someone to confirm which visit each column is" }, check: heldBy, ...(byOrder.has(pi) ? { row: { box: boxOf(pg.p, rowWords), procedure: pi } } : {}) });
          }
        }
      }
    }

    // Grid cells, by the row's label and the visit's column. One printed row per item: best label matches claim rows first.
    const options = g.procedures.flatMap((p, pi) => {
      if (viaGrid.has(pi)) return [];
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
    // A row whose name the page prints differently (the read words it its own way): the one printed line that holds every
    // price of the row, two at least, and a word of its name on or beside it (owner, 2026-10-29). A misread price is on no
    // line, so the row stays unfound and asked; each cell is still checked in its own visit's column.
    g.procedures.forEach((p, pi) => {
      const c = ctx(p.prov.source);
      if (rowOf.has(pi) || !c || viaGrid.has(pi)) return;
      const want = [...Object.values(p.cells).filter((v): v is number => typeof v === "number"), ...(p.unitCents !== null ? [p.unitCents] : [])];
      if (want.length < 2) return;
      const name = tokens(p.name);
      const labelled = (l: Line) =>
        c.lines
          .filter((x) => x.dir === l.dir && Math.abs(x.v - l.v) <= 2 * Math.max(x.h, l.h))
          .flatMap((x) => x.words.filter((w) => frame(w)[2] <= c.cols.left).map((w) => norm(w.text)))
          .some((t) => name.some((n) => sameToken(n, t)));
      const fits = c.cands.filter((l) => {
        const ocr = c.pg.p.source === "ocr";
        const have = l.words.filter(priceLike);
        return want.every((v) => {
          const i = have.findIndex((w) => readOf(w.text, v, ocr));
          return i >= 0 && have.splice(i, 1);
        });
      });
      const row = fits.length === 1 ? fits[0]! : null;
      if (!row || procRows.has(row) || !labelled(row)) return;
      const o = { row, code: null, score: 0, pi, header: c.cols.line };
      if (theirs(o)) return;
      rowOf.set(pi, o);
      procRows.add(row);
      options.push(o);
    });
    for (const o of options) if (rowOf.get(o.pi) === o) claimed.push({ row: o.row, header: o.header, visits });
    // The unit price of a row no planned table took: the row of a table with cost columns whose label fits its name, and its
    // cell before overhead (byCosts). Used only where the label path above has no unit column of its own to judge it by.
    const unitHits = new Map<number, CostHit>();
    const unitPages = new Map<string, number[]>();
    g.procedures.forEach((p, pi) => {
      const src = p.prov.source;
      if (src && p.unitCents !== null && !viaGrid.has(pi) && !heldRows.has(pi)) unitPages.set(`${src.documentId}#${src.page}`, [...(unitPages.get(`${src.documentId}#${src.page}`) ?? []), pi]);
    });
    for (const [k, idx] of unitPages) {
      const pg = data.get(k);
      if (pg?.p.grids?.length) byCosts(pg, pct, idx.map((pi) => ({ name: g.procedures[pi]!.name, base: g.procedures[pi]!.unitCents, incl: null }))).forEach((h, n) => h && unitHits.set(idx[n]!, h));
    }
    g.procedures.forEach((p, pi) => {
      if (viaGrid.has(pi)) return;
      const pp = `${gp}/procedures/${pi}`;
      const c = ctx(p.prov.source);
      const found = rowOf.get(pi);
      // Numbers outside the price columns of a row the master holds (code, count) belong to that row; they aren't prices.
      if (c && found) for (const w of found.row.words) if (NUMBER.test(bare(w.text)) && frame(w)[2] <= c.cols.left && !columnOf(c.cols, w)) bound.add(w);
      const entries: [string, string, number | "invoiceable"][] = Object.entries(p.cells).map(([k, v]) => [`${pp}/cells/${ptr(k)}`, k, v]);
      if (p.unitCents !== null) entries.push([`${pp}/unitCents`, "#unit", p.unitCents]);
      // The unit price, where a table prints more than one cost before its visits (with and without overhead, say): of the
      // row's prices left of the visit columns, the one equal to the price its own visit cells print most often. The page
      // agreeing with itself, not with the read; with no single such price, the unit column as headed.
      const unit = c && found ? unitOnRow(c.cols, found.row) : null;
      for (const [path, key, value] of entries) {
        if (key === "#unit" && unit && typeof value === "number") {
          const how = readOf(unit.text, value, c!.pg.p.source === "ocr");
          put(path, how ? "confirmed" : "conflict", [boxOf(c!.pg.p, [unit])], unit.text, how === "noisy" ? NOISY : null, [unit]);
        }
        else if (key === "#unit" && unitHits.has(pi) && !(c && found && c.cols.unit)) {
          const h = unitHits.get(pi)!;
          const where = [boxOf(pageAt(p.prov.source)!.p, h.base.length ? h.base : h.row)];
          if (h.ok.base) put(path, "confirmed", where, txt(h.base), h.noisy.base ? NOISY : null, [...h.base, ...h.also, ...h.left.filter((w) => NUMBER.test(bare(w.text)) && !priceLike(w))]);
          else put(path, h.sure.base ? "conflict" : "ungrounded", where, h.sure.base ? txt(h.base) : null, h.sure.base ? null : "the scan is unclear here", h.sure.base ? [] : h.base);
        } else if (!c || !found || (key === "#unit" ? !c.cols.unit : !c.cols.at.has(key))) put(path, "ungrounded", found && c ? [boxOf(c.pg.p, found.row.words)] : nowhere(p.prov.source), null);
        else cell(path, c, found.row, key, value, found.code ? [found.code] : [], p.unitCents);
      }
    });

    // Visit totals and subtotals: rows found by their printed label.
    const LABELS = VISIT_LABELS;
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
    // a line printing this total times the patients its page states is their total (multiPatientTotals), never this one's row
    g.perPatientTotals.forEach((t, ti) => {
      const band = ctx(t.prov.source)?.band;
      const counts = patientCounts(pageAt(t.prov.source)?.lines.map((l) => txt(l.words)).join("\n") ?? "");
      const several = (l: Line) => amounts(l.words).some((a) => a.cents !== null && !!patientsTimes(a.cents, [t.cents], counts));
      item(`${gp}/perPatientTotals/${ti}`, null, t.label, t.prov, [["cents", t.cents]], (l) => (!band || band(l)) && !several(l));
    });

    // What the label path left unconfirmed (and didn't see conflict) in a held table is held; the rest stays as it judged it.
    for (const { path, j, check, row } of queued) {
      const at = evidence.findIndex((e) => e.path === path);
      if (at >= 0 && evidence[at]!.status !== "ungrounded") continue;
      if (at >= 0) evidence.splice(at, 1);
      const id = check();
      emit(path, { ...j, held: id });
      const rows = (tableChecks.find((c) => c.id === id)!.rows ??= []);
      if (row && !rows.some((r) => r.procedure === row.procedure)) rows.push(row);
    }

    blankChecks.push(...blankInvoiceable(gi, g, planned, evidence));
    rowBands.push(...rowBandsOf(gi, planned, printedRows));

    /**
     * The totals cascade. A visit's overhead, subtotal, non-procedure amount and total, and a per-patient total, that the label
     * path left unfound: in a planned table, the one row labelled for it prints the read's amount (OCR digits, conf >= 0.8) in
     * the visit's column. A subtotal, non-procedure amount, total or per-patient total also has to add up from its parts, each
     * confirmed or held (never the other way round: a total confirms no part). Confirmed when every part is; held when any part,
     * or the table's column mapping, is, and then all by one table check, else it stays asked.
     */
    // The grid's visit summary tables: drawn tables of its visits' pages that no row was planned in (summaryPlan).
    for (const k of new Set(g.visits.flatMap((v) => (v.prov.source ? [`${v.prov.source.documentId}#${v.prov.source.page}`] : [])))) {
      const pg = data.get(k);
      if (!pg?.p.grids?.length) continue;
      const dir = domDir(pg.p);
      for (const { t: ruled, i: ti } of tablesOn(pg.p, dir)) {
        if (planned.some((d) => d.k === k && d.ti === ti) || summaryTaken.has(`${k}#${ti}`)) continue;
        const t = tableOf(pg.p, ruled, dir);
        const pl = t && summaryPlan(t, g);
        if (!t || !pl) continue;
        summaryTaken.add(`${k}#${ti}`);
        let id: string | undefined;
        planned.push({ pg, t, pl, ruled, dir, placed: new Map(), check: () => (id ??= checkFor(pg, k, ti, ruled, t, pl, dir)), peek: () => id, k, ti });
      }
    }

    {
      const live = (path: string) => evidence.find((e) => e.path === path);
      // Only `confirmed` (or held) counts here, and `confirmed_by_math` can't occur yet: the binder runs before the solver
      // (reviewDraft), so no entry has that status in this list. A total is settled from its parts printed on the page; a
      // part the arithmetic alone proved would make the total "proved by itself", so even after the solver exists it stays out.
      const sure = (path: string) => {
        const e = live(path);
        return !!e && (e.status === "confirmed" || !!e.held);
      };
      const open = (path: string) => live(path)?.status === "ungrounded" && !live(path)!.held;
      const rowsLabelled = (find: (label: string) => boolean, atVisits = true) => planned.flatMap((d) => d.t.cells.flatMap((row, j) => (find(txt(row.slice(0, d.pl.first).flat())) && (!atVisits || [...d.pl.cols.values()].some((c) => present(d.t, j, c))) ? [{ d, row }] : [])));
      const agrees = (ws: Word[], value: number, ocr: boolean) => ws.length > 0 && readOf(txt(ws), value, ocr) !== null && ws.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF);
      const settleOn = (path: string, found: { d: (typeof planned)[number]; ws: Word[] }, parts: string[], byMapping: boolean, value: number) => {
        const ids = new Set(parts.flatMap((x) => live(x)?.held ?? []));
        if (ids.size > 1) return;
        let id = [...ids][0];
        // a held mapping puts the printed cell under that table's check, which can't be another check than the parts'
        if (byMapping && found.d.pl.held) {
          if (ids.size && found.d.peek() !== id) return;
          id = found.d.check();
        }
        evidence.splice(evidence.findIndex((e) => e.path === path), 1);
        put(path, id === undefined ? "confirmed" : "ungrounded", [boxOf(found.d.pg.p, found.ws)], txt(found.ws), "its parts are confirmed and add up to it, and the page prints it" + (readOf(txt(found.ws), value, found.d.pg.p.source === "ocr") === "noisy" ? ` (${NOISY})` : ""), found.ws, id);
      };
      const cellsAt = (code: string, category: "procedure" | "non_procedure") => g.procedures.flatMap((p, pi) => (p.category === category && typeof p.cells[code] === "number" ? [{ path: `${gp}/procedures/${pi}/cells/${ptr(code)}`, v: p.cells[code] as number }] : []));
      // The overhead the grid's stated % comes to at a visit: of the read's cells of the rows marked overhead-applied there, within the rounding of
      // one cent for every two of them. The page's own digits decide a value; this is the read agreeing with itself.
      const overheadAt = (v: BudgetGrid["visits"][number]) => {
        const applied = g.procedures.filter((p) => p.overheadApplied && typeof p.cells[v.code] === "number");
        const base = applied.reduce((n, p) => n + (p.cells[v.code] as number), 0);
        return { e: g.statedOverheadPct === null ? null : (base * g.statedOverheadPct) / 100, tol: Math.max(1, Math.ceil(applied.length / 2)) };
      };
      // An overhead row whose label the scan lost: the one row of a planned table with no label that prints, at every visit it prints at (three
      // at least, most of the visits that have overhead), what the stated % comes to there. A row of procedure prices never does.
      const lostOverhead =
        g.statedOverheadPct === null
          ? []
          : planned.flatMap((d) =>
              d.t.cells.flatMap((row, j) => {
                if (txt(row.slice(0, d.pl.first).flat()).trim()) return [];
                const seen = g.visits.flatMap((v) => {
                  const [{ e, tol }, c] = [overheadAt(v), d.pl.cols.get(v.code)];
                  const x = c === undefined ? null : solid(d.t, j, c);
                  return e === null || x === null ? [] : [Math.abs(x - e) <= tol];
                });
                const wanted = g.visits.filter((v) => (overheadAt(v).e ?? 0) > 0).length;
                return seen.length >= 3 && seen.every(Boolean) && seen.length >= 0.8 * wanted ? [{ d, row }] : [];
              }),
            );
      g.visits.forEach((v, vi) => {
        const at = (f: keyof typeof LABELS) => `${gp}/visits/${vi}/${f}`;
        const sumOf = (xs: { v: number }[]) => xs.reduce((a, x) => a + x.v, 0);
        const fields: [keyof typeof LABELS, string[], number][] = [
          ["overheadCents", [], v.overheadCents ?? 0],
          ["nonProcedureCents", cellsAt(v.code, "non_procedure").map((x) => x.path), sumOf(cellsAt(v.code, "non_procedure"))],
          ["procedureSubtotalCents", cellsAt(v.code, "procedure").map((x) => x.path), sumOf(cellsAt(v.code, "procedure"))],
          ["totalCents", [at("procedureSubtotalCents"), at("overheadCents"), ...(v.nonProcedureCents !== null ? [at("nonProcedureCents")] : [])], (v.procedureSubtotalCents ?? 0) + (v.overheadCents ?? 0) + (v.nonProcedureCents ?? 0)],
        ];
        for (const [f, parts, total] of fields) {
          const value = v[f];
          if (value === null || !open(at(f))) continue;
          // overhead is the grid's stated % of what it applies to
          if (f === "overheadCents") {
            const { e, tol } = overheadAt(v);
            if (e !== null && Math.abs(value - e) > tol) continue;
          }
          // the parts add up to it and are all in hand (a total with no overhead or no subtotal read has no parts to add)
          if (f !== "overheadCents" && (value !== total || !parts.length || !parts.every(sure) || (f === "totalCents" && (v.procedureSubtotalCents === null || v.overheadCents === null)))) continue;
          const labelled = rowsLabelled(LABELS[f]);
          const hits = (f === "overheadCents" && !labelled.length && lostOverhead.length === 1 ? lostOverhead : labelled).flatMap(({ d, row }) => (d.pl.cols.has(v.code) ? [{ d, ws: row[d.pl.cols.get(v.code)!]! }] : []));
          if (hits.length === 1 && agrees(hits[0]!.ws, value, hits[0]!.d.pg.p.source === "ocr")) {
            settleOn(at(f), hits[0]!, parts, true, value);
            continue;
          }
          // No labelled row to find it by (the scan lost the label, or the table is none the plan took): the word the read pointed at
          // for it, when that word says this amount. The parts' sum (or the stated overhead %) is what proves it; the pointer says where.
          const a = anchors.find((x) => x.grid === gi && x.procedure === null && x.field === ANCHOR_FIELD[f] && x.visit === v.code);
          const pg = a && data.get(`${a.documentId}#${a.page}`);
          const word = pg?.p.words[a!.word];
          if (!pg || !word || word.hidden || bound.has(word)) continue;
          const into = planned.find((d) => d.pg === pg && d.t.cells.some((row) => row.some((ws) => ws.includes(word))));
          const cell = into?.t.cells.flatMap((row) => row.filter((ws) => ws.includes(word)))[0];
          // inside a drawn table the pointed cell is in the visit's own column, else it points at another visit's figure
          if (into && cell && into.pl.cols.get(v.code) !== into.t.cells.flatMap((row) => row.map((ws, c) => (ws === cell ? c : -1))).find((c) => c >= 0)) continue;
          const ws = cell ?? [word];
          if (!agrees(ws, value, pg.p.source === "ocr")) continue;
          const ids = new Set(parts.flatMap((x) => live(x)?.held ?? []));
          if (ids.size > 1) continue;
          evidence.splice(evidence.findIndex((e) => e.path === at(f)), 1);
          put(at(f), ids.size ? "ungrounded" : "confirmed", [boxOf(pg.p, ws)], txt(ws), "the read pointed at it on the page, it says this amount" + (f === "overheadCents" ? ", and it is the grid's stated overhead %" : ", and its parts are confirmed and add up to it") + (readOf(txt(ws), value, pg.p.source === "ocr") === "noisy" ? ` (${NOISY})` : ""), ws, [...ids][0]);
        }
      });
      // a per-patient total: the sum of every visit's total, printed on its own labelled row
      g.perPatientTotals.forEach((pt, ti) => {
        const path = `${gp}/perPatientTotals/${ti}/cents`;
        const parts = g.visits.map((_, vi) => `${gp}/visits/${vi}/totalCents`);
        if (!open(path) || !parts.every(sure) || g.visits.reduce((a, v) => a + v.totalCents, 0) !== pt.cents) return;
        const hits = rowsLabelled((l) => /total/i.test(l) && /patient|subject/i.test(l), false).flatMap(({ d, row }) => row.slice(d.pl.first).filter((ws) => agrees(ws, pt.cents, d.pg.p.source === "ocr")).map((ws) => ({ d, ws })));
        if (hits.length === 1) settleOn(path, hits[0]!, parts, false, pt.cents);
      });
    }

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
   * the lines the row may be on (a grid's band, when another grid shares the page). `cap`: the item's cap, which its row's
   * own arithmetic (rowMath) must agree with too before it tells anything.
   */
  function item(base: string, code: string | null, name: string, prov: Provenance, fields: [string, number | null][], within: (l: Line) => boolean = () => true, hit: CostHit | null = null, cap: Limit | null = null) {
    const src = prov.source;
    const pg = pageAt(src);
    const lineAmounts = (pg: Page) => pg.lines.filter((l) => within(l) && amounts(l.words).length);
    const found = pg ? rowsFor(pg.lines.filter(within), lineAmounts(pg), code, name)[0] : undefined;
    // Numbers on the item's row other than amounts and figures with a unit (code, count) belong to it once its value is
    // found there; "30 days", "10%" or a limit ("up to 3 per subject": a cap the read may not have) is a term of its own.
    const rowNumbers = (l: Line) => {
      const units = new Set(scan(l.words).flatMap((x) => (x.unit ? x.words : [])));
      return l.words.filter((w, i) => NUMBER.test(bare(w.text)) && !units.has(w) && !limited(l.words, i, i) && !amounts(l.words).some((a) => a.words.includes(w)));
    };
    const onRow = found ? amounts(found.row.words, false, pg!.before) : [];
    const quote = pg ? findQuote(pg, src?.quote) : null;
    const inQuote = quote ? amounts(quote, false, pg!.before) : [];
    const want = fields.filter((f): f is [string, number] => f[1] !== null);
    // Two prices and two amounts on the row (or in the quote): by position, base price then price with overhead, as tables print them.
    // ponytail: a table printing them the other way round gives conflicts. Upgrade: read the order from the column headers.
    const positional = want.length === 2 && onRow.length >= 2;
    // One amount wanted, a row printing others too ("$500.00, up to $5,000.00"; "$100.00 $130.00" with one of them read):
    // which one is this value can't be told, so as settle() does, it's asked, and the others stay unaccounted. A conflict,
    // as in settle(), consumes nothing on the row: no amount there is this value, so each may be another term's (the row
    // may be another term's line, "$0.655 per mile … visit" for a visit fee), and it would never be swept as a money term.
    // on a scan an amount says a value allowing for the OCR's usual misreadings too (saysAmount); the amounts found are still
    // only the ones `amounts` calls amounts, so a bare "185,00" with no "$" is no amount here, as before
    const ocr = pg?.p.source === "ocr";
    const alone = (as: { words: Word[]; cents: number | null }[], value: number, i: number, ocr: boolean) => (want.length === 2 && as.length >= 2 ? saysAmount(as[i]!, value, ocr) !== null : as.every((a) => saysAmount(a, value, ocr) !== null));
    // The row's own arithmetic, when the item's values all agree with it: its price is the unit price (either of the two the
    // read has), an amount cap is the total and a count cap the quantity. Any value that disagrees and the row tells nothing.
    const ways = found ? rowIdentities(found.row.words, pg!.before) : [];
    const math = ways.length === 1 ? ways[0] : undefined;
    const agrees =
      !!math &&
      (!want.length || want.some(([, v]) => v === math.unit.cents)) &&
      (!cap || cap.n === null || (cap.kind === "amount" ? cap.n === math.total.cents : cap.kind !== "count" || cap.n === math.n));
    if (math && agrees && !hit) rowMaths.set(base, { m: math, p: pg!.p });
    // the sweep's: the row's three figures, when every way it multiplies uses the same three ("1 × X = X" read both ways round)
    const figures = ways.length && !hit ? [[ways[0]!.qty], ways[0]!.unit.words, ways[0]!.total.words] : [];
    const same = (w: RowMath) => [w.qty, ...w.unit.words, ...w.total.words].every((x) => figures.flat().includes(x));
    if (figures.length && ways.every(same)) itemRows.push({ item: base, documentId: pg!.p.documentId, page: pg!.p.page, row: boxOf(pg!.p, found!.row.words).box!, figures: figures.map((ws) => boxOf(pg!.p, ws).box!) });
    want.forEach(([field, value], i) => {
      const path = `${base}/${field}`;
      // the cell at its cost column in the row of a drawn table (byCosts) says it: confirmed, with the row's other numbers (quantity,
      // code) its own; or says another amount: asked, and the line's other amounts are not looked at
      if (hit) {
        const [cell, ok, sure] = field === "amountWithOverheadCents" ? [hit.incl, hit.ok.incl, hit.sure.incl] : [hit.base, hit.ok.base, hit.sure.base];
        const where = [boxOf(pg!.p, cell.length ? cell : hit.row)];
        if (ok) return put(path, "confirmed", where, txt(cell), (field === "amountWithOverheadCents" ? hit.noisy.incl : hit.noisy.base) ? NOISY : null, [...cell, ...hit.also, ...hit.left.filter((w) => NUMBER.test(bare(w.text)) && !priceLike(w))]);
        return put(path, sure ? "conflict" : "ungrounded", where, sure ? txt(cell) : null, sure ? null : "the scan is unclear here", sure ? [] : cell);
      }
      const spot = positional ? onRow[i] : onRow.find((a) => saysAmount(a, value, ocr));
      const used = found?.code ? [found.code] : [];
      const how = spot ? saysAmount(spot, value, ocr) : null;
      // several amounts on the row: its quantity × unit price = total tells which is the price, its quantity is its own (the total is left to a cap)
      if (how && !alone(onRow, value, i, ocr) && want.length === 1 && agrees && math.unit.cents === value)
        return put(path, "confirmed", [boxOf(pg!.p, math.unit.words)], txt(math.unit.words), ROW_ARITHMETIC, [...math.unit.words, math.qty, ...used, ...rowNumbers(found!.row)]);
      if (how && !alone(onRow, value, i, ocr))
        return put(path, "ungrounded", [boxOf(pg!.p, found!.row.words)], null, "printed with another amount on the same line, so which one it is can't be told", [...onRow.filter((a) => saysAmount(a, value, ocr)).flatMap((a) => a.words), ...used, ...rowNumbers(found!.row)]);
      if (how) return put(path, "confirmed", [boxOf(pg!.p, spot!.words)], txt(spot!.words), how === "noisy" ? NOISY : null, [...spot!.words, ...used, ...rowNumbers(found!.row)]);
      if (onRow.length) {
        const shown = positional ? [onRow[i]!] : onRow.filter((a) => !want.some(([, c]) => saysAmount(a, c, ocr)));
        return put(path, "conflict", [boxOf(pg!.p, found!.row.words)], txt(shown.flatMap((a) => a.words)) || null, null);
      }
      if (inQuote.length) {
        // an amount that says this value (on a scan, through its usual misreadings) stands for it, so settle() judges it as exact
        const figs = (want.length === 2 && inQuote.length === 2 ? [inQuote[i]!] : inQuote).map((a) => ({ words: a.words, values: saysAmount(a, value, ocr) ? [value] : a.cents === null ? [] : [a.cents], printed: txt(a.words), at: boxOf(pg!.p, a.words) }));
        return settle(path, value, figs, [boxOf(pg!.p, quote!)]);
      }
      // Wrong page reference: label and this amount on one line of exactly one other page of the same document.
      const elsewhere = [...data.values()].flatMap((o) => {
        if (!src || o.p.documentId !== src.documentId || o.p.page === src.page) return [];
        const lines = o.lines.filter((l) => {
          const as = amounts(l.words, false, o.before);
          return rowsFor([l], [l], code, name).length && as.some((a) => saysAmount(a, value, o.p.source === "ocr")) && alone(as, value, i, o.p.source === "ocr");
        });
        return lines.length ? [{ o, l: lines[0]! }] : [];
      });
      if (elsewhere.length === 1) {
        const { o, l } = elsewhere[0]!;
        const a = amounts(l.words, false, o.before).find((x) => saysAmount(x, value, o.p.source === "ocr"))!;
        return put(path, "confirmed", [boxOf(o.p, a.words)], txt(a.words), `page reference corrected from ${src!.page} to ${o.p.page}` + (saysAmount(a, value, o.p.source === "ocr") === "noisy" ? ` (${NOISY})` : ""), [...a.words, ...rowNumbers(l)]);
      }
      put(path, "ungrounded", nowhere(src), null);
    });
  }

  // Invoiceable items and site fees found by their row in a drawn table with cost columns (byCosts), page by page.
  const costHits = new Map<string, CostHit>();
  {
    const by = new Map<string, { key: string; name: string; base: number | null; incl: number | null }[]>();
    const add = (key: string, x: { name: string; prov: Provenance }, base: number | null, incl: number | null) => {
      const k = x.prov.source ? `${x.prov.source.documentId}#${x.prov.source.page}` : "";
      by.set(k, [...(by.get(k) ?? []), { key, name: x.name, base, incl }]);
    };
    rulebook.invoiceables.forEach((x, i) => add(`/invoiceables/${i}`, x, x.amountCents, x.amountWithOverheadCents));
    rulebook.siteFees.forEach((x, i) => add(`/siteFees/${i}`, x, x.amountCents, null));
    for (const [k, things] of by) {
      const pg = data.get(k);
      if (pg?.p.grids?.length) byCosts(pg, overheadPct(rulebook.budgetGrids[0]), things).forEach((h, n) => h && costHits.set(things[n]!.key, h));
    }
  }
  rulebook.invoiceables.forEach((x, i) => item(`/invoiceables/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents], ["amountWithOverheadCents", x.amountWithOverheadCents]], undefined, costHits.get(`/invoiceables/${i}`), x.cap));
  rulebook.siteFees.forEach((x, i) => item(`/siteFees/${i}`, x.code, x.name, x.prov, [["amountCents", x.amountCents]], undefined, costHits.get(`/siteFees/${i}`)));
  if (rulebook.screenFail) item("/screenFail", null, "screen failure", rulebook.screenFail.prov, [["amountCents", rulebook.screenFail.amountCents]], undefined, null, rulebook.screenFail.cap);

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
  const cap = (base: string, c: Limit, prov: Provenance, about?: RegExp) => {
    rule(`${base}/cap/n`, c.n, prov, c.kind === "amount" ? "cents" : "count", about);
    // what its quote leaves unfound (never a conflict: the quote then states another limit), the item's row may print: an amount
    // cap as the row's total, a count cap as its quantity, by the row's own arithmetic that every value of the item agrees with
    const row = rowMaths.get(base);
    const at = evidence.findIndex((e) => e.path === `${base}/cap/n`);
    if (row && at >= 0 && evidence[at]!.status === "ungrounded" && (c.kind === "amount" || c.kind === "count")) {
      const ws = c.kind === "amount" ? row.m.total.words : [row.m.qty];
      evidence.splice(at, 1);
      put(`${base}/cap/n`, "confirmed", [boxOf(row.p, ws)], txt(ws), ROW_ARITHMETIC, ws);
    }
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
  return { evidence, unaccounted, tableChecks, blankChecks, rows: rowBands, itemRows };
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

/** The question for one value; the value is shown beside it with what we suggest (ADR-003). */
function ask(rb: Rulebook, path: string): Pick<ReviewItem, "question" | "input"> {
  const q = (s: string) => `"${s.trim()}"`;
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
 * The review queue for a draft: a "what does the page say" item for every value the text didn't confirm, and
 * one item per line or sentence of the contract with money terms the master doesn't hold.
 */
export function reviewFromEvidence(evidence: ValueEvidence[], unaccounted: Span[], rulebook: Rulebook, tableChecks: TableCheck[] = []): ReviewItem[] {
  const base = { answer: null, outcome: null, compare: null, blocking: true, sentBack: null } as const;
  // a held value has no question of its own: its table's check is asked once for all of them
  const tables: ReviewItem[] = tableChecks.map((c) => ({
    ...base,
    id: c.id,
    kind: "confirm_value",
    reason: "TABLE_CHECK",
    path: null,
    question: "Which visit is each highlighted column?",
    input: null,
    options: [],
    where: [c.table],
  }));
  const confirm: ReviewItem[] = evidence
    .filter((e) => (e.status === "conflict" || e.status === "ungrounded") && !e.held)
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
      quoted: [...new Map(ss.flatMap((s) => s.lines).map((l) => [JSON.stringify(l), l])).values()],
    };
  });
  return [...tables, ...confirm, ...terms];
}
