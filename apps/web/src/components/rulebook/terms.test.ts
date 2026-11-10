import type { Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { termAmount, termValue } from "./terms";

const term = (over: Partial<Term> = {}): Term => ({
  id: "t1",
  category: "site_fee",
  name: "Startup fee",
  amountCents: null,
  unit: null,
  billing: "auto_paid",
  trigger: null,
  cap: null,
  formula: null,
  conditions: null,
  holdbackApplies: "n/a",
  overheadApplies: "n/a",
  deadline: null,
  source: { doc: "CTA.pdf", page: 1, quote: "" },
  evidence: "quote",
  houseRuleIds: [],
  notes: null,
  ...over,
});

describe("termValue", () => {
  it("says the amount with its unit and how it is billed", () => {
    expect(termValue(term({ amountCents: 500000, unit: "one time", billing: "invoice" }))).toBe("$5,000.00 one time · invoiced");
  });

  it("says nothing about billing when it is paid without an invoice", () => {
    expect(termValue(term({ amountCents: 8500, unit: "per hour" }))).toBe("$85.00 per hour");
  });

  it("adds the cap in plain words", () => {
    const cap = (kind: "hours" | "amount" | "count" | "ratio", value: number | null, period: string | null = null, text = "") => term({ amountCents: 8500, unit: "per hour", cap: { kind, value, period, text } });
    expect(termValue(cap("hours", 10))).toBe("$85.00 per hour · capped at 10 hours");
    expect(termValue(cap("amount", 250000, "patient"))).toBe("$85.00 per hour · capped at $2,500.00 per patient");
    expect(termValue(cap("count", 3, "per year"))).toBe("$85.00 per hour · capped at 3 per year");
    expect(termValue(cap("ratio", 3))).toBe("$85.00 per hour · capped at 3:1");
    expect(termValue(cap("count", null, null, "Up to the sponsor's approved visits"))).toBe("$85.00 per hour · Up to the sponsor's approved visits");
  });

  it("ignores a cap of none", () => {
    expect(termValue(term({ amountCents: 100, cap: { kind: "none", value: null, period: null, text: "No limit" } }))).toBe("$1.00");
  });

  it("prefers a formula to an amount", () => {
    expect(termValue(term({ amountCents: 100, formula: "100% of Visit 1 + 75% of Visit 2" }))).toBe("100% of Visit 1 + 75% of Visit 2");
  });

  it("flags billing that isn't settled", () => {
    expect(termValue(term({ amountCents: 20000, unit: "per visit", billing: "unknown" }))).toBe("$200.00 per visit · how it's paid isn't settled yet");
  });

  it("still says something for a term with no amount", () => {
    expect(termValue(term())).toBe("No amount stated");
    expect(termAmount(term())).toBe("");
  });
});
