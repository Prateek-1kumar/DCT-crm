import type { Evidence, Grid, Rulebook, Term } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { Coverage, CoverageRef, Version } from "@/lib/types";
import { capText, CATEGORY_LABEL, HOLDBACK_LABEL, OVERHEAD_LABEL, termMoney } from "./terms";

/**
 * What "Show in the contract" points at: a term, or one grid cell. On a grid, row -1 is a printed line (subtotal, overhead,
 * additions, total), as GridTable reports it; row 0 / col 0 is used when a whole grid is meant.
 */
export type ShowRef = CoverageRef;

/** The props every tab shares; presentational, nothing is fetched inside. */
export interface TabProps {
  version: Version;
  coverage?: Coverage;
  /** Free-text filter over names, amounts, quotes and notes. */
  query: string;
  /** The person using the app, or null before they chose a name. */
  me: string | null;
  onShow: (ref: ShowRef) => void;
  /** Add (mark true) or remove (false) the signed-in person's proofread mark on these items. */
  onProofread: (items: string[], mark: boolean) => void;
}

const norm = (s: string) => s.toLowerCase();

/** Whether a term matches the query: names, amounts ("$5,000.00" or "5000"), quotes, notes and the other words on it. */
export function termMatches(term: Term, query: string): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm(
    [
      term.name,
      CATEGORY_LABEL[term.category],
      term.amountCents === null ? null : formatCents(term.amountCents),
      termMoney(term),
      term.trigger,
      term.conditions,
      term.deadline,
      term.notes,
      term.source.quote,
      term.cap && capText(term.cap),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return hay.includes(q) || hay.replace(/[$,]/g, "").includes(q.replace(/[$,]/g, ""));
}

export function gridMatches(grid: Grid, query: string): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm(
    [grid.name, grid.arm, grid.doc, ...grid.visits, ...grid.rows.flatMap((r) => [r.name, r.code]), grid.grandTotalCents === null ? null : formatCents(grid.grandTotalCents)].filter(Boolean).join("\n"),
  );
  return hay.includes(q) || hay.replace(/[$,]/g, "").includes(q.replace(/[$,]/g, ""));
}

/** Names of the people who proofread an item, once each, in the order they marked it. */
export function proofreaders(version: Version, item: string): string[] {
  return [...new Set(version.proofreads.filter((p) => p.item === item).map((p) => p.by))];
}

/** People who proofread any cell of a grid, and how many cells are marked. */
export function gridProofreads(version: Version, gridId: string) {
  const marks = version.proofreads.filter((p) => p.item.startsWith(`grid:${gridId}:`));
  return { names: [...new Set(marks.map((p) => p.by))], cells: new Set(marks.map((p) => p.item)).size };
}

/** "row:col" of every cell of a grid that someone proofread. */
export function proofreadCells(version: Version, gridId: string): Set<string> {
  const prefix = `grid:${gridId}:`;
  return new Set(version.proofreads.filter((p) => p.item.startsWith(prefix)).map((p) => p.item.slice(prefix.length)));
}

/** "row:col" of every cell of a grid where an amount was missed or flagged as doubtful when the page was checked. */
export function doubtfulCells(coverage: Coverage | undefined, gridId: string): Set<string> {
  const out = new Set<string>();
  for (const page of coverage?.pages ?? [])
    for (const a of page.amounts) if (a.ref?.target === "grid" && a.ref.id === gridId && (a.doubt !== null || a.status === "missing")) out.add(`${a.ref.row}:${a.ref.col}`);
  return out;
}

/** Ids of the terms an open blocking question is about. */
export function termsNeedingDecision(rulebook: Rulebook): Set<string> {
  return new Set(rulebook.questions.filter((q) => q.state === "open" && q.blocking && q.about?.target === "term").map((q) => q.about!.id));
}

export function gridsNeedingDecision(rulebook: Rulebook): Set<string> {
  return new Set(rulebook.questions.filter((q) => q.state === "open" && q.blocking && q.about?.target === "grid").map((q) => q.about!.id));
}

/** A card or row that should come first: an open question, an unclear rule, unsettled billing or nothing proving it. */
export const needsAttention = (term: Term, decision: Set<string>) =>
  decision.has(term.id) || term.holdbackApplies === "unclear" || term.overheadApplies === "unclear" || term.billing === "unknown" || term.evidence === "none";

/** Stable: attention first, otherwise the rulebook's own order. */
export const attentionFirst = (terms: Term[], decision: Set<string>) => [...terms.filter((t) => needsAttention(t, decision)), ...terms.filter((t) => !needsAttention(t, decision))];

/** The one-line detail of a term: trigger, cap, conditions, deadline, and whether holdback or overhead reach it. `omit`: a field already shown as the card's value. */
export function termDetail(term: Term, omit?: "trigger" | "conditions" | "deadline" | null): string {
  return [
    omit !== "trigger" && term.trigger,
    term.cap && capText(term.cap),
    omit !== "conditions" && term.conditions,
    omit !== "deadline" && term.deadline && `Due ${term.deadline}`,
    term.holdbackApplies !== "n/a" && HOLDBACK_LABEL[term.holdbackApplies],
    term.overheadApplies !== "n/a" && OVERHEAD_LABEL[term.overheadApplies],
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * How well a grid's figures are proven. The printed subtotal and total rows are what the grid arithmetic checks, so a
 * grid that prints them is "math" unless a check reported a problem with it; a person can accept it as printed.
 */
export function gridProof(grid: Grid, version: Version): Evidence {
  if (grid.acceptedAsPrinted) return "person";
  if (version.problems.some((p) => p.id === grid.id)) return "none";
  return grid.total || grid.subtotal ? "math" : "none";
}
