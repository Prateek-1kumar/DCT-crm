import { parseCents, type Region, type Rulebook } from "@dct/shared";
import { groupLines, rawLine } from "../pdf/lines";
import type { ScanCell } from "../scan/cells";
import type { Doubt, LoadedDoc, Page, PageKind, Word } from "../types";
import { amountsAt, amountsIn, looseAmounts, looseCents, looseFind, looseKey } from "./text";

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
}

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

// A column is money when its heading or its table's title says so, or when it prints an amount; its bare numbers count
// then. A heading that names a count or a rate ("Quantity", "Total Quantity", "Visits", "Overhead %") makes it a count
// column instead, unless it names money outright ("Fee (incl. 25% overhead)"): there only a figure with $ is money.
const MONEY = /\$|\busd\b|\b(?:fee|cost|amount|price|payment|total)s?\b/i;
const NAMES_MONEY = /\$|\busd\b|\b(?:fee|cost|amount|price|payment)s?\b/i;
const NAMES_COUNT = /%|\b(?:qty|quantity|quantities|count|units?|visits|hours|percent|percentage|number of|no\. of)\b/i;
const CURRENCY = /\$|\busd\b/i;
// cellsOf keeps no table titles, so they come from the page's text, which prints each as: TABLE <id> "<title>"
const TITLE = /^TABLE (p\d+\.t\d+) (".*")$/gm;

type Column = "money" | "count" | "other";

function tokens(text: string): { text: string; cents: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  return looseAmounts(words, () => false).map(({ cents, from, to }) => ({ text: words.slice(from, to + 1).join(" "), cents: Math.abs(cents) }));
}

/** What a scanned cell or line prints: its amount-shaped words, or a table cell's whole value ("$ 1,500", or "1,500" in a money column). */
function printedIn(cell: ScanCell, column: Column): { text: string; cents: number }[] {
  if (column === "count") return tokens(cell.text).filter((t) => CURRENCY.test(t.text));
  if (cell.row !== null && cell.col) {
    const whole = looseCents(cell.text) ?? (column === "money" ? parseCents(cell.text) : null);
    if (whole !== null) return [{ text: cell.text, cents: Math.abs(whole) }];
  }
  return tokens(cell.text);
}

function columnsOf(page: Page, cells: ScanCell[]): Map<string, Column> {
  const titles = new Map([...page.layout.matchAll(TITLE)].map((m) => [m[1]!, JSON.parse(m[2]!) as string]));
  const columns = new Map<string, Column>();
  for (const c of cells) {
    if (c.table === null || !c.col) continue;
    const key = `${c.table}.${c.col}`;
    const heading = c.row === null ? c.text : (c.heading ?? "");
    if (NAMES_COUNT.test(heading) && !NAMES_MONEY.test(heading)) columns.set(key, "count");
    if (columns.get(key) === "count") continue;
    const prints = c.row !== null && (looseCents(c.text) !== null || tokens(c.text).length > 0);
    if (prints || MONEY.test(heading) || MONEY.test(titles.get(`p${c.page}.t${c.table}`) ?? "")) columns.set(key, "money");
  }
  return columns;
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

/**
 * On a transcribed scan an amount is accounted for by a value citing its cell, or by `accounted` naming its cell, its
 * amount on this page, or the whole page. A value or a listing for another page never counts.
 */
function scannedAmounts(rulebook: Rulebook, doc: string, page: Page, cells: ScanCell[], cited: Map<string, Cited[]>): CoverageAmount[] {
  const columns = columnsOf(page, cells);
  return cells.flatMap((cell) => {
    const row = cell.table === null ? [cell] : cells.filter((c) => c.table === cell.table && c.row === cell.row);
    const line = row.map((c) => c.text).join(" ").trim().slice(0, 120);
    return printedIn(cell, columns.get(`${cell.table}.${cell.col}`) ?? "other").flatMap(({ text, cents }): CoverageAmount[] => {
      if (cents === 0) return [];
      // a table cell holds one value (with its struck predecessor, if any); a line can print several, so its citation must name the amount
      const match = cited.get(cell.id)?.find((c) => cell.table !== null || (c.cents !== null && Math.abs(c.cents) === cents));
      const accounted = match
        ? undefined
        : rulebook.accounted.find((a) => a.doc === doc && (a.pages?.includes(page.page) || a.cell === cell.id || (a.page === page.page && a.amountCents !== undefined && Math.abs(a.amountCents) === cents)));
      const status: AmountStatus = match ? (match.person ? "decided" : "captured") : accounted ? "set_aside" : "missing";
      return [{ box: cellBand(page, cell.id), text, cents, status, ref: match?.ref ?? null, reason: accounted?.reason ?? null, line, doubt: cell.doubts[0] ?? null }];
    });
  });
}

export function coverage(rulebook: Rulebook, docs: LoadedDoc[]): Coverage {
  const known = candidates(rulebook);
  const cited = citations(rulebook);
  const noMoney = new Set(rulebook.study.documents.filter((d) => !d.hasMoney).map((d) => d.doc));
  const pages: CoveragePage[] = [];
  const totals = { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 };

  for (const doc of docs) {
    if (noMoney.has(doc.name)) continue;
    for (const page of doc.pages) {
      const out: CoveragePage = { doc: doc.name, page: page.page, kind: page.kind, amounts: [], clauses: [] };
      pages.push(out);
      if (page.kind === "image") continue;

      if (page.cells) out.amounts = scannedAmounts(rulebook, doc.name, page, page.cells, cited);
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
