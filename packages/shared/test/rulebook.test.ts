import { describe, expect, it } from "vitest";
import { Rulebook, RulebookVersionDto } from "../src";

const prov = { source: { documentId: "d1", page: 6 }, confidence: 0.98, method: "ai", crossCheck: "agree" } as const;
const s = <T>(value: T) => ({ value, prov });

// Tiny synthetic rulebook (two visits) shaped like the COPD work order.
const minimal = {
  schemaVersion: 1,
  study: {
    sponsor: s("Synthetic Pharma"),
    payingAgent: s(null),
    protocol: s("SYN-001"),
    siteName: s("Site A"),
    investigator: s("Dr. Test"),
    effectiveDate: s("2025-08-22"),
    currency: "USD",
  },
  documents: [{ id: "d1", kind: "work_order", title: "Work Order", date: "2025-08-22" }],
  referencedDocuments: [{ description: "Master CTA", date: "2024-04-26", present: false, prov }],
  overhead: { pct: s(40), appliesTo: s("all_per_patient_lines") },
  payment: {
    visitPayment: s("auto_edc"),
    frequency: s("monthly"),
    netDays: s(45),
    netDaysFrom: s("receipt of itemized invoice"),
    invoiceAddress: s(null),
    requiredReferences: s(["protocol number"]),
    paymentConditions: s(["eCRFs accepted"]),
  },
  budgetGrids: [
    {
      id: "g1",
      label: "Exhibit A",
      arm: null,
      statedOverheadPct: 40,
      visits: [
        { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 380100, overheadCents: 213000, nonProcedureCents: 152400, totalCents: 745500, autopay: true, prov },
        { code: "V2", name: "Week 0", order: 2, procedureSubtotalCents: 404700, overheadCents: 242500, nonProcedureCents: 201600, totalCents: 848800, autopay: true, prov },
      ],
      procedures: [{ code: "36415", name: "Blood draw", unitCents: 5500, overheadApplied: true, category: "procedure", cells: { V1: 5500, V2: 5500 }, prov }],
      perPatientTotals: [{ label: "Total", cents: 1594300, prov }],
      header: { investigator: "Dr. Test", siteName: "Site A" },
      prov,
    },
  ],
  governingGridId: null,
  invoiceables: [
    { code: "UNSCH", name: "Unscheduled visit", amountCents: 57200, amountWithOverheadCents: 80000, basis: "fixed", frequency: "per occurrence", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: true, requiredDocs: ["detailed invoice"], prov },
  ],
  screenFail: { amountCents: 745500, basis: "fixed", cap: { kind: "blocks_with_reauth", n: 7, ratio: null }, paidVia: "invoice", requiredDocs: ["eCRFs", "detailed invoice"], prov },
  siteFees: [{ code: "SC003", name: "Administrative fee", amountCents: 1200000, trigger: "study_initiation", dueDays: 45, prov }],
  holdback: null,
  deadlines: [{ kind: "invoice_months_after_study_close", value: 6, consequence: "may not be approved", prov }],
  overpayment: null,
  rounding: s("printed_amounts"),
  appliesFrom: s(null),
};

describe("Rulebook schema", () => {
  it("accepts a valid rulebook", () => {
    expect(Rulebook.safeParse(minimal).success).toBe(true);
  });

  it("rejects float money", () => {
    const bad = structuredClone(minimal);
    bad.siteFees[0]!.amountCents = 1200000.5;
    expect(Rulebook.safeParse(bad).success).toBe(false);
  });

  it("has no field for bank details", () => {
    expect(JSON.stringify(Rulebook.toJSONSchema())).not.toMatch(/routing|account ?number|bank/i);
  });
});

describe("RulebookVersionDto: blind entry", () => {
  const question = (path: string) => ({
    id: `q:${path}`, kind: "confirm_value", reason: "VALUE_CONFLICT", path, question: "What amount is printed?", input: "money", options: [], where: [],
    blocking: true, answer: null, outcome: null, compare: null, sentBack: null,
  });
  const dto = (rulebook: unknown, status: string, review: unknown[]) => ({
    version: 1, status, createdAt: "2026-01-01T00:00:00Z", signedBy: null, signedAt: null, appliesFrom: null, studyId: "s1", rulebook, anomalies: [], editors: [],
    cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, evidence: [], review, pdfCheck: null, byHand: false, proofread: [],
  });
  const withheld = () => {
    const rb = structuredClone(minimal) as unknown as Rulebook;
    (rb.budgetGrids[0]!.visits[0] as { totalCents: unknown }).totalCents = null;
    return rb;
  };
  const path = "/budgetGrids/0/visits/0/totalCents";

  it("takes null at an open question's path on a draft, and nowhere else", () => {
    expect(RulebookVersionDto.safeParse(dto(withheld(), "draft", [question(path)])).success).toBe(true);
    expect(RulebookVersionDto.safeParse(dto(withheld(), "draft", [])).success).toBe(false);
    expect(RulebookVersionDto.safeParse(dto(withheld(), "draft", [{ ...question(path), outcome: "matched" }])).success).toBe(false);
    expect(RulebookVersionDto.safeParse(dto(withheld(), "signed", [question(path)])).success).toBe(false);
  });

  it("still rejects a wrong value at a withheld path, and anything else invalid", () => {
    const rb = structuredClone(minimal) as unknown as Rulebook;
    (rb.budgetGrids[0]!.visits[0] as { totalCents: unknown }).totalCents = 12.5;
    expect(RulebookVersionDto.safeParse(dto(rb, "draft", [question(path)])).success).toBe(false);
    const other = withheld();
    (other.study.sponsor as { value: unknown }).value = null;
    expect(RulebookVersionDto.safeParse(dto(other, "draft", [question(path)])).success).toBe(false);
    expect(RulebookVersionDto.safeParse(dto(minimal, "draft", [])).success).toBe(true);
  });
});
