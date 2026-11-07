import type { Grid, Question, Term } from "@dct/shared";
import { describe, expect, it } from "vitest";
import { question, rulebook, term, version } from "./fixtures";
import { keyTerms } from "./key-terms";

const grid = (id: string, grandTotalCents: number | null): Grid => ({
  id,
  name: `Grid ${id}`,
  arm: `Arm ${id}`,
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
  cellsReadTwice: [],
  acceptedAsPrinted: false,
});

const keys = (terms: Term[], grids: Grid[] = [], questions: Question[] = []) => keyTerms(version({ rulebook: rulebook({ terms, grids, questions }) })).map((k) => k.id);

const core = [
  term("pay", { category: "payment_terms", name: "Payment terms", formula: "Net 45 days" }),
  term("hold", { category: "holdback", name: "Holdback", formula: "10% held back" }),
  term("oh", { category: "overhead", name: "Overhead", formula: "25% added" }),
  term("sf", { category: "screen_failure", name: "Screen failures", amountCents: 15000, unit: "per patient" }),
  term("unsched", { category: "unscheduled_visit", name: "Unscheduled visit", amountCents: 20000 }),
  term("inv", { category: "invoicing", name: "Invoice terms", deadline: "30 days of the visit" }),
];
const fees = [
  term("fee1", { category: "site_fee", amountCents: 500000 }),
  term("fee2", { category: "site_fee", amountCents: 250000 }),
  term("fee3", { category: "site_fee", amountCents: 10000 }),
  term("fee4", { category: "site_fee", amountCents: 120000 }),
];

describe("keyTerms", () => {
  it("puts the core money rules first, then per-patient totals, then the three largest site fees", () => {
    expect(keys([...fees, ...core], [grid("g1", 1234500), grid("g2", null)])).toEqual(["pay", "hold", "oh", "sf", "unsched", "inv", "g1", "fee1", "fee2", "fee4"]);
  });

  it("then adds terms with an open question, then an answered one, then unproven ones; plain quoted terms are left out", () => {
    const extra = [
      term("proven", { amountCents: 1 }),
      term("weak", { evidence: "none" }),
      term("answered", { amountCents: 2 }),
      term("open", { amountCents: 3, evidence: "math" }),
    ];
    const qs = [question("q1", { about: { target: "term", id: "answered" }, state: "answered" }), question("q2", { about: { target: "term", id: "open" }, blocking: false })];
    expect(keys([...core, ...extra], [grid("g1", 100)], qs)).toEqual(["pay", "hold", "oh", "sf", "unsched", "inv", "g1", "open", "answered", "weak"]);
  });

  it("never offers more than 12, and the core rules come first when it cuts", () => {
    const many = Array.from({ length: 20 }, (_, i) => term(`w${i}`, { evidence: "none" }));
    const out = keys([...core, ...many], Array.from({ length: 10 }, (_, i) => grid(`g${i}`, 100)));
    expect(out).toHaveLength(12);
    expect(out.slice(0, 6)).toEqual(["pay", "hold", "oh", "sf", "unsched", "inv"]);
  });

  it("tops a short list up to 8 from the biggest remaining terms, and offers all of a small rulebook", () => {
    const plain = Array.from({ length: 12 }, (_, i) => term(`p${i}`, { amountCents: (i + 1) * 100 }));
    expect(keys([core[0]!, ...plain])).toEqual(["pay", "p11", "p10", "p9", "p8", "p7", "p6", "p5"]);
    expect(keys([core[0]!, plain[0]!])).toEqual(["pay", "p0"]);
    expect(keys([])).toEqual([]);
  });

  it("describes each in plain words, with where it came from", () => {
    const byId = Object.fromEntries(keyTerms(version({ rulebook: rulebook({ terms: core, grids: [grid("g1", 1234500)] }) })).map((k) => [k.id, k]));
    expect(byId.pay!.card.value).toBe("Net 45 days");
    expect(byId.sf!.card.value).toBe("$150.00 per patient");
    expect(byId.g1).toMatchObject({ title: "Arm g1: total per patient", doc: "Contract.pdf", page: 5, ref: { target: "grid", id: "g1" } });
    expect(byId.g1!.card.value).toBe("$12,345.00");
    expect(byId.pay).toMatchObject({ quote: "quote", page: 2, ref: { target: "term", id: "pay" } });
  });
});
