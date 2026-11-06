import { parseCents } from "@dct/shared";
import { amountsAt, looseKey } from "../checks/text";
import type { Field, Mark, Transcription } from "./transcribe";

export interface Verdict {
  outcome: "agree" | "differ" | "marked" | "unaligned";
  /** What the second read printed there, when the cell could be lined up with one of its cells. */
  second?: string;
  /** The marks either read saw. */
  marks?: Mark[];
}

type Table = Transcription["tables"][number];
type Row = Table["rows"][number];

const UNALIGNED: Verdict = { outcome: "unaligned" };
const WORST: Verdict["outcome"][] = ["agree", "differ", "unaligned", "marked"];
const worse = (a: Verdict | undefined, b: Verdict) => (a && WORST.indexOf(a.outcome) >= WORST.indexOf(b.outcome) ? a : b);

// a cell that prints one bare number ("1500") is an amount too, as the citation check reads it
const amountsOf = (text: string) => {
  const found = amountsAt(text).map((a) => a.cents);
  const bare = parseCents(text);
  return found.length || bare === null ? found : [bare];
};
const withoutAmounts = (text: string) => amountsAt(text).reduceRight((t, a) => t.slice(0, a.start) + t.slice(a.end), text);
const count = (list: number[], value: number) => list.filter((v) => v === value).length;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * Pairs items of two sequences in order (the longest such pairing), then keeps a pair only when the item is as many-th
 * among its look-alikes on one side as on the other, with as many look-alikes on each: a repeated label pairs by order, and
 * when one read has a repeat the other doesn't, none of those repeats is paired, since which one is missing can't be told.
 */
function align(n: number, m: number, like: (i: number, j: number) => boolean): Map<number, number> {
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) best[i]![j] = like(i, j) ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  const pairs = new Map<number, number>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (like(i, j) && best[i]![j] === best[i + 1]![j + 1]! + 1) pairs.set(i++, j++);
    else if (best[i + 1]![j]! >= best[i]![j + 1]!) i++;
    else j++;
  }
  for (const [i, j] of pairs) {
    const mine = range(n).filter((x) => like(x, j));
    const theirs = range(m).filter((y) => like(i, y));
    if (mine.length !== theirs.length || mine.indexOf(i) !== theirs.indexOf(j)) pairs.delete(i);
  }
  return pairs;
}

/** Tables by their order on the page, or by title when the reads found different numbers of tables. */
function alignTables(a: Table[], b: Table[]): Map<number, number> {
  const title = (t: Table) => looseKey(withoutAmounts(t.title));
  const near = (x: string, y: string) => x.includes(y) || y.includes(x);
  if (a.length === b.length) return new Map(range(a.length).flatMap((i) => (title(a[i]!) && title(b[i]!) && !near(title(a[i]!), title(b[i]!)) ? [] : [[i, i]])));
  return align(a.length, b.length, (i, j) => !!title(a[i]!) && !!title(b[j]!) && near(title(a[i]!), title(b[j]!)));
}

const width = (t: Table) => Math.max(t.columns.length - 1, ...t.rows.map((r) => r.cells.length));
const filled = (r: Row) => r.cells.some((c) => c.text.trim());

/**
 * Rows that print something beyond their label, each with its label and the labels around it. A label wrapped over several
 * printed lines may be split differently by each read, with the values beside any of the lines, so the rows that only carry
 * label words between two such rows count as part of both.
 */
function anchors(t: Table) {
  const at = t.rows.flatMap((r, i) => (filled(r) ? [i] : []));
  return at.map((i, k) => {
    const from = k ? at[k - 1]! + 1 : 0;
    const to = k + 1 < at.length ? at[k + 1]! - 1 : t.rows.length - 1;
    return { row: i, key: looseKey(t.rows[i]!.label), around: t.rows.slice(from, to + 1).map((r) => looseKey(r.label)).join("") };
  });
}

function alignRows(a: Table, b: Table): Map<number, number> {
  const [x, y] = [anchors(a), anchors(b)];
  const like = (i: number, j: number) => {
    const [p, q] = [x[i]!, y[j]!];
    return p.key && q.key ? q.around.includes(p.key) && p.around.includes(q.key) : !p.key && !q.key;
  };
  return new Map([...align(x.length, y.length, like)].map(([i, j]) => [x[i]!.row, y[j]!.row]));
}

/** Columns by their headings; columns neither read gave a heading line up only when both reads have as many. */
function alignColumns(a: Table, b: Table): Map<number, number> {
  const headings = (t: Table) => range(width(t)).map((k) => looseKey(t.columns[k + 1] ?? ""));
  const [x, y] = [headings(a), headings(b)];
  return align(x.length, y.length, (i, j) => x[i] === y[j]);
}

function compareCell(first: Field, second: Field): Verdict {
  const marks = [...new Set([...first.marks, ...second.marks])];
  if (marks.length) return { outcome: "marked", second: second.text, marks };
  const [x, y] = [amountsOf(first.text), amountsOf(second.text)];
  return { outcome: x.length === y.length && x.every((v, i) => v === y[i]) ? "agree" : "differ", second: second.text };
}

/**
 * A cell whose column can't be lined up is confirmed only when its amount is printed as many times on the second read's row
 * as on the first's. It never takes a value from that row, since which cell is which isn't known.
 */
function confirmByCount(first: Row, k: number, second: Row): Verdict {
  const cell = first.cells[k]!;
  if (cell.marks.length) return { outcome: "marked", marks: cell.marks };
  const all = (r: Row) => r.cells.flatMap((c) => amountsOf(c.text));
  const values = amountsOf(cell.text);
  const marks = [...new Set(second.cells.filter((c) => amountsOf(c.text).some((v) => values.includes(v))).flatMap((c) => c.marks))];
  if (marks.length) return { outcome: "marked", marks };
  return values.every((v) => count(all(first), v) === count(all(second), v)) ? { outcome: "agree" } : UNALIGNED;
}

const CONTEXT_WORDS = 4;

/**
 * Every amount printed outside tables, with the words before it. Only lines that hold an amount count, since that is all a
 * second read is asked for, and the words run on from one such line to the next, so a sentence wrapped differently still
 * gives the same words.
 */
function lineAmounts(t: Transcription) {
  const words: string[] = [];
  const add = (text: string) => words.push(...text.split(/\s+/).map(looseKey).filter(Boolean));
  return t.lines.flatMap((line, i) => {
    let from = 0;
    const found = amountsAt(line.text).map((a) => {
      add(line.text.slice(from, a.start));
      from = a.end;
      return { line: i, cents: a.cents, text: a.text, before: words.slice(-CONTEXT_WORDS).join(" "), marks: line.marks };
    });
    if (found.length) add(line.text.slice(from));
    return found;
  });
}

/**
 * Compares two independent reads of one page cell by cell, by structure and order, never by position. Keys are the first
 * read's ids: a table cell's `p{page}.t{table}.r{row}.c{col}`, and a line's `p{page}.l{line}#{cents}` for each amount on it
 * (see verdictOf). A cell missing from the map could not be lined up.
 */
export function diffReads(page: number, first: Transcription, second: Transcription): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const tables = alignTables(first.tables, second.tables);
  first.tables.forEach((table, ti) => {
    const other = tables.has(ti) ? second.tables[tables.get(ti)!]! : undefined;
    const rows = other ? alignRows(table, other) : new Map<number, number>();
    const columns = other ? alignColumns(table, other) : new Map<number, number>();
    table.rows.forEach((row, ri) => {
      const match = rows.has(ri) ? other!.rows[rows.get(ri)!]! : undefined;
      row.cells.forEach((cell, k) => {
        if (!amountsOf(cell.text).length) return;
        const id = `p${page}.t${ti + 1}.r${ri + 1}.c${k + 1}`;
        if (!match) out.set(id, cell.marks.length ? { outcome: "marked", marks: cell.marks } : UNALIGNED);
        else if (columns.has(k)) out.set(id, compareCell(cell, match.cells[columns.get(k)!] ?? { text: "", unsure: false, marks: [] }));
        else out.set(id, confirmByCount(row, k, match));
      });
    });
  });

  const [a, b] = [lineAmounts(first), lineAmounts(second)];
  for (const amount of a) {
    const mine = a.filter((x) => x.before === amount.before);
    const theirs = b.filter((x) => x.before === amount.before);
    const match = mine.length === theirs.length ? theirs[mine.indexOf(amount)] : undefined;
    const marks = [...new Set([...amount.marks, ...(match?.marks ?? [])])];
    const verdict: Verdict = marks.length ? { outcome: "marked", marks, ...(match && { second: match.text }) } : !match ? UNALIGNED : { outcome: match.cents === amount.cents ? "agree" : "differ", second: match.text };
    const key = `p${page}.l${amount.line + 1}#${amount.cents}`;
    out.set(key, worse(out.get(key), verdict));
  }
  return out;
}

/** What the diff says about a cited value: a table cell by its id, a line by the amount cited from it. */
export const verdictOf = (diff: Map<string, Verdict>, id: string, cents: number): Verdict => (/\.t\d+\./.test(id) ? diff.get(id) : diff.get(`${id}#${cents}`)) ?? UNALIGNED;
