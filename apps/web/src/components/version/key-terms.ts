import type { Rulebook, Term, TermCategory } from "@dct/shared";
import { formatCents } from "@/lib/money";

export interface KeyTerm {
  id: string;
  label: string;
  value: string;
  doc: string;
  page: number;
}

const MAX = 12;

const value = (t: Term) =>
  t.amountCents !== null ? `${formatCents(t.amountCents)}${t.unit ? ` ${t.unit}` : ""}` : (t.formula ?? t.deadline ?? t.conditions ?? t.trigger ?? t.notes ?? "See the contract");

const fromTerm = (t: Term): KeyTerm => ({ id: t.id, label: t.name, value: value(t), doc: t.source.doc, page: t.source.page });

/** What an approver ticks to say "I checked this against the contract": the terms that move the most money or the most dates. */
export function keyTerms(rb: Rulebook): KeyTerm[] {
  const of = (...cats: TermCategory[]) => rb.terms.filter((t) => cats.includes(t.category));
  const terms = [
    ...of("payment_terms").slice(0, 1),
    ...of("holdback").slice(0, 1),
    ...of("overhead").slice(0, 1),
    ...of("screen_failure").slice(0, 1),
    ...of("invoicing", "deadline").slice(0, 2),
    ...of("site_fee")
      .sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0))
      .slice(0, 3),
  ].map(fromTerm);
  const totals = rb.grids.flatMap((g) =>
    g.grandTotalCents === null ? [] : [{ id: g.id, label: `${g.name}${g.arm ? ` (${g.arm})` : ""}: total per patient`, value: formatCents(g.grandTotalCents), doc: g.doc, page: g.pages[0]! }],
  );
  const amendments = rb.study.documents
    .filter((d) => d.role === "amendment")
    .map((d) => ({ id: `amendment:${d.doc}`, label: `${d.doc}: effective date`, value: d.effectiveFrom ?? "No date stated", doc: d.doc, page: 1 }));
  return [...terms, ...totals, ...amendments].slice(0, MAX);
}
