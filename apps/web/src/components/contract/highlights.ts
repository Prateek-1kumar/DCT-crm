import type { Grid } from "@dct/shared";
import type { CoverageAmount, CoveragePage, CoverageRef } from "@/lib/types";
import { sameRef } from "../proof/model";

/** An amount worth a second look: the rulebook has no line for it, or it was read with a doubt (unsure, handwritten, struck out, initialed). */
export const isProblem = (a: CoverageAmount) => a.status === "missing" || a.doubt !== null;

/**
 * Which of a page's amounts to draw. By default only problems; `showAll` adds every one. The selected amount and the
 * ones that belong to the line being shown are always drawn, so what you asked to see is never hidden by the filter.
 */
export function visibleAmounts(page: CoveragePage, { showAll, selected, strong }: { showAll: boolean; selected: number | null; strong: readonly number[] }): number[] {
  return page.amounts.flatMap((a, i) => (showAll || isProblem(a) || i === selected || strong.includes(i) ? [i] : []));
}

/**
 * The amounts on a page that a line points at. A grid cell matches its own amount only; a printed line (row -1) matches
 * the amounts of that line, and failing that the whole grid's, since a whole-grid link has no single amount.
 */
export function amountsOf(page: CoveragePage, ref: CoverageRef): number[] {
  const pick = (ok: (r: CoverageRef) => boolean) => page.amounts.flatMap((a, i) => (a.ref && ok(a.ref) ? [i] : []));
  const exact = pick((r) => sameRef(r, ref));
  if (exact.length || ref.target === "term" || ref.row >= 0) return exact;
  const printed = pick((r) => r.target === "grid" && r.id === ref.id && r.row === -1);
  return printed.length ? printed : pick((r) => r.target === "grid" && r.id === ref.id);
}

/** The item a proofread mark is stored under for one grid cell. */
export const cellItem = (gridId: string, row: number, col: number) => `grid:${gridId}:${row}:${col}`;

/** Every item cell of a grid that holds an amount: what "proofread this grid" marks. */
export function gridItems(grid: Grid): string[] {
  return grid.rows.flatMap((r, row) => r.cells.flatMap((c, col) => (typeof c === "number" ? [cellItem(grid.id, row, col)] : [])));
}
