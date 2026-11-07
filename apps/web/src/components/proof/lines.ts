import type { Evidence } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { CoverageRef, Version } from "@/lib/types";
import { itemsOf, proofState } from "../contract/proofreads";
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

export type LineFilter = "all" | "needs" | "mine";

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
      name: g.arm ? `${g.name} · ${g.arm}` : g.name,
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

/** Not proofread by anyone yet, nothing proves it, or a question about it is open. */
export const needsChecking = (l: Line, version: Version) => l.openQuestion || l.evidence === "none" || (l.items.length > 0 && proofState(version, l.items, null).done < l.items.length);

export function filterLines(lines: Line[], version: Version, me: string | null, filter: LineFilter): Line[] {
  if (filter === "needs") return lines.filter((l) => needsChecking(l, version));
  if (filter === "mine") return lines.filter((l) => proofState(version, l.items, me).mine.length > 0);
  return lines;
}

/** "N of M checked by someone": a line counts once every one of its items has a mark. A line with nothing to mark isn't counted. */
export function progress(lines: Line[], version: Version) {
  const markable = lines.filter((l) => l.items.length > 0);
  return { done: markable.filter((l) => proofState(version, l.items, null).done === l.items.length).length, total: markable.length };
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
