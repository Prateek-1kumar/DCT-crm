import { AMOUNT_IN_NAME, type BudgetGrid, datesIn, type PageBox, type Provenance, type ReviewItem, type Rulebook, type ValueEvidence } from "@dct/shared";
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

/**
 * Header cells stacked over two or three lines ("Visit 1" above "Day 1"), with their top on line `l`: each line's words
 * are cut into cells at gaps wider than the text is tall, and cells on `l` and the lines just below it that overlap along
 * the text are one column. Read top to bottom.
 */
function stacked(pg: Page, l: Line): Word[][] {
  // the header ends where the table's prices start
  const below = pg.lines.filter((x) => x.dir === l.dir && x.v >= l.v && x.v - l.v <= 2.5 * l.h).sort((a, b) => a.v - b.v);
  const end = below.findIndex((x) => x.words.some(priceLike));
  const lines = end < 0 ? below : below.slice(0, end);
  if (lines.length < 2) return [];
  const cells = lines.flatMap((x) =>
    x.words.reduce<Word[][]>((cs, w, i) => {
      const prev = x.words[i - 1];
      if (prev && frame(w)[0] - frame(prev)[2] < frame(w)[3] - frame(w)[1]) cs.at(-1)!.push(w);
      else cs.push([w]);
      return cs;
    }, []),
  );
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
type Table = { cells: Word[][][]; u: Span2[]; printed: (number | null)[][] };

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
  return { cells, u, printed };
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
type Plan = { rows: Map<number, number>; cols: Map<string, number>; first: number; last: number; held: boolean; headed: boolean; unfit: (pi: number, j: number, byPrice: boolean) => boolean };

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
    const k = t.printed[r]!.findIndex((x) => x !== null);
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
function plan(t: Table, g: BudgetGrid, rows: number[], taken: (r: number) => boolean): Plan | null {
  const labels = rowLabels(t);
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
      if (taken(j) || (TOTALISH.test(txt(labels[j]!)) && !TOTALISH.test(p.name))) return 0;
      const have = t.printed[j]!.filter((x) => x !== null);
      if (!want.length || !want.every((v) => { const k = have.indexOf(v); return k >= 0 && have.splice(k, 1); })) return 0;
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
  const data = t.u.flatMap((_, c) => (used.some((r) => t.printed[r]![c] !== null) ? [c] : []));
  const unit = Math.max(-1, ...data.filter((c) => UNIT.test(head(c)) && !/total/i.test(head(c))));
  // The visit columns: a run of as many columns as the read's visits, with every printed column right of the unit ones in
  // it or left of it and a header over each that doesn't contradict its visit. The one such run, or of several the one from
  // the first printed column to the last (a column between two that print is a visit's too, blank in every matched row or
  // not). A total, and a gap between pieces (no word in it anywhere), is no visit's.
  const visits = [...g.visits].sort((a, b) => a.order - b.order);
  const pool = t.u.flatMap((_, c) => (c > unit && t.cells.some((row) => row[c]!.length) && !/total/i.test(head(c)) ? [c] : []));
  const runs = pool.flatMap((_, i) => (i + visits.length <= pool.length ? [pool.slice(i, i + visits.length)] : []));
  const [first, last] = [data.find((c) => c > unit) ?? -1, pool.filter((c) => c <= data.at(-1)!).at(-1)];
  const clear = runs.filter((r) => data.every((c) => c <= unit || c < r[0]! || r.includes(c) || /total/i.test(head(c))));
  const pick = (rs: number[][]) => (rs.length === 1 ? rs[0] : rs.find((r) => r[0] === first && r.at(-1) === last));
  const fits = clear.filter((r) => headerAgrees(visits, r.map(head)));
  // ponytail: held only when no run's headers agree at all; several that do, none the printed span, stay unmapped. Upgrade: ask which run.
  const loose = fits.length ? undefined : pick(clear.filter((r) => !headerFit(visits, r.map(head)).contradicts));
  const visitCols = pick(fits) ?? loose ?? [];
  if (visitCols.length !== visits.length) return null;
  const held = !!loose;
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
    const blank = Object.entries(p.cells).some(([code, v]) => typeof v === "number" && t.printed[j]![cols.get(code) ?? -1] == null);
    // Held: the columns aren't vouched for, so a row the read gives fewer than two prices (the unit price counts) must print
    // something in every cell the read gives it, "invoiceable" ones too. One price and a shared word of its name fit a
    // sibling row too (a planted digit in a unit price did), and only the pattern of printed cells tells them apart.
    const thin = byPrice && held && Object.values(p.cells).filter((v) => typeof v === "number").length + (p.unitCents !== null ? 1 : 0) < 2 && Object.keys(p.cells).some((code) => !t.cells[j]![cols.get(code) ?? -1]?.length);
    return blank || thin || (alone && [...cols.values()].some((c) => t.printed[j]![c] != null && !at.includes(c)));
  };
  for (const [pi, j] of found) if (unfit(pi, j, true)) found.delete(pi);
  if (!found.size) return null;
  return { rows: found, cols, first: visitCols[0]!, last: visitCols.at(-1)!, held, headed, unfit };
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
type Bound = { evidence: ValueEvidence[]; unaccounted: Span[]; tableChecks: TableCheck[] };

export function bindEvidence(rulebook: Rulebook, pages: TextPage[]): Bound {
  const data = new Map(pages.filter((p) => p.source === "text" || p.source === "ocr").map((p) => [`${p.documentId}#${p.page}`, pageData(p)]));
  const pageAt = (src: Provenance["source"]) => (src ? data.get(`${src.documentId}#${src.page}`) : undefined);
  const evidence: ValueEvidence[] = [];
  const bound = new Set<Word>();
  const put = (path: string, status: ValueEvidence["status"], where: PageBox[], printed: string | null, note: string | null = null, used: Word[] = [], held?: string) => {
    used.forEach((w) => bound.add(w));
    // OCR that wasn't sure of a word confirms nothing with it: the value is asked, or the contract's totals decide
    if (status === "confirmed" && used.some((w) => (w.conf ?? 1) < MIN_OCR_CONF)) return evidence.push({ path, status: "ungrounded", where, printed: null, note: "the scan is unclear here" });
    // held: not shown what the page prints (blind entry), and not asked: its table's check is
    evidence.push({ path, status, where, printed: held ? null : printed, note, ...(held ? { held } : {}) });
  };
  const tableChecks: TableCheck[] = [];
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
    type Judged = { status: ValueEvidence["status"]; where: PageBox[]; printed: string | null; note: string | null; used: Word[]; held?: string };
    const judge = (pg: TextPage, ws: Word[], rowWords: Word[], value: number | "invoiceable", used: Word[], own: boolean, unitCents: number | null): Judged => {
      const printed = ws.length ? txt(ws) : null;
      // An "invoiceable" cell is there when the cell says so, or prints the row's price: tables print a price only under the
      // visits it applies to (owner, from the scans, 2026-10-29). Only under the page's own header: on a continuation page
      // the columns are carried over, and a price under the visit next door is the same price (one shared visit pattern
      // was confirmed there for 5 rows the read didn't list). How the row is billed is a meaning, asked as such.
      const ok = value === "invoiceable" ? /invoic/i.test(printed ?? "") || (own && unitCents !== null && cents(printed) === unitCents) : cents(printed) === value;
      // On a scan, a blank or garbled cell is as likely the OCR's miss as the page's: it says nothing either way, so the
      // value is unfound (the totals or a person decide), not contradicted. A PDF's own blank cell is a real blank.
      // "Invoiceable" is how the read says a cell is billed, not a number the OCR can check: it decides nothing there either.
      const unread = pg.source === "ocr" && !ok && (value === "invoiceable" || printed === null || cents(printed) === null || ws.some((w) => (w.conf ?? 1) < MIN_OCR_CONF));
      const where = [boxOf(pg, ws.length ? ws : rowWords)];
      // what the cell prints belongs to a row the master holds, and its value is asked: it isn't another money term too
      if (unread) return { status: "ungrounded", where, printed: null, note: "the scan is unclear here", used: ws };
      // digits that agree but that the OCR wasn't sure of: put() downgrades them the same way
      if (ok && [...ws, ...used].some((w) => (w.conf ?? 1) < MIN_OCR_CONF)) return { status: "ungrounded", where, printed: null, note: "the scan is unclear here", used: [...ws, ...used] };
      return { status: ok ? "confirmed" : "conflict", where, printed, note: null, used: [...ws, ...used] };
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
        const pl = t && rest.length ? plan(t, g, rest, (r) => gridTaken.has(`${k}#${ti}#${r}`)) : null;
        if (!t || !pl) continue;
        let id: string | undefined;
        const check = () => (id ??= checkFor(pg, k, ti, ruled, t, pl, dir));
        // rows the prices don't place, placed by order between the firm ones: held on their rows, whatever the columns
        const byOrder = place(t, idx, pl.rows, (pi, j) => !viaGrid.has(pi) && !heldRows.has(pi) && !gridTaken.has(`${k}#${ti}#${j}`));
        for (const [pi, j] of byOrder) if (pl.unfit(pi, j, false)) byOrder.delete(pi);
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
            const pick = left.length === 1 ? left[0] : top.length && !(top[1] && top[1].n === top[0]!.n) ? left.find((ws) => cents(txt(ws)) === top[0]!.v) : undefined;
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
            const total = row.slice(pl.last + 1).find((ws) => t.printed[j]![row.indexOf(ws)] === sum + target && ws.every((w) => (w.conf ?? 1) >= MIN_OCR_CONF));
            const path = `${pp}/cells/${ptr(open)}`;
            if (total) {
              const was = out.get(path)!;
              row[pl.cols.get(open)!]!.forEach((w) => bound.add(w));
              out.set(path, { status: "confirmed", where: was.where, printed: null, note: "the row's printed total confirms it", used: total });
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
        const have = l.words.filter(priceLike).map((w) => cents(w.text));
        return want.every((v) => {
          const i = have.indexOf(v);
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
        if (key === "#unit" && unit && typeof value === "number") put(path, cents(unit.text) === value ? "confirmed" : "conflict", [boxOf(c!.pg.p, [unit])], unit.text, null, [unit]);
        else if (!c || !found || (key === "#unit" ? !c.cols.unit : !c.cols.at.has(key))) put(path, "ungrounded", found && c ? [boxOf(c.pg.p, found.row.words)] : nowhere(p.prov.source), null);
        else cell(path, c, found.row, key, value, found.code ? [found.code] : [], p.unitCents);
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
    const alone = (as: { cents: number | null }[], value: number, i: number) => (want.length === 2 && as.length >= 2 ? as[i]!.cents === value : as.every((a) => a.cents === value));
    want.forEach(([field, value], i) => {
      const path = `${base}/${field}`;
      const spot = positional ? onRow[i] : onRow.find((a) => a.cents === value);
      const used = found?.code ? [found.code] : [];
      if (spot?.cents === value && !alone(onRow, value, i))
        return put(path, "ungrounded", [boxOf(pg!.p, found!.row.words)], null, "printed with another amount on the same line, so which one it is can't be told", [...onRow.filter((a) => a.cents === value).flatMap((a) => a.words), ...used, ...rowNumbers(found!.row)]);
      if (spot?.cents === value) return put(path, "confirmed", [boxOf(pg!.p, spot.words)], txt(spot.words), null, [...spot.words, ...used, ...rowNumbers(found!.row)]);
      if (onRow.length) {
        const shown = positional ? [onRow[i]!] : onRow.filter((a) => !want.some(([, c]) => c === a.cents));
        return put(path, "conflict", [boxOf(pg!.p, found!.row.words)], txt(shown.flatMap((a) => a.words)) || null, null);
      }
      if (inQuote.length) {
        const figs = (want.length === 2 && inQuote.length === 2 ? [inQuote[i]!] : inQuote).map((a) => ({ words: a.words, values: a.cents === null ? [] : [a.cents], printed: txt(a.words), at: boxOf(pg!.p, a.words) }));
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
  return { evidence, unaccounted, tableChecks };
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
      // the quote is the whole line or sentence: blind entry checks every line it's printed on (quotesWithheld)
      quoted: [...new Map(ss.flatMap((s) => s.lines).map((l) => [JSON.stringify(l), l])).values()],
    };
  });
  return [...tables, ...confirm, ...terms];
}
