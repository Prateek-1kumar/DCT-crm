import type { Rulebook } from "@dct/shared";
import type { GridResult, LoadedDoc } from "../types";
import { amountsIn, usd } from "./text";

type Grid = Rulebook["grids"][number];
type Cell = Grid["rows"][number]["cells"][number];

const num = (c: Cell | undefined): number | null => (typeof c === "number" ? c : null);
const sum = (cells: Cell[]) => cells.reduce<number>((s, c) => s + (num(c) ?? 0), 0);

export const ROUNDING_TOLERANCE_CENTS = 50;

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

export function checkGrid(grid: Grid, docs: LoadedDoc[]): GridResult {
  const shape = shapeProblems(grid);
  if (shape.length) return { problems: shape, unproven: numericCells(grid) };
  if (grid.acceptedAsPrinted) return { problems: [], unproven: [] };

  const problems: string[] = [];
  const covered = grid.rows.map((r) => r.cells.map(() => false));
  const coverRow = (i: number) => covered[i]!.fill(true);
  const coverColumn = (j: number) => covered.forEach((r) => (r[j] = true));
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
      if (s === grid.grandTotalCents) grid.rows.forEach((_, i) => coverRow(i));
      else problems.push(`all the rows add up to ${usd(s)} but the printed grand total is ${usd(grid.grandTotalCents)}.`);
    }
  }

  if (!subtotal && !total && grid.grandTotalCents === null && grid.rows.every((r) => r.printedRowTotalCents === null)) {
    problems.push("nothing printed proves these cells: capture the printed subtotal/total rows.");
  }

  grid.cellsReadTwice.forEach(([row, col]) => {
    if (covered[row]?.[col] !== undefined) covered[row]![col] = true;
  });
  const printed = printedAmounts(grid, docs);
  const unproven = numericCells(grid).filter(({ row, col }) => !covered[row]![col]! && !printed.has(Math.abs(num(grid.rows[row]!.cells[col])!)));
  return { problems, unproven };
}
