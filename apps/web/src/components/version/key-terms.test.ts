import type { Grid } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { rulebook, term } from "./fixtures";
import { keyTerms } from "./key-terms";

const grid = (id: string, grandTotalCents: number | null): Grid => ({
  id,
  name: `Grid ${id}`,
  arm: "Arm A",
  doc: "Contract.pdf",
  pages: [5, 6],
  visits: ["V1"],
  overheadPct: null,
  rows: [],
  subtotal: null,
  overhead: null,
  additions: [],
  total: null,
  grandTotalCents,
  cellsReadTwice: [], acceptedAsPrinted: false,
});

describe("keyTerms", () => {
  const rb = rulebook({
    study: {
      protocol: "P",
      sponsor: "S",
      payer: null,
      siteEntity: "E",
      siteNumber: null,
      pi: null,
      effectiveDate: null,
      documents: [
        { doc: "Contract.pdf", role: "cta", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null },
        { doc: "Amendment 1.pdf", role: "amendment", hasMoney: true, supersedes: [], effectiveFrom: "March 1, 2026", retroactive: false, notes: null },
      ],
    },
    terms: [
      term("pay", { category: "payment_terms", name: "Payment terms", formula: "Net 45 days" }),
      term("hold", { category: "holdback", name: "Holdback", formula: "10% held back" }),
      term("oh", { category: "overhead", name: "Overhead", formula: "25% added" }),
      term("sf", { category: "screen_failure", name: "Screen failures", amountCents: 15000, unit: "per patient" }),
      term("dl", { category: "deadline", name: "Invoice within", deadline: "30 days of the visit" }),
      term("fee1", { category: "site_fee", name: "Startup fee", amountCents: 500000 }),
      term("fee2", { category: "site_fee", name: "Closeout fee", amountCents: 250000 }),
      term("fee3", { category: "site_fee", name: "Archive fee", amountCents: 10000 }),
      term("fee4", { category: "site_fee", name: "Pharmacy fee", amountCents: 120000 }),
      term("visit", { category: "invoiceable", name: "Visit", amountCents: 9900 }),
    ],
    grids: [grid("g1", 1234500), grid("g2", null)],
  });

  it("picks the named terms, the 3 largest site fees, grid totals and amendment dates", () => {
    const k = keyTerms(rb);
    expect(k.map((x) => x.id)).toEqual(["pay", "hold", "oh", "sf", "dl", "fee1", "fee2", "fee4", "g1", "amendment:Amendment 1.pdf"]);
  });

  it("says each value in plain words and where to find it", () => {
    const byId = Object.fromEntries(keyTerms(rb).map((x) => [x.id, x]));
    expect(byId.pay!.value).toBe("Net 45 days");
    expect(byId.sf!.value).toBe("$150.00 per patient");
    expect(byId.g1).toMatchObject({ value: "$12,345.00", doc: "Contract.pdf", page: 5 });
    expect(byId["amendment:Amendment 1.pdf"]).toMatchObject({ value: "March 1, 2026", page: 1 });
  });

  it("never offers more than 12", () => {
    const many = rulebook({ ...rb, grids: Array.from({ length: 20 }, (_, i) => grid(`g${i}`, 100)) });
    expect(keyTerms(many)).toHaveLength(12);
  });
});
