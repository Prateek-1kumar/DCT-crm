import type { Term } from "@dct/shared";
import type { Version } from "@/lib/types";
import { armCards, CORE, termCard, type CardModel } from "../overview/model";
import { termsNeedingDecision, type ShowRef } from "../rulebook/model";

export interface KeyTerm {
  /** What the approval records as ticked: a term's id, or a grid's id for its per-patient total. */
  id: string;
  title: string;
  /** Value, detail and proof badge, built the same way as the Overview's cards so the two never disagree. */
  card: CardModel;
  /** Why this one is on the list, in words for the person ticking it. */
  why: string;
  quote: string | null;
  doc: string;
  page: number;
  ref: ShowRef;
}

export const MIN_KEY_TERMS = 8;
export const MAX_KEY_TERMS = 12;

const byAmount = (a: Term, b: Term) => (b.amountCents ?? -1) - (a.amountCents ?? -1);

/**
 * What an approver ticks to say "I checked this against the contract". In order: the core money rules, then the
 * per-patient totals and the largest site fees, then terms a question was asked about or that no quote or arithmetic
 * proves; topped up to 8 from the biggest remaining terms, never more than 12.
 */
export function keyTerms(version: Version): KeyTerm[] {
  const rb = version.rulebook;
  if (!rb) return [];
  const decision = termsNeedingDecision(rb);
  const out = new Map<string, KeyTerm>();

  const addTerm = (t: Term, why: string) => {
    if (out.has(t.id)) return;
    out.set(t.id, { id: t.id, title: t.name, card: termCard(t, decision), why, quote: t.source.quote || null, doc: t.source.doc, page: t.source.page, ref: { target: "term", id: t.id } });
  };

  for (const slot of CORE)
    rb.terms
      .filter((t) => slot.categories.includes(t.category))
      .slice(0, slot.key === "invoice_deadlines" ? 2 : 1)
      .forEach((t) => addTerm(t, "A core money rule"));

  for (const g of rb.grids) {
    const card = armCards([g], version)[0];
    if (card) out.set(g.id, { id: g.id, title: `${g.arm ?? g.name}: total per patient`, card, why: "What each patient is paid", quote: null, doc: g.doc, page: g.pages[0] ?? 1, ref: { target: "grid", id: g.id, row: -1, col: 0 } });
  }

  rb.terms
    .filter((t) => t.category === "site_fee")
    .sort(byAmount)
    .slice(0, 3)
    .forEach((t) => addTerm(t, "One of the largest site fees"));

  // open = 0, answered = 1: a rule a person had to settle is worth a second look before approving.
  const asked = new Map<string, number>();
  for (const q of rb.questions) {
    if (q.about?.target !== "term" || (q.state !== "open" && q.state !== "answered")) continue;
    asked.set(q.about.id, Math.min(asked.get(q.about.id) ?? 1, q.state === "open" ? 0 : 1));
  }
  const unproven = (t: Term) => t.evidence !== "math" && t.evidence !== "quote";
  rb.terms
    .filter((t) => asked.has(t.id) || unproven(t))
    .sort((a, b) => (asked.get(a.id) ?? 2) - (asked.get(b.id) ?? 2))
    .forEach((t) => addTerm(t, asked.get(t.id) === 0 ? "A question about it is open" : asked.has(t.id) ? "A question about it was answered" : "Not proven by the contract's words or arithmetic"));

  // A small rulebook still gets a full list to tick: top up with the biggest of what is left.
  if (out.size < MIN_KEY_TERMS) [...rb.terms].sort(byAmount).forEach((t) => out.size < MIN_KEY_TERMS && addTerm(t, "One of the biggest amounts"));

  return [...out.values()].slice(0, MAX_KEY_TERMS);
}
