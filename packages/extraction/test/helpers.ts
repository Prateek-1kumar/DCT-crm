import { Rulebook } from "@dct/shared";

export const prov = { source: { documentId: "d1", page: 3 }, confidence: 0.95, method: "ai", crossCheck: "not_checked" } as const;
const s = <T>(value: T) => ({ value, prov: { ...prov } });

/** Small synthetic rulebook (one arm, two visits) that passes every check. */
export function makeRulebook(): Rulebook {
  return Rulebook.parse({
    schemaVersion: 1,
    study: {
      sponsor: s("Acme Bio"),
      payingAgent: s(null),
      protocol: s("ACM-100"),
      siteName: s("Test Site Research, LLC"),
      investigator: s("Jane Q. Doe, M.D."),
      effectiveDate: s("2025-01-01"),
      currency: "USD",
    },
    documents: [{ id: "d1", kind: "work_order", title: "Work Order", date: "2025-01-01" }],
    referencedDocuments: [],
    overhead: { pct: s(40), appliesTo: s("all_per_patient_lines") },
    payment: {
      visitPayment: s("auto_edc"),
      frequency: s("monthly"),
      netDays: s(45),
      netDaysFrom: s("receipt of invoice"),
      invoiceAddress: s(null),
      requiredReferences: s(["protocol number"]),
      paymentConditions: s([]),
    },
    budgetGrids: [
      {
        id: "g1",
        label: "Exhibit A",
        arm: null,
        statedOverheadPct: 40,
        visits: [
          // 300 + 200 procedures, 100 non-procedure; 40% of 600 = 240 → 840
          { code: "V1", name: "Screening", order: 1, procedureSubtotalCents: 50000, overheadCents: 24000, nonProcedureCents: 10000, totalCents: 84000, autopay: true, prov },
          { code: "V2", name: "Week 2", order: 2, procedureSubtotalCents: 30000, overheadCents: 16000, nonProcedureCents: 10000, totalCents: 56000, autopay: true, prov },
        ],
        procedures: [
          { code: "99205", name: "Physical exam", unitCents: 30000, overheadApplied: true, category: "procedure", cells: { V1: 30000, V2: 30000 }, prov },
          { code: "36415", name: "Blood draw", unitCents: 20000, overheadApplied: true, category: "procedure", cells: { V1: 20000 }, prov },
          { code: "VA", name: "Visual acuity", unitCents: 5500, overheadApplied: false, category: "procedure", cells: { V2: "invoiceable" }, prov },
          { code: "NP008", name: "Patient stipend", unitCents: 10000, overheadApplied: true, category: "non_procedure", cells: { V1: 10000, V2: 10000 }, prov },
        ],
        perPatientTotals: [{ label: "Total", cents: 140000, prov }],
        header: { investigator: "Jane Doe", siteName: "Test Site Research" },
        prov,
      },
    ],
    governingGridId: null,
    invoiceables: [
      { code: "VA", name: "Visual acuity", amountCents: 5500, amountWithOverheadCents: null, basis: "fixed", frequency: "per occurrence", cap: { kind: "none", n: null, ratio: null }, requiresPreApproval: false, requiredDocs: [], prov },
    ],
    screenFail: { amountCents: 84000, basis: "fixed", cap: { kind: "blocks_with_reauth", n: 7, ratio: null }, paidVia: "invoice", requiredDocs: [], prov },
    siteFees: [{ code: "SC003", name: "Administrative fee", amountCents: 1200000, trigger: "study_initiation", dueDays: 45, prov }],
    holdback: null,
    deadlines: [{ kind: "invoice_months_after_study_close", value: 6, consequence: "may not be approved", prov }],
    overpayment: null,
    rounding: s("printed_amounts"),
    appliesFrom: s(null),
  });
}
