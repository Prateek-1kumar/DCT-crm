import type { Rulebook } from "@dct/shared";
import { expect, test } from "vitest";
import { unsupportedBilling } from "../src/checks/billing";
import type { LoadedDoc } from "../src/types";

const text = "Site costs marked * are paid upon receipt of a payment request.";
const docs = [{ name: "cta.pdf", pages: [{ page: 1, kind: "text", raw: text, layout: text }] }] as unknown as LoadedDoc[];
const term = (id: string, over: object) => ({
  id, category: "site_fee", name: id, amountCents: 50000, unit: "one time", billing: "invoice", trigger: null, cap: null, formula: null, conditions: null,
  holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, source: { doc: "cta.pdf", page: 1, quote: "Site costs" }, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});
const book = (terms: object[]) => ({ terms, grids: [], questions: [], accounted: [] }) as unknown as Rulebook;

test("a fee's billing is kept only when its words are on the page", () => {
  const { rulebook, reset } = unsupportedBilling(
    book([
      term("backed", { billingBasis: { page: 1, quote: "paid upon receipt of a payment request" } }),
      term("no words", {}),
      term("words not on the page", { billingBasis: { page: 1, quote: "invoiced monthly in arrears" } }),
      term("a person said so", { evidence: "person" }),
      term("not a fee", { category: "payment_terms", billing: "auto_paid" }),
    ]),
    docs,
  );
  expect(rulebook.terms.map((t) => t.billing)).toEqual(["invoice", "unknown", "unknown", "invoice", "auto_paid"]);
  expect(reset).toEqual(["no words", "words not on the page"]);
});
