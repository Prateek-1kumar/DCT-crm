import type { Rulebook } from "@dct/shared";
import type { CoverageRef, Version } from "@/lib/types";
import { cellItem, gridItems } from "./highlights";

/** The proofread items a line stands for: a term, one grid cell, or (for a printed line or a whole grid) every cell of the grid. */
export function itemsOf(rulebook: Rulebook, ref: CoverageRef): string[] {
  if (ref.target === "term") return rulebook.terms.some((t) => t.id === ref.id) ? [ref.id] : [];
  const grid = rulebook.grids.find((g) => g.id === ref.id);
  if (!grid) return [];
  if (ref.row >= 0) return typeof grid.rows[ref.row]?.cells[ref.col] === "number" ? [cellItem(grid.id, ref.row, ref.col)] : [];
  return gridItems(grid);
}

/** Who has marked these items, how many are marked by anyone, and whether the person using the app has marked any. */
export function proofState(version: Version, items: string[], me: string | null) {
  const set = new Set(items);
  const marks = version.proofreads.filter((p) => set.has(p.item));
  const names = [...new Set(marks.map((p) => p.by))];
  return {
    names,
    done: new Set(marks.map((p) => p.item)).size,
    total: items.length,
    /** the items the person using the app has marked / has not marked yet */
    mine: me === null ? [] : items.filter((i) => marks.some((p) => p.item === i && p.by === me)),
    todo: me === null ? items : items.filter((i) => !marks.some((p) => p.item === i && p.by === me)),
  };
}

/** "Proofread by Ana, Ben" / "3 of 8 cells proofread by Ana" / "Not proofread yet". */
export function proofStatus(version: Version, items: string[]): string {
  const { names, done } = proofState(version, items, null);
  if (names.length === 0) return "Not proofread yet";
  return items.length > 1 ? `${done} of ${items.length} cells proofread by ${names.join(", ")}` : `Proofread by ${names.join(", ")}`;
}
