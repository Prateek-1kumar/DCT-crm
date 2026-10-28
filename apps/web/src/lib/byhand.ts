import type { BudgetGrid, Provenance, Rulebook } from "@dct/shared";

/** Blank pieces for typing a contract in by hand. Numbers start null (or 0 where the schema needs one) and show as empty inputs. */

export const MANUAL: Provenance = { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" };
const m = <T,>(value: T) => ({ value, prov: MANUAL });

export const blankVisit = (code: string, order: number): BudgetGrid["visits"][number] => ({
  code, name: "", order, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: MANUAL,
});
export const blankProcedure = (): BudgetGrid["procedures"][number] => ({
  code: null, name: "", unitCents: null, overheadApplied: false, category: "procedure", cells: {}, prov: MANUAL,
});
export const blankInvoiceable = (): Rulebook["invoiceables"][number] => ({
  code: null, name: "", amountCents: null, amountWithOverheadCents: null, basis: "fixed", frequency: "", cap: { kind: "none", n: null, ratio: null },
  requiresPreApproval: false, requiredDocs: [], prov: MANUAL,
});
export const blankSiteFee = (): Rulebook["siteFees"][number] => ({ code: null, name: "", amountCents: null, trigger: "one_time", dueDays: null, prov: MANUAL });
export const blankScreenFail = (): NonNullable<Rulebook["screenFail"]> => ({
  amountCents: null, basis: "fixed", cap: { kind: "none", n: null, ratio: null }, paidVia: "invoice", requiredDocs: [], prov: MANUAL,
});
export const blankHoldback = (): NonNullable<Rulebook["holdback"]> => ({ pct: 0, appliesTo: "", releaseConditions: [], prov: MANUAL });

/** Next free visit code: V1, V2, … */
export const nextVisitCode = (g: BudgetGrid) => `V${Math.max(0, ...g.visits.map((v) => Number(/^V(\d+)$/.exec(v.code)?.[1] ?? 0))) + 1}`;

/** A blank invoicing master with one empty budget grid. The study details come from the confirmed upload. */
export function blankRulebook(
  docs: Rulebook["documents"],
  info: { sponsor: string; protocol: string; site: string; pi: string },
): Rulebook {
  return {
    schemaVersion: 1,
    study: { sponsor: m(info.sponsor), payingAgent: m(null), protocol: m(info.protocol), siteName: m(info.site), investigator: m(info.pi), effectiveDate: m(null), currency: "USD" },
    documents: docs,
    referencedDocuments: [],
    overhead: { pct: m(null), appliesTo: m("unspecified" as const) },
    payment: {
      visitPayment: m("unspecified" as const), frequency: m("unspecified" as const), netDays: m(null), netDaysFrom: m(null), invoiceAddress: m(null),
      requiredReferences: m([]), paymentConditions: m([]),
    },
    budgetGrids: [
      { id: "g-hand", label: "Budget", arm: null, statedOverheadPct: null, visits: [blankVisit("V1", 1)], procedures: [blankProcedure()], perPatientTotals: [], header: { investigator: null, siteName: null }, prov: MANUAL },
    ],
    governingGridId: null,
    invoiceables: [],
    screenFail: null,
    siteFees: [],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: m("unspecified" as const),
    appliesFrom: m(null),
  };
}
