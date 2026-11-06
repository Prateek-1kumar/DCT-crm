import { SET_ASIDE, parseCents, type Region, type Rulebook } from "@dct/shared";
import { groupLines, rawLine } from "../pdf/lines";
import { cellsOf, type ScanCell } from "../scan/cells";
import { alignTables, amountsOf, diffReads } from "../scan/diff";
import { bandsOf } from "../scan/words";
import type { Doubt, LoadedDoc, Page, PageKind, Word } from "../types";
import { amountsAt, amountsIn, looseAmounts, looseCents, looseContains, looseFind, looseKey } from "./text";

export type AmountStatus = "captured" | "decided" | "set_aside" | "missing";
export type CoverageRef = { target: "term"; id: string } | { target: "grid"; id: string; row: number; col: number };

export interface CoverageAmount {
  box: Region;
  text: string;
  cents: number;
  status: AmountStatus;
  ref: CoverageRef | null;
  reason: string | null;
  /** The printed line it sits on, for context. */
  line: string;
  /** The first doubt the reader flagged on the words it was read from; null when none, and on a page with a text layer. */
  doubt: Doubt | null;
  /** Set on an amount only the page's second read found: the id of its cell or line in that read. */
  secondRead?: string;
}

/** How a person's "set aside" names an amount only the second read found, apart from the first read's cell of the same id. */
export const secondReadCell = (id: string) => `${id} (second read)`;

export interface CoverageClause {
  termId: string;
  boxes: Region[];
}

export interface CoveragePage {
  doc: string;
  page: number;
  kind: PageKind;
  amounts: CoverageAmount[];
  clauses: CoverageClause[];
}

export interface Coverage {
  pages: CoveragePage[];
  totals: { amounts: number; captured: number; decided: number; setAside: number; missing: number };
}

const union = (words: Word[]): Region => [Math.min(...words.map((w) => w.x0)), Math.min(...words.map((w) => w.y0)), Math.max(...words.map((w) => w.x1)), Math.max(...words.map((w) => w.y1))];

/** One box per printed line the quote spans, found by the scanned-page quote check's matcher; [] when the words aren't on the page (a scan has none). */
export function findQuote(words: Word[], quote: string): Region[] {
  const ordered = groupLines(words).flat();
  const hit = looseFind(ordered.map((w) => w.text), quote);
  if (!hit) return [];
  const lines: Word[][] = [];
  for (const w of ordered.slice(hit[0], hit[1] + 1).filter((w) => looseKey(w.text))) {
    const line = lines.at(-1);
    if (line && Math.abs((w.y0 + w.y1) / 2 - (line[0]!.y0 + line[0]!.y1) / 2) <= (w.y1 - w.y0) / 2) line.push(w);
    else lines.push([w]);
  }
  return lines.map(union);
}

/** Where a scanned word sits across the page is made up (§5.1), so a scan's boxes are whole-width bands of the lines they are on. */
const lineBand = (page: Page, box: Region): Region => (page.kind === "scan" ? [0, box[1], 1, box[3]] : box);

/** findQuote for a page: on a scan, the full-width bands of the quote's lines. */
export const quoteBoxes = (page: Page, quote: string): Region[] => findQuote(page.words, quote).map((box) => lineBand(page, box));

interface Candidate {
  ref: CoverageRef;
  person: boolean;
  doc: string;
  pages: number[];
}

function candidates(rulebook: Rulebook): Map<number, Candidate[]> {
  const byCents = new Map<number, Candidate[]>();
  const add = (cents: unknown, candidate: Candidate) => {
    if (typeof cents !== "number" || cents === 0) return;
    const list = byCents.get(Math.abs(cents)) ?? [];
    list.push(candidate);
    byCents.set(Math.abs(cents), list);
  };
  for (const t of rulebook.terms) {
    const candidate: Candidate = { ref: { target: "term", id: t.id }, person: t.evidence === "person", doc: t.source.doc, pages: [t.source.page] };
    add(t.amountCents, candidate);
    if (t.cap?.kind === "amount") add(t.cap.value, candidate);
    // money written into a rule's words ("100% of $5,995 for Visit 1") is captured by that rule
    for (const s of [t.formula, t.conditions, t.notes, t.trigger, t.cap?.text, t.deadline, t.unit]) if (s) amountsIn(s).forEach((c) => add(c, candidate));
  }
  for (const g of rulebook.grids) {
    const at = (row: number, col: number): Candidate => ({ ref: { target: "grid", id: g.id, row, col }, person: false, doc: g.doc, pages: g.pages });
    g.rows.forEach((r, row) => {
      add(r.unitCostCents, at(row, -1));
      add(r.printedRowTotalCents, at(row, -1));
      r.cells.forEach((c, col) => add(c, at(row, col)));
    });
    [g.subtotal, g.overhead, g.total, ...g.additions.map((a) => a.cells)].forEach((line) => line?.forEach((c, col) => add(c, at(-1, col))));
    add(g.grandTotalCents, at(-1, -1));
  }
  return byCents;
}

/** The amounts printed on one line with the words they sit in; on a scanned page, read with slips allowed. */
function amountsOn(page: Page, line: Word[], known: Map<number, Candidate[]>): { text: string; cents: number; printed: Word[] }[] {
  if (page.kind === "scan") {
    return looseAmounts(line.map((w) => w.text), (c) => known.has(Math.abs(c))).map(({ cents, from, to }) => {
      const printed = line.slice(from, to + 1);
      return { text: printed.map((w) => w.text).join(" "), cents: Math.abs(cents), printed };
    });
  }
  let at = 0;
  const spans = line.map((w) => {
    const span = { w, start: at, end: at + w.text.length };
    at = span.end + 1;
    return span;
  });
  return amountsAt(rawLine(line)).map((a) => ({ text: a.text, cents: a.cents, printed: spans.filter((s) => s.start < a.end && s.end > a.start).map((s) => s.w) }));
}

interface Cited {
  ref: CoverageRef;
  person: boolean;
  cents: number | null;
}

/** The grid line and visit of a value's place as a patch names it ("rows.3.cells.5", "total.2", "grandTotalCents"); -1 for none. */
function placeOf(path: string): { row: number; col: number } {
  const row = /^rows\.(\d+)\.(\w+)/.exec(path);
  const col = /\.(\d+)$/.exec(path);
  return { row: row ? Number(row[1]) : -1, col: col && (!row || row[2] === "cells") ? Number(col[1]) : -1 };
}

const valueAt = (node: unknown, path: string) => path.split(".").reduce<unknown>((n, key) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[key] : undefined), node);

/** Every scanned cell or line a rulebook value cites, with the values that cite it. */
function citations(rulebook: Rulebook): Map<string, Cited[]> {
  const byCell = new Map<string, Cited[]>();
  const add = (id: string | null | undefined, cited: Cited) => {
    if (typeof id === "string") byCell.set(id, [...(byCell.get(id) ?? []), cited]);
  };
  for (const t of rulebook.terms) {
    const ref: CoverageRef = { target: "term", id: t.id };
    add(t.source.cell, { ref, person: t.evidence === "person", cents: t.amountCents });
    add(t.source.capCell, { ref, person: t.evidence === "person", cents: t.cap?.kind === "amount" ? t.cap.value : null });
  }
  for (const g of rulebook.grids) {
    for (const [path, id] of Object.entries(g.cellIds ?? {})) {
      const cents = valueAt(g, path);
      add(id, { ref: { target: "grid", id: g.id, ...placeOf(path) }, person: false, cents: typeof cents === "number" ? cents : null });
    }
  }
  return byCell;
}

// Every table cell's numbers are money unless the cell itself is excused: a count ("8.00", "25%") under a heading that
// is nothing but a count ("Quantity", "Total Quantity", "Visits", "No. of subjects") or a percentage label ("Overhead %"),
// or a code ("99213", "G0101-QW") under a code heading ("CPT"). Anything else printed there, such as a fee shifted one
// column, still counts; any money word in a heading, or a number after "visits" ("Visits 2-5"), keeps it ordinary.
const COUNT = /^\s*(?:total\s+)?(?:qty|quantit(?:y|ies)|count|#|units?|hours|visits|%|percent(?:age)?|(?:number|no\.?) of \w+)\s*$/i;
const PERCENTAGE = /^\s*[a-z ]*%\s*$/i;
const CODE = /^\s*(?:(?:cpt|hcpcs)(?:\s+codes?)?|codes?)\s*$/i;
const MONEY_WORD = /\b(?:total|rate|per|overhead|reimburs\w*|compensation|charge|fee|cost|price|amount|payment|stipend)s?\b/i;
const COUNT_SHAPED = /^\s*(?:\d{1,3}(?:\.0+)?|\d+(?:\.\d+)?\s*%)\s*$/;
const CODE_SHAPED = /^\s*(?:\d{5}|[A-Z]\d{4})(?:-?[A-Z0-9]{2})?\s*$/i;

type Excused = "count" | "code";

function excusedBy(heading: string): Excused | undefined {
  if ((COUNT.test(heading) && !MONEY_WORD.test(heading.replace(/^\s*total\s+/i, ""))) || (PERCENTAGE.test(heading) && !MONEY_WORD.test(heading.replace(/\boverhead\b/i, "")))) return "count";
  return CODE.test(heading) ? "code" : undefined;
}

function tokens(text: string): { text: string; cents: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  return looseAmounts(words, () => false).map(({ cents, from, to }) => ({ text: words.slice(from, to + 1).join(" "), cents: Math.abs(cents) }));
}

/** Each word of a table cell that is a number, bare ones too ("1,500 / 2,000", "1,000{x} 1,200{hw}"). */
function numbers(text: string): { text: string; cents: number }[] {
  return text.split(/\s+/).flatMap((word) => {
    const cents = looseCents(word) ?? parseCents(word);
    return cents === null ? [] : [{ text: word, cents: Math.abs(cents) }];
  });
}

/** A table cell's numbers, read whole first ("$ 1,500"), then word by word. */
function cellNumbers(text: string): { text: string; cents: number }[] {
  const whole = looseCents(text) ?? parseCents(text);
  return whole === null ? numbers(text) : [{ text, cents: Math.abs(whole) }];
}

/**
 * What a scanned cell or line prints: a line's amount-shaped words, or a table cell's numbers. A count-shaped cell is a
 * count only when its row prints a fee in an ordinary column; otherwise it is the fee, shifted a column.
 */
function printedIn(cell: ScanCell, excused: Excused | undefined, rowHasFee: boolean): { text: string; cents: number }[] {
  if (cell.row === null || !cell.col) return tokens(cell.text);
  if ((excused === "count" && rowHasFee && COUNT_SHAPED.test(cell.text)) || (excused === "code" && CODE_SHAPED.test(cell.text))) return [];
  return cellNumbers(cell.text);
}

const widthOf = (cells: ScanCell[], table: number) => Math.max(0, ...cells.filter((c) => c.table === table).map((c) => c.col ?? 0));

/**
 * The count and code columns of a page's tables, by "table.col". A table printed without headings is taken as the rest
 * of the last table on the page before with as many columns, as a budget continued on the next page is.
 * ponytail: walks back one page per continued page; fine for any real contract's page count.
 */
function excusedColumns(pages: Page[], index: number): Map<string, Excused> {
  const cells = pages[index]?.cells ?? [];
  const excused = new Map<string, Excused>();
  const headed = new Set(cells.filter((c) => c.table !== null && c.row === null).map((c) => c.table));
  for (const c of cells) {
    const kind = c.table !== null && c.row === null && c.col ? excusedBy(c.text) : undefined;
    if (kind) excused.set(`${c.table}.${c.col}`, kind);
  }
  const tables = new Set(cells.flatMap((c) => (c.table === null || headed.has(c.table) ? [] : [c.table])));
  if (!tables.size || index === 0) return excused;
  const before = pages[index - 1]!.cells ?? [];
  const earlier = excusedColumns(pages, index - 1);
  for (const table of tables) {
    const width = widthOf(cells, table);
    const match = [...new Set(before.flatMap((c) => (c.table === null ? [] : [c.table])))].filter((t) => widthOf(before, t) === width).at(-1);
    for (let col = 1; match !== undefined && col <= width; col++) {
      const kind = earlier.get(`${match}.${col}`);
      if (kind) excused.set(`${table}.${col}`, kind);
    }
  }
  return excused;
}

/** The row a cell is on ("p7.t1.r5", "p7.t1.h"), or the line itself. */
const rowOf = (id: string) => id.replace(/\.c\d+$/, "").replace(/\.h\d+$/, ".h");

/** The padded, full-width band of the row a scanned cell is on, where its words are shown. */
function cellBand(page: Page, id: string): Region {
  const band = page.bands?.[rowOf(id)];
  if (!band) return [0, 0, 1, 1];
  const pad = (band[1] - band[0]) / 2;
  return [0, Math.max(0, band[0] - pad), 1, Math.min(1, band[1] + pad)];
}

/** Each cell and line of a page's read, with the amounts it prints and the printed row or line it is on. */
function printedCells(pages: Page[], index: number) {
  const cells = pages[index]!.cells ?? [];
  const excused = excusedColumns(pages, index);
  return cells.map((cell) => {
    const row = cell.table === null ? [cell] : cells.filter((c) => c.table === cell.table && c.row === cell.row);
    const line = row.map((c) => c.text).join(" ").trim().slice(0, 120);
    const rowHasFee = row.some((c) => c.row !== null && c.col && !excused.has(`${c.table}.${c.col}`) && cellNumbers(c.text).length > 0);
    return { cell, line, printed: printedIn(cell, excused.get(`${cell.table}.${cell.col}`), rowHasFee) };
  });
}

/**
 * On a transcribed scan an amount is accounted for by a value citing its cell, or by `accounted` naming its cell, its
 * amount on this page, or the whole page. A value or a listing for another page never counts.
 */
function scannedAmounts(rulebook: Rulebook, doc: string, pages: Page[], index: number, cited: Map<string, Cited[]>): CoverageAmount[] {
  const page = pages[index]!;
  return printedCells(pages, index).flatMap(({ cell, line, printed }) => {
    // a citation names one amount: a second one in the same cell or line ("$500.00 per visit, max $6,000.00") needs its
    // own, except a struck value the cited one replaces
    const struck = new Set((cell.struck ?? []).flatMap((s) => [...tokens(s), ...numbers(s)].map((t) => t.cents)));
    return printed.flatMap(({ text, cents }): CoverageAmount[] => {
      if (cents === 0) return [];
      const match = cited.get(cell.id)?.find((c) => printed.length === 1 || struck.has(cents) || (c.cents !== null && Math.abs(c.cents) === cents));
      const accounted = match
        ? undefined
        : rulebook.accounted.find((a) => a.doc === doc && (a.pages?.includes(page.page) || a.cell === cell.id || (a.page === page.page && a.amountCents !== undefined && Math.abs(a.amountCents) === cents)));
      const status: AmountStatus = match ? (match.person ? "decided" : "captured") : accounted ? "set_aside" : "missing";
      return [{ box: cellBand(page, cell.id), text, cents, status, ref: match?.ref ?? null, reason: accounted?.reason ?? null, line, doubt: cell.doubts[0] ?? null }];
    });
  });
}

/** A term a person added or settled that holds this amount, named on the printed row or line it is on. */
const decidedBy = (rulebook: Rulebook, doc: string, page: number, cents: number, line: string) =>
  rulebook.terms.find(
    (t) =>
      t.evidence === "person" && t.source.doc === doc && t.source.page === page &&
      [t.amountCents, ...[t.formula, t.notes].flatMap((x) => (x ? amountsIn(x) : []))].some((c) => c !== null && Math.abs(c) === cents) &&
      [t.name, t.source.quote].some((words) => words.trim() && looseContains(line, words)),
  );

/**
 * Amounts the page's second read found with nothing in the first read beside them: an unpaired row or line, or a cell the
 * first read left blank. Only tables that paired with one of the first read's count: a table that didn't has its cells
 * asked about already, and listing all of its amounts again would say nothing new. Nothing cites them, so each is missing
 * until a person settles it: a term of theirs with that amount on that row, or their "set aside" (or the whole page set
 * aside). The compile agent's listing of the amount never counts, since it can't tell a dropped fee from a double read.
 */
function missedAmounts(rulebook: Rulebook, doc: string, pages: Page[], index: number): CoverageAmount[] {
  const page = pages[index]!;
  if (!page.second || !page.transcription) return [];
  const back = diffReads(page.page, page.second, page.transcription);
  const paired = new Set(alignTables(page.second.tables, page.transcription.tables).keys());
  const bands = Object.fromEntries([...bandsOf(page.second)].map(([key, band]) => [`p${page.page}.${key}`, band]));
  const second: Page = { ...page, cells: cellsOf(page.page, page.second), bands };
  return printedCells(pages.map((p, i) => (i === index ? second : p)), index).flatMap(({ cell, line, printed }) =>
    printed.flatMap(({ text, cents }): CoverageAmount[] => {
      const verdict = cell.table === null ? (back.get(`${cell.id}#${cents}`) ?? back.get(`${cell.id}#${-cents}`)) : back.get(cell.id);
      if (!cents || !verdict || (cell.table !== null && !paired.has(cell.table - 1)) || (verdict.second !== undefined && amountsOf(verdict.second).length > 0)) return [];
      const accounted = rulebook.accounted.find((a) => a.doc === doc && (a.pages?.includes(page.page) || (a.reason === SET_ASIDE && a.page === page.page && a.cell === secondReadCell(cell.id))));
      const added = accounted ? undefined : decidedBy(rulebook, doc, page.page, cents, line);
      const status: AmountStatus = added ? "decided" : accounted ? "set_aside" : "missing";
      const reason = accounted?.reason ?? (added ? null : `a second read of p.${page.page} found an amount the first read didn't`);
      return [{ box: cellBand(second, cell.id), text, cents, status, ref: added ? { target: "term", id: added.id } : null, reason, line, doubt: cell.doubts[0] ?? null, secondRead: cell.id }];
    }),
  );
}

export function coverage(rulebook: Rulebook, docs: LoadedDoc[]): Coverage {
  const known = candidates(rulebook);
  const cited = citations(rulebook);
  const noMoney = new Set(rulebook.study.documents.filter((d) => !d.hasMoney).map((d) => d.doc));
  const pages: CoveragePage[] = [];
  const totals = { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 };

  for (const doc of docs) {
    if (noMoney.has(doc.name)) continue;
    for (const [index, page] of doc.pages.entries()) {
      const out: CoveragePage = { doc: doc.name, page: page.page, kind: page.kind, amounts: [], clauses: [] };
      pages.push(out);
      if (page.kind === "image") continue;

      if (page.cells) out.amounts = [...scannedAmounts(rulebook, doc.name, doc.pages, index, cited), ...missedAmounts(rulebook, doc.name, doc.pages, index)];
      else {
        // A whole page set aside (a superseded budget) wins over a coincidental match; a set-aside amount counts wherever
        // it was listed, as in the every-dollar check.
        const wholePage = rulebook.accounted.find((a) => a.doc === doc.name && a.pages?.includes(page.page));
        const setAside = (cents: number) =>
          rulebook.accounted.find((a) => a.doc === doc.name && a.page === page.page && a.amountCents !== undefined && Math.abs(a.amountCents) === cents) ??
          rulebook.accounted.find((a) => a.amountCents !== undefined && Math.abs(a.amountCents) === cents);
        for (const line of groupLines(page.words)) {
          const printedLine = rawLine(line);
          for (const a of amountsOn(page, line, known)) {
            if (a.cents === 0) continue;
            const matches = wholePage ? [] : (known.get(a.cents) ?? []);
            const match = matches.find((c) => c.doc === doc.name && c.pages.includes(page.page)) ?? matches[0];
            const accounted = match ? undefined : (wholePage ?? setAside(a.cents));
            const status: AmountStatus = match ? (match.person ? "decided" : "captured") : accounted ? "set_aside" : "missing";
            const doubt = a.printed.find((w) => w.doubt)?.doubt ?? null;
            out.amounts.push({ box: lineBand(page, union(a.printed)), text: a.text, cents: a.cents, status, ref: match?.ref ?? null, reason: accounted?.reason ?? null, line: printedLine.trim().slice(0, 120), doubt });
          }
        }
      }
      for (const a of out.amounts) {
        totals.amounts++;
        totals[a.status === "set_aside" ? "setAside" : a.status]++;
      }

      for (const t of rulebook.terms) {
        if (t.source.doc !== doc.name || t.source.page !== page.page) continue;
        const boxes = page.cells && t.source.cell ? [cellBand(page, t.source.cell)] : quoteBoxes(page, t.source.quote);
        if (boxes.length) out.clauses.push({ termId: t.id, boxes });
      }
    }
  }
  return { pages, totals };
}
