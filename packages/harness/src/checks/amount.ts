import type { Rulebook, TermCategory } from "@dct/shared";
import type { Problem } from "../types";
import { amountsIn, usd } from "./text";

type Term = Rulebook["terms"][number];
type Grid = Rulebook["grids"][number];

/** What the compile agent is told to do about it; a person is told something they can do instead. */
export const PER_UNIT_FIX = " Make the amount the payment for one, and keep the total as the cap.";

// "per visit", "each", "per screen failure": the amount is then what one of them pays. "total budget" and "one time" are not.
const PER_UNIT = /^\s*(?:per|each|every)\b/i;
// One of these can never pay more than a patient's whole budget, whatever the contract.
const ONE_EVENT = new Set<TermCategory>(["screen_failure", "unscheduled_visit"]);

function perPatientTotal(g: Grid): number | null {
  if (g.grandTotalCents !== null) return g.grandTotalCents;
  // a total row with a word in it would add up to less than the patient's budget, and flag an honest fee
  if (!g.total?.length || !g.total.every((c) => typeof c === "number")) return null;
  return g.total.reduce<number>((sum, c) => sum + (c as number), 0);
}

/**
 * A per-unit term whose amount is its line's total: the budget printed "$500.00 × 12 = $6,000.00" and the $6,000.00 went in
 * as the amount per one. Billing multiplies the amount by what happened, so this overpays by the whole count.
 * ponytail: two shapes that are near certain, not every way a total can be mistaken for a rate. A total stored with no
 * per-unit figure in the term's own words and no grid total to compare with still passes, and so does an amount equal to
 * its own amount cap ("up to $120.00 per night" is that shape and is right). Widen when a read shows one.
 */
export function lineTotalAsAmount(rulebook: Rulebook): Problem[] {
  const patient = Math.max(0, ...rulebook.grids.map((g) => perPatientTotal(g) ?? 0));
  return rulebook.terms.flatMap((t): Problem[] => {
    const amount = t.amountCents;
    // a person's answer stands: they have seen the amount and its unit
    if (amount === null || amount <= 0 || t.evidence === "person" || !t.unit || !PER_UNIT.test(t.unit)) return [];
    const said = `'${t.name}' has ${usd(amount)} as its amount ${t.unit.trim()}`;
    const problem = (why: string): Problem[] => [{ check: "amount", id: t.id, doc: t.source.doc, page: t.source.page, message: `${said}, but ${why}${PER_UNIT_FIX}` }];
    const figures = [t.formula, t.conditions, t.notes, t.trigger, t.cap?.text].flatMap((s) => (s ? amountsIn(s) : [])).filter((f) => f > 0 && f < amount);

    const count = t.cap?.kind === "count" ? t.cap.value : null;
    const each = count !== null && Number.isInteger(count) && count > 1 ? figures.find((f) => f * count === amount) : undefined;
    if (each !== undefined) return problem(`its own wording gives ${usd(each)} for each, up to ${count}, and ${count} × ${usd(each)} is ${usd(amount)}: that is the most the line can pay in total, not the payment for one.`);

    if (patient > 0 && ONE_EVENT.has(t.category) && amount > patient) return problem(`a patient's whole budget comes to ${usd(patient)}: it looks like the line's total, not the payment for one.`);
    return [];
  });
}
