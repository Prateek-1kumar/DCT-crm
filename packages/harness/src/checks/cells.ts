import { parseCents, type Rulebook } from "@dct/shared";
import type { ScanCell } from "../scan/cells";
import type { Doubt, LoadedDoc, Problem } from "../types";
import { amountsIn, usd } from "./text";

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

const transcribed = (doc: LoadedDoc | undefined, page: number) => doc?.pages.find((p) => p.page === page)?.cells !== undefined;

function cellOf(doc: LoadedDoc, id: string): ScanCell | undefined {
  const page = Number(/^p(\d+)\./.exec(id)?.[1]);
  return doc.pages.find((p) => p.page === page)?.cells?.find((c) => c.id === id);
}

// Each amount read exactly, never loosely: a struck value and its handwritten replacement are both printed in the cell.
const printed = (cell: ScanCell) => [parseCents(cell.text), ...amountsIn(cell.text)];

/** One amount against the cell it cites: why it fails, or null. `optional` when a person settled it, so it may cite nothing. */
function checkOne(doc: LoadedDoc, what: string, how: string, cents: number, id: string | undefined, optional: boolean, marked: (cell: ScanCell) => void): string | null {
  if (id === undefined) return optional ? null : `${what} is on a scanned page, so it has to cite the cell or line it is printed in (${how}), with its id as read_pages shows it, e.g. p7.t1.r5.c3.`;
  const cell = cellOf(doc, id);
  if (!cell) return `${what} cites ${id}, but ${doc.name} has no cell or line with that id: copy the id as read_pages shows it.`;
  if (!printed(cell).includes(cents)) {
    return `${what} is ${usd(cents)}, but cell ${id} ${cell.text ? `prints "${cell.text}"` : "is blank"}: write the amount as the cited cell prints it, or cite the cell it is printed in.`;
  }
  if (cell.doubts.some((d) => MARKS.has(d))) marked(cell);
  return null;
}

/** Why a term's amount on a scanned page doesn't match the cell it cites, or null. Text pages need no citation. */
export function citeTerm(t: Term, docs: LoadedDoc[], marked: Marked[] = []): string | null {
  const doc = docs.find((d) => d.name === t.source.doc);
  if (t.amountCents === null || !doc || !transcribed(doc, t.source.page)) return null;
  const mark = (cell: ScanCell) => marked.push({ target: "term", id: t.id, path: "amountCents", cell: cell.id, doubts: cell.doubts });
  return checkOne(doc, "the amount", "source.cell", t.amountCents, t.source.cell, t.evidence === "person", mark);
}

/** Every amount of a grid, by its place as a patch names it, in plain words. */
function amountsOf(g: Grid) {
  const at = (v: unknown, path: string, what: string) => (typeof v === "number" ? [{ path, cents: v, what }] : []);
  const line = (cells: Grid["subtotal"], path: string, what: string) => (cells ?? []).flatMap((c, j) => at(c, `${path}.${j}`, `${what} at visit '${g.visits[j]}'`));
  return [
    ...g.rows.flatMap((r, i) => [
      ...at(r.unitCostCents, `rows.${i}.unitCostCents`, `the unit cost of row '${r.name}'`),
      ...line(r.cells, `rows.${i}.cells`, `row '${r.name}'`),
      ...at(r.printedRowTotalCents, `rows.${i}.printedRowTotalCents`, `the printed total of row '${r.name}'`),
    ]),
    ...line(g.subtotal, "subtotal", "the subtotal"),
    ...line(g.overhead, "overhead", "the overhead"),
    ...g.additions.flatMap((a, i) => line(a.cells, `additions.${i}.cells`, `the added line '${a.name}'`)),
    ...line(g.total, "total", "the total"),
    ...at(g.grandTotalCents, "grandTotalCents", "the grand total"),
  ];
}

/** Why each amount of a grid on a scanned page doesn't match the cell it cites. A grid on text pages needs no citations. */
export function citeGrid(g: Grid, docs: LoadedDoc[], marked: Marked[] = []): string[] {
  const doc = docs.find((d) => d.name === g.doc);
  if (!doc || !g.pages.some((n) => transcribed(doc, n))) return [];
  const settled = new Set(g.cellsReadTwice.map(([row, col]) => `rows.${row}.cells.${col}`));
  return amountsOf(g).flatMap(({ path, cents, what }) => {
    const mark = (cell: ScanCell) => marked.push({ target: "grid", id: g.id, path, cell: cell.id, doubts: cell.doubts });
    return checkOne(doc, what, "write it as {value, cell}", cents, g.cellIds?.[path], settled.has(path), mark) ?? [];
  });
}

export function checkCitations(rulebook: Rulebook, docs: LoadedDoc[]): { problems: Problem[]; marked: Marked[] } {
  const marked: Marked[] = [];
  const problems: Problem[] = [
    ...rulebook.terms.flatMap((t): Problem[] => {
      const message = citeTerm(t, docs, marked);
      return message ? [{ check: "cell", id: t.id, doc: t.source.doc, page: t.source.page, message }] : [];
    }),
    ...rulebook.grids.flatMap((g) => citeGrid(g, docs, marked).map((message): Problem => ({ check: "cell", id: g.id, doc: g.doc, page: g.pages[0], message }))),
  ];
  return { problems, marked };
}
