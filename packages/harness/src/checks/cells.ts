import { parseCents, type Rulebook } from "@dct/shared";
import type { ScanCell } from "../scan/cells";
import type { Doubt, LoadedDoc, Problem } from "../types";
import { printedAmounts } from "./grid";
import { amountsIn, looseContains, usd } from "./text";

type Term = Rulebook["terms"][number];
type Grid = Rulebook["grids"][number];

/** A cited cell or line that was written by hand, struck out or initialed: a person has to look at it. */
export interface Marked {
  target: "term" | "grid";
  id: string;
  path: string;
  cell: string;
  doubts: Doubt[];
}

const MARKS = new Set<Doubt>(["handwritten", "struck_out", "initialed"]);

const cellsOn = (doc: LoadedDoc, page: number) => doc.pages.find((p) => p.page === page)?.cells;
const pageOf = (id: string) => Number(/^p(\d+)\./.exec(id)?.[1]);
const cellOf = (doc: LoadedDoc, id: string) => cellsOn(doc, pageOf(id))?.find((c) => c.id === id);
const isMarked = (cell: ScanCell) => cell.doubts.some((d) => MARKS.has(d));

// A line's amount sits among its words, and a marked cell can hold a struck value and its replacement; any other cell prints
// one amount, maybe with words ("$1,500.00 per visit") or bare ("1500").
function prints(cell: ScanCell, cents: number) {
  const amounts = amountsIn(cell.text);
  if (cell.table === null || isMarked(cell)) return [parseCents(cell.text), ...amounts].includes(cents);
  return amounts.length ? amounts.length === 1 && amounts[0] === cents : parseCents(cell.text) === cents;
}

interface Cite {
  what: string;
  /** Where the citation goes, for the message that asks for one. */
  how: string;
  cents: number;
  /** undefined when nothing is cited; null when an answer or a closer read changed the amount, so it no longer rests on a cell. */
  id: string | null | undefined;
  /** It may cite nothing: a person settled it, or the grid's text pages print it. */
  optional: boolean;
  pages: number[];
  pagesText: string;
  /** Why the cell, found, isn't the one the value belongs to. */
  misplaced?: (cell: ScanCell) => string | null;
  mark(cell: ScanCell): void;
}

function checkOne(doc: LoadedDoc, c: Cite): string | null {
  if (c.id === null) return null;
  if (c.id === undefined) return c.optional ? null : `${c.what} is on a scanned page, so it has to cite the cell or line it is printed in (${c.how}), with its id as read_pages shows it, e.g. p7.t1.r5.c3.`;
  const cell = cellOf(doc, c.id);
  if (!cell) return `${c.what} cites ${c.id}, but ${doc.name} has no cell or line with that id: copy the id as read_pages shows it.`;
  if (!c.pages.includes(cell.page)) return `${c.what} cites ${c.id}, which is on p.${cell.page}: cite a cell on ${c.pagesText}.`;
  const misplaced = c.misplaced?.(cell);
  if (misplaced) return misplaced;
  if (!prints(cell, c.cents)) return `${c.what} is ${usd(c.cents)}, but cell ${c.id} ${cell.text ? `prints "${cell.text}"` : "is blank"}: write the amount as the cited cell prints it, or cite the cell it is printed in.`;
  if (isMarked(cell)) c.mark(cell);
  return null;
}

/** The words of the printed row a cell is on (its label and every cell), or of the line itself. */
const rowText = (doc: LoadedDoc, cell: ScanCell) =>
  cell.table === null ? cell.text : (cellsOn(doc, cell.page) ?? []).filter((c) => c.table === cell.table && c.row === cell.row).map((c) => c.text).join(" ");

/** Why a term's amounts on a scanned page don't match the cells they cite. Text pages need no citation. */
export function citeTerm(t: Term, docs: LoadedDoc[], marked: Marked[] = []): string[] {
  const doc = docs.find((d) => d.name === t.source.doc);
  if (!doc || !cellsOn(doc, t.source.page)) return [];
  const base = { optional: t.evidence === "person", pages: [t.source.page], pagesText: `p.${t.source.page}, the term's page` };
  // a cap is often printed away from the amount, so it may cite any scanned page of the document
  const scanned = doc.pages.filter((p) => p.cells).map((p) => p.page);
  const mark = (path: string) => (cell: ScanCell) => marked.push({ target: "term", id: t.id, path, cell: cell.id, doubts: cell.doubts });
  // the quote names the row: an amount from another row that prints the same figure is the wrong one
  const misplaced = (cell: ScanCell) => {
    const words = rowText(doc, cell);
    if (looseContains(words, t.source.quote)) return null;
    return `the amount cites ${cell.id}, but the quote "${t.source.quote}" is not on that ${cell.table === null ? "line" : "row"} ("${words}"): cite the cell on the row the quote is from, and quote that row's own words.`;
  };
  const cites: Cite[] = [
    ...(t.amountCents === null ? [] : [{ ...base, what: "the amount", how: "source.cell", cents: t.amountCents, id: t.source.cell, misplaced, mark: mark("amountCents") }]),
    ...(t.cap?.kind === "amount" && t.cap.value !== null ? [{ ...base, what: "the cap", how: "source.capCell", cents: t.cap.value, id: t.source.capCell, pages: scanned, pagesText: `a scanned page of ${doc.name}`, mark: mark("cap.value") }] : []),
  ];
  return cites.flatMap((c) => checkOne(doc, c) ?? []);
}

interface Amount {
  path: string;
  cents: number;
  what: string;
  /** The grid line it is on, by its place ("rows.3", "subtotal") so two rows with one name stay apart, and its name. */
  line?: { key: string; name: string };
  visit?: number;
}

/** Every amount of a grid, by its place as a patch names it, in plain words. */
function amountsOf(g: Grid): Amount[] {
  const at = (v: unknown, path: string, what: string, line?: Amount["line"], visit?: number): Amount[] => (typeof v === "number" ? [{ path, cents: v, what, line, visit }] : []);
  const cells = (values: Grid["subtotal"], path: string, line: NonNullable<Amount["line"]>) =>
    (values ?? []).flatMap((c, j) => at(c, `${path}.${j}`, `${line.name} at visit '${g.visits[j]}'`, line, j));
  const lineOf = (key: "subtotal" | "overhead" | "total", name: string) => cells(g[key], key, { key, name });
  return [
    ...g.rows.flatMap((r, i) => {
      const line = { key: `rows.${i}`, name: `row '${r.name}'` };
      return [
        ...at(r.unitCostCents, `rows.${i}.unitCostCents`, `the unit cost of ${line.name}`, line),
        ...cells(r.cells, `rows.${i}.cells`, line),
        ...at(r.printedRowTotalCents, `rows.${i}.printedRowTotalCents`, `the printed total of ${line.name}`, line),
      ];
    }),
    ...lineOf("subtotal", "the subtotal"),
    ...lineOf("overhead", "the overhead"),
    ...g.additions.flatMap((a, i) => cells(a.cells, `additions.${i}.cells`, { key: `additions.${i}`, name: `the added line '${a.name}'` })),
    ...lineOf("total", "the total"),
    ...at(g.grandTotalCents, "grandTotalCents", "the grand total"),
  ];
}

const TABLE_CELL = /^(p\d+\.t\d+)\.r(\d+)\.c(\d+)$/;

const LAYOUT = "in each printed table, every amount of one row comes from one printed row, and every amount of one visit from one printed column (or the other way round in a table printed sideways).";

/**
 * In each printed table, each grid line cites one printed row and each visit one printed column, or, in a table printed
 * sideways, the other way round. A budget may span several tables, on one page or more.
 */
function shapeIssues(cited: { amount: Amount; id: string }[], visits: string[]): string[] {
  const tables = new Map<string, { amount: Amount; row: string; col: string }[]>();
  for (const { amount, id } of cited) {
    const m = TABLE_CELL.exec(id);
    if (m) tables.set(m[1]!, [...(tables.get(m[1]!) ?? []), { amount, row: `${m[1]}.r${m[2]}`, col: `${m[1]}.c${m[3]}` }]);
  }
  return [...tables].flatMap(([table, cells]) => {
    // each grid line or visit that cites more than one printed row (or column) of this table
    const spread = (of: (a: Amount) => { key: string; name: string } | undefined, at: "row" | "col") => {
      const groups = new Map<string, { name: string; ids: Set<string> }>();
      for (const c of cells) {
        const by = of(c.amount);
        if (!by) continue;
        const group = groups.get(by.key) ?? { name: by.name, ids: new Set<string>() };
        group.ids.add(c[at]);
        groups.set(by.key, group);
      }
      return [...groups.values()].filter((g) => g.ids.size > 1);
    };
    const line = (a: Amount) => a.line;
    const visit = (a: Amount) => (a.visit === undefined ? undefined : { key: String(a.visit), name: `visit '${visits[a.visit]}'` });
    const [rows, columns] = [spread(line, "row"), spread(visit, "col")];
    if (!rows.length && !columns.length) return [];
    if (!spread(line, "col").length && !spread(visit, "row").length) return [];
    return [
      ...rows.map((g) => `${g.name} cites cells of different printed rows of table ${table} (${[...g.ids].join(", ")}): ${LAYOUT}`),
      ...columns.map((g) => `${g.name} cites cells of different printed columns of table ${table} (${[...g.ids].join(", ")}): ${LAYOUT}`),
    ];
  });
}

/** Why the amounts of a grid on a scanned page don't match the cells they cite. A grid on text pages needs no citations. */
export function citeGrid(g: Grid, docs: LoadedDoc[], marked: Marked[] = []): string[] {
  const doc = docs.find((d) => d.name === g.doc);
  if (!doc || !g.pages.some((n) => cellsOn(doc, n))) return [];
  // an amount printed on one of the grid's pages with a text layer needs no citation
  const onText = printedAmounts(g, docs);
  const settled = new Set(g.cellsReadTwice.map(([row, col]) => `rows.${row}.cells.${col}`));
  const amounts = amountsOf(g);
  const cited = amounts.flatMap((amount) => {
    const id = g.cellIds?.[amount.path];
    return typeof id === "string" ? [{ amount, id }] : [];
  });
  const values = amounts.flatMap(({ path, cents, what }) => {
    const optional = onText.has(Math.abs(cents)) || settled.has(path);
    const mark = (cell: ScanCell) => marked.push({ target: "grid", id: g.id, path, cell: cell.id, doubts: cell.doubts });
    const cite: Cite = { what, how: "write it as {value, cell}", cents, id: g.cellIds?.[path], optional, pages: g.pages, pagesText: `the grid's pages (${g.pages.join(", ")})`, mark };
    return checkOne(doc, cite) ?? [];
  });
  return [...shapeIssues(cited, g.visits), ...values];
}

export function checkCitations(rulebook: Rulebook, docs: LoadedDoc[]): { problems: Problem[]; marked: Marked[] } {
  const marked: Marked[] = [];
  const problems: Problem[] = [
    ...rulebook.terms.flatMap((t) => citeTerm(t, docs, marked).map((message): Problem => ({ check: "cell", id: t.id, doc: t.source.doc, page: t.source.page, message }))),
    ...rulebook.grids.flatMap((g) => citeGrid(g, docs, marked).map((message): Problem => ({ check: "cell", id: g.id, doc: g.doc, page: g.pages[0], message }))),
  ];
  return { problems, marked };
}
