import type { Evidence } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { CoverageRef, Version } from "@/lib/types";
import { itemsOf } from "../contract/proofreads";
import { flagsFor, markState } from "../viewer/reviewState";
import { GROUPS } from "../overview/model";
import { gridProof } from "../rulebook/model";
import { termValue } from "../rulebook/terms";

/** One thing to proofread: a rulebook term, or a whole budget grid (its cells are its items). */
export interface Line {
  key: string;
  ref: CoverageRef;
  group: string;
  name: string;
  value: string;
  evidence: Evidence;
  /** What a proofread mark is stored under; empty for a grid with no amounts. */
  items: string[];
  openQuestion: boolean;
}

export type LineFilter = "all" | "needs" | "flagged" | "mine";

/** How a row's dot reads: flagged by someone, needs a look (open question or nothing proves it, and nobody has checked it), checked by someone, or not checked. */
export type LineStatus = "unchecked" | "checked" | "flagged" | "look";

export const GRIDS_TITLE = "Budget grids";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Every line of the rulebook in the Overview's order: budget grids first, then the terms by group. */
export function buildLines(version: Version): Line[] {
  const rb = version.rulebook;
  if (!rb) return [];
  const open = new Set(rb.questions.filter((q) => q.state === "open" && q.about).map((q) => `${q.about!.target}:${q.about!.id}`));
  const grids = rb.grids.map((g): Line => {
    const ref: CoverageRef = { target: "grid", id: g.id, row: -1, col: 0 };
    return {
      key: `grid:${g.id}`,
      ref,
      group: GRIDS_TITLE,
      name: `Budget grid: ${g.arm ? `${g.name} · ${g.arm}` : g.name}`,
      value: [plural(g.rows.length, "item"), plural(g.visits.length, "visit"), g.grandTotalCents !== null && `${formatCents(g.grandTotalCents)} per patient`].filter(Boolean).join(" · "),
      evidence: gridProof(g, version),
      items: itemsOf(rb, ref),
      openQuestion: open.has(`grid:${g.id}`),
    };
  });
  const terms = GROUPS.flatMap((group) =>
    rb.terms
      .filter((t) => group.categories.includes(t.category))
      .map((t): Line => ({ key: `term:${t.id}`, ref: { target: "term", id: t.id }, group: group.title, name: t.name, value: termValue(t), evidence: t.evidence, items: [t.id], openQuestion: open.has(`term:${t.id}`) })),
  );
  return [...grids, ...terms];
}

/** Whether a line is the one a ref points at (a grid line stands for every cell of its grid). */
export const isLine = (l: Line, ref: CoverageRef | null) => !!ref && l.ref.target === ref.target && l.ref.id === ref.id;

const checkedBySomeone = (l: Line, version: Version) => l.items.length > 0 && markState(version, l.items, null).done === l.items.length;

/** Still to be checked: a line with something to mark that not every item of has a mark. What the filter, the count and "next" all mean. */
export const needsChecking = (l: Line, version: Version) => l.items.length > 0 && !checkedBySomeone(l, version);

export function lineStatus(l: Line, version: Version): LineStatus {
  if (flagsFor(version, l.items).length > 0) return "flagged";
  if (checkedBySomeone(l, version)) return "checked";
  return l.openQuestion || l.evidence === "none" ? "look" : "unchecked";
}

export function filterLines(lines: Line[], version: Version, me: string | null, filter: LineFilter): Line[] {
  if (filter === "needs") return lines.filter((l) => needsChecking(l, version));
  if (filter === "flagged") return lines.filter((l) => flagsFor(version, l.items).length > 0);
  if (filter === "mine") return lines.filter((l) => markState(version, l.items, me).mine.length > 0);
  return lines;
}

/** "N of M checked by someone": a line counts once every one of its items has a mark. A line with nothing to mark isn't counted. */
export function progress(lines: Line[], version: Version) {
  const markable = lines.filter((l) => l.items.length > 0);
  return { done: markable.filter((l) => checkedBySomeone(l, version)).length, total: markable.length };
}

/** The next line after `afterKey` (wrapping round, never the same line) that still needs checking: where one-key review goes after a mark. */
export function nextUnchecked(lines: Line[], version: Version, afterKey: string | null): Line | undefined {
  const at = lines.findIndex((l) => l.key === afterKey);
  const order = [...lines.slice(at + 1), ...lines.slice(0, Math.max(at, 0))];
  return order.find((l) => needsChecking(l, version));
}

/** The line `by` steps from the current one among the visible lines; with no current one visible, the first (forwards) or last (backwards). */
export function stepLine(visible: Line[], currentKey: string | null, by: 1 | -1): Line | undefined {
  const at = visible.findIndex((l) => l.key === currentKey);
  if (at < 0) return by === 1 ? visible[0] : visible.at(-1);
  return visible[Math.max(0, Math.min(visible.length - 1, at + by))];
}

export function sectionsOf(lines: Line[]): { title: string; lines: Line[] }[] {
  const out: { title: string; lines: Line[] }[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (last?.title === l.group) last.lines.push(l);
    else out.push({ title: l.group, lines: [l] });
  }
  return out;
}

/** What the screen opens on when a link names nothing: the first line that needs checking, else the first line. */
export const defaultLine = (lines: Line[], version: Version): Line | undefined => lines.find((l) => needsChecking(l, version)) ?? lines[0];
