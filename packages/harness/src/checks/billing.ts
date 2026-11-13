import type { Rulebook } from "@dct/shared";
import type { LoadedDoc } from "../types";
import { checkQuote } from "./quote";
import { PAYABLE } from "./required";

/**
 * A payable item's billing ("invoice" or "auto_paid") stands only on words of the contract that are really on the page.
 * Two reads of one contract marked the same unmarked fees "invoice" in one and "unknown" in the other: the first settled
 * silently what the second asked. Without its words the billing goes back to "unknown", which the grouped question asks.
 * ponytail: the words are checked for being on the page, not for being about this item; the second reader's step on
 * unstated choices is what catches a quote that doesn't cover the fee.
 */
export function unsupportedBilling(rulebook: Rulebook, docs: LoadedDoc[]): { rulebook: Rulebook; reset: string[] } {
  const reset: string[] = [];
  const terms = rulebook.terms.map((t) => {
    // a person's answer or a saved house rule is its own ground
    if (!PAYABLE.has(t.category) || t.billing === "unknown" || t.evidence === "person" || t.evidence === "house_rule" || t.houseRuleIds.length) return t;
    const b = t.billingBasis;
    if (b?.quote.trim() && !checkQuote({ doc: b.doc ?? t.source.doc, page: b.page, quote: b.quote }, docs)) return t;
    reset.push(t.name);
    return { ...t, billing: "unknown" as const, billingBasis: null };
  });
  return { rulebook: { ...rulebook, terms }, reset };
}
