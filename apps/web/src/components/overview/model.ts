import type { Evidence, Grid, Rulebook, Term } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { CoverageRef, Version } from "@/lib/types";
import { gridProof, gridsNeedingDecision, needsAttention, termDetail, termMatches, termsNeedingDecision, type ShowRef } from "../rulebook/model";
import { CATEGORY_LABEL, termMoney } from "../rulebook/terms";

/** A reviewer's "something looks wrong" as a card shows it. `where` names the cell for a grid flag ("Blood draw, Screening"). */
export interface CardFlag {
  by: string;
  note: string;
  at: string;
  where: string | null;
}

export interface CardModel {
  key: string;
  /** Small label: the category in plain words (or the arm's name). */
  label: string;
  /** The big value: an amount, or the rule when there is no single amount. */
  value: string;
  detail: string;
  /** Null for a card with nothing to prove (a muted "none found" card, an amendment). */
  evidence: Evidence | null;
  muted: boolean;
  needsDecision: boolean;
  attention: boolean;
  /** Reviewers' flags on this card's term, or on any cell of its grid. A flagged card counts as needing attention. */
  flags: CardFlag[];
  /** The term's id, which is also its proofread item. */
  termId: string | null;
  show: ShowRef | null;
  /** What the search matches for a card that isn't a term. */
  text: string;
  term?: Term;
}

export interface Section {
  key: string;
  title: string;
  cards: CardModel[];
}

/** An accountant's view of what is billed, in display order. Core categories are pulled out into "Key rules" first. */
export const GROUPS: { key: string; title: string; categories: Term["category"][] }[] = [
  { key: "payment", title: "Payment and invoicing", categories: ["payment_terms", "invoicing", "deadline"] },
  { key: "holdback", title: "Holdback and overhead", categories: ["holdback", "overhead"] },
  { key: "site_fees", title: "Site fees", categories: ["site_fee"] },
  { key: "recurring", title: "Recurring fees", categories: ["recurring_fee"] },
  { key: "invoiceable", title: "Invoiceable items", categories: ["invoiceable"] },
  { key: "conditional", title: "Conditional procedures, screen failures and unscheduled visits", categories: ["conditional_procedure", "screen_failure", "unscheduled_visit"] },
  { key: "stipends", title: "Stipends, travel and bonuses", categories: ["stipend_travel", "bonus"] },
  { key: "caps", title: "Caps and limits", categories: ["cap_or_limit"] },
  { key: "other", title: "Other", categories: ["other"] },
];

/** The rules every contract is read for: each always gets a card, muted when the contract has none. */
export const CORE: { key: string; label: string; categories: Term["category"][] }[] = [
  { key: "payment_terms", label: "Payment terms", categories: ["payment_terms"] },
  { key: "holdback", label: "Holdback", categories: ["holdback"] },
  { key: "overhead", label: "Overhead", categories: ["overhead"] },
  { key: "screen_failure", label: "Screen failures", categories: ["screen_failure"] },
  { key: "unscheduled_visit", label: "Unscheduled visits", categories: ["unscheduled_visit"] },
  { key: "invoice_deadlines", label: "Invoice deadlines", categories: ["invoicing", "deadline"] },
];

export const NONE_FOUND = "None found in this contract";

const termFlags = (version: Version, id: string): CardFlag[] => version.flags.filter((f) => f.item === id).map((f) => ({ by: f.by, note: f.note, at: f.at, where: null }));

/** Flags on any cell of a grid, each told apart by the cell it is on. */
export function gridFlags(version: Version, grid: Grid): CardFlag[] {
  const prefix = `grid:${grid.id}:`;
  return version.flags
    .filter((f) => f.item.startsWith(prefix))
    .map((f) => {
      const [row, col] = f.item.slice(prefix.length).split(":").map(Number);
      const r = grid.rows[row!];
      const visit = grid.visits[col!];
      return { by: f.by, note: f.note, at: f.at, where: r ? [r.name, visit].filter(Boolean).join(", ") : null };
    });
}

/** The card's flag as one line for a pill: the first flag's note cut to about 60 characters, and how many more there are. The full words go in `title`. */
export function flagPill(flags: CardFlag[]) {
  const [first] = flags;
  if (!first) return null;
  const note = first.note.length > 60 ? `${first.note.slice(0, 59).trimEnd()}…` : first.note;
  return {
    text: `Flagged by ${first.by}: ${note}`,
    more: flags.length - 1,
    title: flags.map((f) => `${f.by}${f.where ? ` (${f.where})` : ""}: ${f.note}`).join("\n"),
  };
}

/** What a flag's item stands for, in words: a term, or one grid cell. Null when the rulebook no longer has it. */
export function describeItem(rulebook: Rulebook, item: string): { name: string; value: string; ref: CoverageRef } | null {
  const grid = item.startsWith("grid:") ? /^grid:(.+):(-?\d+):(-?\d+)$/.exec(item) : null;
  if (grid) {
    const g = rulebook.grids.find((x) => x.id === grid[1]);
    const row = g?.rows[Number(grid[2])];
    const cell = row?.cells[Number(grid[3])];
    if (!g || !row) return null;
    return { name: `${row.name}, ${g.visits[Number(grid[3])] ?? "a visit"}`, value: typeof cell === "number" ? formatCents(cell) : (cell ?? "blank"), ref: { target: "grid", id: g.id, row: Number(grid[2]), col: Number(grid[3]) } };
  }
  const t = rulebook.terms.find((x) => x.id === item);
  return t ? { name: t.name, value: termCard(t, new Set()).value, ref: { target: "term", id: t.id } } : null;
}

export function termCard(t: Term, decision: Set<string>, flags: CardFlag[] = []): CardModel {
  const money = termMoney(t);
  // A deadline or rule with no money in it is still the card's headline, so it is not repeated in the detail line.
  const fallback = money ? null : (["deadline", "trigger", "conditions"] as const).find((k) => t[k]) ?? null;
  const needsDecision = decision.has(t.id);
  return {
    key: t.id,
    label: CATEGORY_LABEL[t.category],
    value: money || (fallback ? t[fallback]! : "No amount stated"),
    detail: termDetail(t, fallback),
    evidence: t.evidence,
    muted: false,
    needsDecision,
    attention: needsAttention(t, decision) || flags.length > 0,
    flags,
    termId: t.id,
    show: { target: "term", id: t.id },
    text: "",
    term: t,
  };
}

function noneCard(key: string, label: string, detail = ""): CardModel {
  return { key: `none-${key}`, label, value: NONE_FOUND, detail, evidence: null, muted: true, needsDecision: false, attention: false, flags: [], termId: null, show: null, text: `${label} ${NONE_FOUND} ${detail}` };
}

/** Whether the contract says nothing is withheld: some term is paid in full and none is held back or unclear. */
export const saysNoHoldback = (terms: Term[]) => terms.some((t) => t.holdbackApplies === "no") && !terms.some((t) => t.holdbackApplies === "yes" || t.holdbackApplies === "unclear");

const attentionFirst = (cards: CardModel[]) => [...cards.filter((c) => c.attention), ...cards.filter((c) => !c.attention)];

function overheadFromGrids(grids: Grid[], version: Version): CardModel | null {
  const withRate = grids.filter((g) => g.overheadPct !== null);
  if (!withRate.length) return null;
  const rates = [...new Set(withRate.map((g) => g.overheadPct))];
  const first = withRate[0]!;
  const value = rates.map((r) => `${r}%`).join(", ");
  const detail = `Included in the visit totals of ${withRate.map((g) => g.arm ?? g.name).join(", ")}`;
  return { key: "overhead-grid", label: "Overhead", value, detail, evidence: gridProof(first, version), muted: false, needsDecision: false, attention: false, flags: [], termId: null, show: { target: "grid", id: first.id, row: -1, col: 0 }, text: `Overhead ${value} ${detail}` };
}

export function armCards(grids: Grid[], version: Version): CardModel[] {
  const decision = gridsNeedingDecision(version.rulebook!);
  return grids
    .filter((g) => g.grandTotalCents !== null)
    .map((g) => {
      const label = g.arm ?? g.name;
      const value = formatCents(g.grandTotalCents);
      const detail = [`Per patient`, `${g.visits.length} visit${g.visits.length === 1 ? "" : "s"}`, g.overheadPct !== null && `${g.overheadPct}% overhead`].filter(Boolean).join(" · ");
      const evidence = gridProof(g, version);
      const flags = gridFlags(version, g);
      return { key: `arm-${g.id}`, label, value, detail, evidence, muted: false, needsDecision: decision.has(g.id), attention: decision.has(g.id) || evidence === "none" || flags.length > 0, flags, termId: null, show: { target: "grid" as const, id: g.id, row: -1, col: 0 }, text: `${label} ${value} ${detail} ${g.name}` };
    });
}

const formatDate = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
};

/** When each amendment applies: its start date, and whether it reaches back over work already done. */
export function amendmentCards(version: Version): CardModel[] {
  return (version.rulebook?.study.documents ?? [])
    .filter((d) => d.role === "amendment")
    .map((d) => {
      const detail = [d.effectiveFrom ? `Applies from ${formatDate(d.effectiveFrom)}` : "Start date not stated", d.retroactive && "also applies to work already done"].filter(Boolean).join(" · ");
      return { key: `amend-${d.doc}`, label: "Amendment", value: d.doc, detail, evidence: null, muted: false, needsDecision: false, attention: !d.effectiveFrom, flags: [], termId: null, show: null, text: `Amendment ${d.doc} ${detail}` };
    });
}

export const cardMatches = (c: CardModel, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // A flag's note is searchable too: "where was that thing someone flagged?"
  const inFlags = c.flags.some((f) => f.note.toLowerCase().includes(q));
  return inFlags || (c.term ? termMatches(c.term, q) || c.label.toLowerCase().includes(q) : c.text.toLowerCase().includes(q));
};

/** Every card of the Overview, in order, filtered by the query. A card exists for every term; none is dropped or capped. */
export function buildOverview(version: Version, query = ""): Section[] {
  const rulebook = version.rulebook;
  if (!rulebook) return [];
  const { terms, grids } = rulebook;
  const decision = termsNeedingDecision(rulebook);

  const coreIds = new Set<string>();
  const core: CardModel[] = CORE.flatMap((slot) => {
    const found = terms.filter((t) => slot.categories.includes(t.category));
    found.forEach((t) => coreIds.add(t.id));
    if (found.length) return attentionFirst(found.map((t) => termCard(t, decision, termFlags(version, t.id))));
    if (slot.key === "overhead") return overheadFromGrids(grids, version) ?? noneCard(slot.key, slot.label);
    if (slot.key === "holdback") return noneCard(slot.key, slot.label, saysNoHoldback(terms) ? "The contract doesn't withhold anything" : "No holdback found");
    return noneCard(slot.key, slot.label);
  });

  const groups = GROUPS.map((g) => ({ key: g.key, title: g.title, cards: attentionFirst(terms.filter((t) => g.categories.includes(t.category) && !coreIds.has(t.id)).map((t) => termCard(t, decision, termFlags(version, t.id)))) }));
  const sections: Section[] = [{ key: "core", title: "Key rules", cards: core }, { key: "arms", title: "Per-patient totals", cards: attentionFirst(armCards(grids, version)) }, ...groups, { key: "amendments", title: "Amendments", cards: amendmentCards(version) }];
  return sections.map((s) => ({ ...s, cards: s.cards.filter((c) => cardMatches(c, query)) })).filter((s) => s.cards.length);
}

/** Proofread tallies for the checks panel: terms with at least one mark, grid cells marked, and items a reviewer flagged. */
export function proofreadCounts(version: Version) {
  const items = new Set(version.proofreads.map((p) => p.item));
  const terms = version.rulebook?.terms ?? [];
  return { terms: terms.filter((t) => items.has(t.id)).length, termsTotal: terms.length, cells: [...items].filter((i) => i.startsWith("grid:")).length, flagged: new Set(version.flags.map((f) => f.item)).size };
}
