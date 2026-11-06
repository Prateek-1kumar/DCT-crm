import { pageOfCell, type Rulebook } from "@dct/shared";
import { amountsOf, centsOf, type ScanCell } from "../scan/cells";
import type { Doubt, LoadedDoc, Problem } from "../types";
import { printedAmounts } from "./grid";
import { amountsIn, looseContains, looseKey, usd } from "./text";

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

/** The marks that send a value to a person, in words. */
export const MARKS: Partial<Record<Doubt, string>> = { handwritten: "handwritten", struck_out: "struck out", initialed: "initialed" };

export const cellsOn = (doc: LoadedDoc, page: number) => doc.pages.find((p) => p.page === page)?.cells;
export const cellOf = (doc: LoadedDoc, id: string) => cellsOn(doc, pageOfCell(id))?.find((c) => c.id === id);
export const isMarked = (cell: ScanCell) => cell.doubts.some((d) => MARKS[d] !== undefined);

// A line's amount sits among its words, and a marked cell can hold a struck value and its replacement; any other cell prints
// one amount, maybe with words ("$1,500.00 per visit") or bare ("1500").
const prints = (cell: ScanCell, cents: number) => (cell.table === null || isMarked(cell) ? amountsOf(cell.text).includes(cents) : centsOf(cell.text) === cents);

interface Cite {
  what: string;
  /** Where the citation goes, for the message that asks for one. */
  how: string;
  cents: number;
  /** undefined when nothing is cited; null when an answer or a second read changed the amount, so it no longer rests on a cell. */
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
export const rowText = (doc: LoadedDoc, cell: ScanCell) =>
  cell.table === null ? cell.text : (cellsOn(doc, cell.page) ?? []).filter((c) => c.table === cell.table && c.row === cell.row).map((c) => c.text).join(" ");

/** Why a term's amounts on a scanned page don't match the cells they cite. Text pages need none, but for a cap printed only on a scanned page. */
export function citeTerm(t: Term, docs: LoadedDoc[], marked: Marked[] = []): string[] {
  const doc = docs.find((d) => d.name === t.source.doc);
  if (!doc) return [];
  const onScan = cellsOn(doc, t.source.page) !== undefined;
  const onText = (cents: number) => doc.pages.some((p) => p.kind === "text" && amountsIn(p.layout).includes(cents));
  const capCited = (cents: number) => onScan || t.source.capCell !== undefined || (doc.pages.some((p) => p.cells) && !onText(cents));
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
    ...(t.amountCents === null || !onScan ? [] : [{ ...base, what: "the amount", how: "source.cell", cents: t.amountCents, id: t.source.cell, misplaced, mark: mark("amountCents") }]),
    ...(t.cap?.kind === "amount" && t.cap.value !== null && capCited(t.cap.value) ? [{ ...base, what: "the cap", how: "source.capCell", cents: t.cap.value, id: t.source.capCell, pages: scanned, pagesText: `a scanned page of ${doc.name}`, mark: mark("cap.value") }] : []),
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
function gridAmounts(g: Grid): Amount[] {
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

const alike = (a: string, b: string) => !a.trim() || !b.trim() || looseContains(a, b) || looseContains(b, a);

/** A printed name that only loosely fits is refused when it is, to the letter, the name of another visit or grid line ("Fee" inside "Fee with overhead"). */
const fits = (printed: string, name: string, others: string[]) =>
  alike(printed, name) && (looseKey(printed) === looseKey(name) || !others.some((o) => looseKey(o) === looseKey(printed)));

type Placed = { amount: Amount; row: string; col: string; cell: ScanCell | undefined };

/**
 * Why the grid's names don't fit the printed table they cite, read one way round: each grid row's name is its printed row's
 * label, each visit its printed column's heading (where the table has headings), and no two grid lines share a printed row.
 * Sideways, rows and columns swap.
 */
function namesOff(table: string, cells: Placed[], visits: string[], lineNames: Map<string, string>, sideways: boolean): string[] {
  const out = new Map<string, string>();
  const lineAt = new Map<string, Map<string, string>>();
  for (const { amount, row, col, cell } of cells) {
    if (!cell) continue;
    const [printedLine, lineName, visitName] = sideways ? [col, cell.heading ?? "", cell.rowLabel ?? ""] : [row, cell.rowLabel ?? "", cell.heading ?? ""];
    if (amount.line) lineAt.set(printedLine, (lineAt.get(printedLine) ?? new Map()).set(amount.line.key, amount.line.name));
    const name = amount.line?.key.startsWith("rows.") ? amount.line.name.replace(/^row '(.*)'$/, "$1") : undefined;
    const otherLines = [...lineNames].filter(([key]) => key !== amount.line?.key).map(([, n]) => n);
    if (name !== undefined && !fits(lineName, name, otherLines) && !out.has(amount.line!.key)) {
      out.set(amount.line!.key, `${amount.line!.name} cites ${cell.id}, printed under "${lineName}": cite the cells printed for that row, or name the grid row as printed.`);
    }
    const visit = amount.visit === undefined ? undefined : visits[amount.visit];
    if (visit !== undefined && !fits(visitName, visit, visits.filter((_, k) => k !== amount.visit)) && !out.has(`visit ${amount.visit}`)) {
      out.set(`visit ${amount.visit}`, `visit '${visit}' cites ${cell.id}, printed under "${visitName}": cite the cells printed for that visit, or name the visit as printed.`);
    }
  }
  const shared = [...lineAt].filter(([, lines]) => lines.size > 1);
  const where = sideways ? "column" : "row";
  return [...out.values(), ...shared.map(([at, lines]) => `${[...lines.values()].join(" and ")} all cite printed ${where} ${at} of table ${table}: each grid line comes from its own printed ${where}.`)];
}

/**
 * In each printed table, each grid line cites one printed row and each visit one printed column, or, in a table printed
 * sideways, the other way round, and the names match what is printed there. A budget may span several tables, on one page
 * or more.
 */
function shapeIssues(doc: LoadedDoc, cited: { amount: Amount; id: string }[], visits: string[]): string[] {
  const lineNames = new Map(cited.flatMap(({ amount: { line } }) => (line?.key.startsWith("rows.") ? [[line.key, line.name.replace(/^row '(.*)'$/, "$1")] as const] : [])));
  const tables = new Map<string, Placed[]>();
  for (const { amount, id } of cited) {
    const m = TABLE_CELL.exec(id);
    if (m) tables.set(m[1]!, [...(tables.get(m[1]!) ?? []), { amount, row: `${m[1]}.r${m[2]}`, col: `${m[1]}.c${m[3]}`, cell: cellOf(doc, id) }]);
  }
  return [...tables].flatMap(([table, cells]) => {
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
    const upright = !rows.length && !columns.length;
    const sideways = !spread(line, "col").length && !spread(visit, "row").length;
    // a table each line and visit cite one cell of reads either way round; the names say which
    const named = [...(upright ? [namesOff(table, cells, visits, lineNames, false)] : []), ...(sideways ? [namesOff(table, cells, visits, lineNames, true)] : [])];
    if (named.length) return named.some((issues) => !issues.length) ? [] : named[0]!;
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
  const amounts = gridAmounts(g);
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
  return [...shapeIssues(doc, cited, g.visits), ...values];
}

export function checkCitations(rulebook: Rulebook, docs: LoadedDoc[]): { problems: Problem[]; marked: Marked[] } {
  const marked: Marked[] = [];
  const problems: Problem[] = [
    ...rulebook.terms.flatMap((t) => citeTerm(t, docs, marked).map((message): Problem => ({ check: "cell", id: t.id, doc: t.source.doc, page: t.source.page, message }))),
    ...rulebook.grids.flatMap((g) => citeGrid(g, docs, marked).map((message): Problem => ({ check: "cell", id: g.id, doc: g.doc, page: g.pages[0], message }))),
  ];
  return { problems, marked };
}
