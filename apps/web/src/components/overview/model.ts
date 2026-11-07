import type { Evidence, Grid, Term } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { Version } from "@/lib/types";
import { gridProof, gridsNeedingDecision, needsAttention, termDetail, termMatches, termsNeedingDecision, type ShowRef } from "../rulebook/model";
import { CATEGORY_LABEL, termMoney } from "../rulebook/terms";

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

export function termCard(t: Term, decision: Set<string>): CardModel {
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
    attention: needsAttention(t, decision),
    termId: t.id,
    show: { target: "term", id: t.id },
    text: "",
    term: t,
  };
}

function noneCard(key: string, label: string, detail = ""): CardModel {
  return { key: `none-${key}`, label, value: NONE_FOUND, detail, evidence: null, muted: true, needsDecision: false, attention: false, termId: null, show: null, text: `${label} ${NONE_FOUND} ${detail}` };
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
  return { key: "overhead-grid", label: "Overhead", value, detail, evidence: gridProof(first, version), muted: false, needsDecision: false, attention: false, termId: null, show: { target: "grid", id: first.id, row: -1, col: 0 }, text: `Overhead ${value} ${detail}` };
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
      return { key: `arm-${g.id}`, label, value, detail, evidence, muted: false, needsDecision: decision.has(g.id), attention: decision.has(g.id) || evidence === "none", termId: null, show: { target: "grid" as const, id: g.id, row: -1, col: 0 }, text: `${label} ${value} ${detail} ${g.name}` };
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
      return { key: `amend-${d.doc}`, label: "Amendment", value: d.doc, detail, evidence: null, muted: false, needsDecision: false, attention: !d.effectiveFrom, termId: null, show: null, text: `Amendment ${d.doc} ${detail}` };
    });
}

export const cardMatches = (c: CardModel, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return c.term ? termMatches(c.term, q) || c.label.toLowerCase().includes(q) : c.text.toLowerCase().includes(q);
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
    if (found.length) return attentionFirst(found.map((t) => termCard(t, decision)));
    if (slot.key === "overhead") return overheadFromGrids(grids, version) ?? noneCard(slot.key, slot.label);
    if (slot.key === "holdback") return noneCard(slot.key, slot.label, saysNoHoldback(terms) ? "The contract doesn't withhold anything" : "No holdback found");
    return noneCard(slot.key, slot.label);
  });

  const groups = GROUPS.map((g) => ({ key: g.key, title: g.title, cards: attentionFirst(terms.filter((t) => g.categories.includes(t.category) && !coreIds.has(t.id)).map((t) => termCard(t, decision))) }));
  const sections: Section[] = [{ key: "core", title: "Key rules", cards: core }, { key: "arms", title: "Per-patient totals", cards: armCards(grids, version) }, ...groups, { key: "amendments", title: "Amendments", cards: amendmentCards(version) }];
  return sections.map((s) => ({ ...s, cards: s.cards.filter((c) => cardMatches(c, query)) })).filter((s) => s.cards.length);
}

/** Proofread tallies for the checks panel: terms with at least one mark, and grid cells marked. */
export function proofreadCounts(version: Version) {
  const items = new Set(version.proofreads.map((p) => p.item));
  const terms = version.rulebook?.terms ?? [];
  return { terms: terms.filter((t) => items.has(t.id)).length, termsTotal: terms.length, cells: [...items].filter((i) => i.startsWith("grid:")).length };
}
