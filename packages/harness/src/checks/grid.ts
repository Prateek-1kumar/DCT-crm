import type { Rulebook } from "@dct/shared";
import type { GridResult, LoadedDoc } from "../types";
import { amountsIn, usd } from "./text";

type Grid = Rulebook["grids"][number];
type Cell = Grid["rows"][number]["cells"][number];

const num = (c: Cell | undefined): number | null => (typeof c === "number" ? c : null);
const sum = (cells: Cell[]) => cells.reduce<number>((s, c) => s + (num(c) ?? 0), 0);

const ROUNDING_TOLERANCE_CENTS = 50;

function numericCells(grid: Grid) {
  return grid.rows.flatMap((r, row) => r.cells.flatMap((c, col) => (num(c) === null ? [] : [{ row, col }])));
}

function shapeProblems(grid: Grid): string[] {
  const n = grid.visits.length;
  const bad = (what: string, len: number) => `${what} has ${len} values but the grid has ${n} visits: give exactly one value per visit (null for a blank).`;
  return [
    ...grid.rows.filter((r) => r.cells.length !== n).map((r) => bad(`row '${r.name}'`, r.cells.length)),
    ...(["subtotal", "overhead", "total"] as const).flatMap((k) => {
      const arr = grid[k];
      return arr && arr.length !== n ? [bad(`the ${k} line`, arr.length)] : [];
    }),
    ...grid.additions.filter((a) => a.cells.length !== n).map((a) => bad(`the '${a.name}' line`, a.cells.length)),
  ];
}

// Amount-on-page only: it is not checked to sit in this cell's position. Upgrade path: match the word box in the grid's region.
export function printedAmounts(grid: Grid, docs: LoadedDoc[]): Set<number> {
  const doc = docs.find((d) => d.name === grid.doc);
  const pages = doc?.pages.filter((p) => p.kind === "text" && grid.pages.includes(p.page)) ?? [];
  return new Set(pages.flatMap((p) => amountsIn(p.layout)));
}

export const NOT_PRINTED = "nothing printed proves these cells: capture the printed subtotal/total rows.";

/** A grid with none of these lines has nothing to add up: its cells are settled one by one, never accepted "as printed". */
export const printsTotals = (grid: Grid) => !!grid.subtotal || !!grid.total || grid.grandTotalCents !== null || grid.rows.some((r) => r.printedRowTotalCents !== null);

/** Whether any of a document's pages listed is a transcribed scan: one rule for grids and terms alike. */
export const onScan = (docs: LoadedDoc[], doc: string, pages: number[]) => docs.find((d) => d.name === doc)?.pages.some((p) => p.kind === "scan" && pages.includes(p.page)) ?? false;

export function checkGrid(grid: Grid, docs: LoadedDoc[]): GridResult {
  const shape = shapeProblems(grid);
  if (shape.length) return { problems: shape, unproven: numericCells(grid) };
  if (grid.acceptedAsPrinted) return { problems: [], unproven: [] };

  const problems: string[] = [];
  const covered = grid.rows.map((r) => r.cells.map(() => false));
  // On a scan a figure that slipped into a blank cell along a row or column keeps that line's total, so no sum pins a cell
  // there: a summed cell rests on the second read, whose different figure may stand when the sums then hold.
  const scanned = onScan(docs, grid.doc, grid.pages);
  const loose = grid.rows.map((r) => r.cells.map(() => false));
  const coverRow = (i: number) => (scanned ? loose : covered)[i]!.fill(true);
  const coverColumn = (j: number) => (scanned ? loose : covered).forEach((r) => (r[j] = true));
  const coverAll = () => (scanned ? loose : covered).forEach((r) => r.fill(true));
  const subtotal = grid.subtotal;
  const total = grid.total;

  grid.rows.forEach((r, i) => {
    if (r.printedRowTotalCents === null) return;
    const s = sum(r.cells);
    if (s === r.printedRowTotalCents) coverRow(i);
    else problems.push(`row '${r.name}': the cells add up to ${usd(s)} but the printed row total is ${usd(r.printedRowTotalCents)}.`);
  });

  grid.visits.forEach((visit, j) => {
    const sub = num(subtotal?.[j]);
    const oh = num(grid.overhead?.[j]);
    const tot = num(total?.[j]);

    if (sub !== null && grid.rows.length) {
      const s = sum(grid.rows.map((r) => r.cells[j]!));
      if (s === sub) coverColumn(j);
      else problems.push(`visit '${visit}': rows add up to ${usd(s)} but the printed subtotal is ${usd(sub)}.`);
    }

    if (sub !== null && oh !== null && grid.overheadPct !== null) {
      const want = Math.round((sub * grid.overheadPct) / 100);
      if (Math.abs(oh - want) > ROUNDING_TOLERANCE_CENTS) {
        problems.push(`visit '${visit}': overhead is printed as ${usd(oh)} but ${grid.overheadPct}% of the ${usd(sub)} subtotal is ${usd(want)}.`);
      }
    }

    const added = grid.additions.reduce((a, add) => a + (num(add.cells[j]) ?? 0), 0);
    if (sub !== null && tot !== null) {
      const s = sub + (oh ?? 0) + added;
      if (s !== tot) problems.push(`visit '${visit}': subtotal, overhead and added lines come to ${usd(s)} but the printed total is ${usd(tot)}.`);
    } else if (sub === null && tot !== null && grid.rows.length) {
      const s = sum(grid.rows.map((r) => r.cells[j]!)) + (oh ?? 0) + added;
      if (s === tot) coverColumn(j);
      else problems.push(`visit '${visit}': rows, overhead and added lines come to ${usd(s)} but the printed total is ${usd(tot)}.`);
    }
  });

  if (grid.grandTotalCents !== null) {
    if (total) {
      const s = sum(total);
      if (s !== grid.grandTotalCents) problems.push(`the visit totals add up to ${usd(s)} but the printed grand total is ${usd(grid.grandTotalCents)}.`);
    } else if (grid.rows.length) {
      const s = grid.rows.reduce((a, r) => a + sum(r.cells), 0);
      if (s === grid.grandTotalCents) coverAll();
      else problems.push(`all the rows add up to ${usd(s)} but the printed grand total is ${usd(grid.grandTotalCents)}.`);
    }
  }

  grid.cellsReadTwice.forEach(([row, col]) => {
    if (covered[row]?.[col] !== undefined) covered[row]![col] = true;
  });
  if (!printsTotals(grid) && numericCells(grid).some(({ row, col }) => !covered[row]![col])) {
    problems.push(NOT_PRINTED);
  }
  // a text page's amount stands for a cell only when the cell doesn't say it was read from a scan
  const printed = printedAmounts(grid, docs);
  const onText = (row: number, col: number) => typeof grid.cellIds?.[`rows.${row}.cells.${col}`] !== "string" && printed.has(Math.abs(num(grid.rows[row]!.cells[col])!));
  const unproven = numericCells(grid).filter(({ row, col }) => !covered[row]![col]! && !onText(row, col));
  const bySumOnly = unproven.filter(({ row, col }) => loose[row]![col]);
  return { problems, unproven, ...(bySumOnly.length > 0 && { bySumOnly }) };
}
