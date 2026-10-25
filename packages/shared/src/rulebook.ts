import { z } from "zod";

/** Money is always integer cents. Never floats. */
export const Cents = z.number().int();
export type Cents = z.infer<typeof Cents>;

/** Where a value came from in the contract. */
export const SourceRef = z.object({
  documentId: z.string(),
  page: z.number().int().positive(),
  /** Human-readable pointer, e.g. "Exhibit A §3" or "grid row 'Blood draw', column V2". */
  location: z.string().optional(),
  /** Short exact phrase from the contract, for rules (caps, deadlines). */
  quote: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Provenance = z.object({
  source: SourceRef.nullable(),
  confidence: z.number().min(0).max(1),
  method: z.enum(["ai", "manual", "derived"]),
  /** Result of the second, independent AI read. */
  crossCheck: z.enum(["agree", "disagree", "not_checked"]),
  /** Term depends on a document we don't have (e.g. missing master agreement). */
  unverified: z.boolean().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** A single extracted value with its provenance. */
export const sourced = <T extends z.ZodTypeAny>(value: T) => z.object({ value, prov: Provenance });

export const DocumentKind = z.enum(["master_agreement", "work_order", "adoption", "amendment", "budget", "other"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const StudyInfo = z.object({
  sponsor: sourced(z.string()),
  /** CRO or payment agent, if any (PPD, IQVIA, Synteract). */
  payingAgent: sourced(z.string().nullable()),
  protocol: sourced(z.string()),
  siteName: sourced(z.string()),
  investigator: sourced(z.string()),
  /** ISO date, YYYY-MM-DD. */
  effectiveDate: sourced(z.string().nullable()),
  currency: z.literal("USD"),
});

export const RulebookDocument = z.object({
  id: z.string(),
  kind: DocumentKind,
  title: z.string(),
  date: z.string().nullable(),
});

/** A document the contract refers to (e.g. "Master CTA dated 26-Apr-2024"). */
export const ReferencedDocument = z.object({
  description: z.string(),
  date: z.string().nullable(),
  present: z.boolean(),
  prov: Provenance,
});

export const OverheadAppliesTo = z.enum(["procedures_only", "procedures_and_staff", "all_per_patient_lines", "none", "unspecified"]);

export const Overhead = z.object({
  pct: sourced(z.number().nullable()),
  appliesTo: sourced(OverheadAppliesTo),
});

export const Payment = z.object({
  visitPayment: sourced(z.enum(["auto_edc", "invoice", "mixed", "unspecified"])),
  frequency: sourced(z.enum(["monthly", "quarterly", "other", "unspecified"])),
  /** Days to pay an invoice. Null when not stated. */
  netDays: sourced(z.number().int().nullable()),
  /** What starts the net-days clock, e.g. "receipt of itemized invoice". */
  netDaysFrom: sourced(z.string().nullable()),
  invoiceAddress: sourced(z.string().nullable()),
  /** What every invoice must reference, e.g. ["protocol number", "PI name", "site number"]. */
  requiredReferences: sourced(z.array(z.string())),
  /** Pay only after eCRFs complete / all queries resolved, etc. */
  paymentConditions: sourced(z.array(z.string())),
});

/** Cell value in the procedure × visit grid: price in cents, or "invoiceable" (billed separately). */
export const GridCell = z.union([Cents, z.literal("invoiceable")]);

export const GridVisit = z.object({
  code: z.string(),
  name: z.string(),
  order: z.number().int(),
  procedureSubtotalCents: Cents.nullable(),
  overheadCents: Cents.nullable(),
  nonProcedureCents: Cents.nullable(),
  /** Printed total for the visit, as billed. */
  totalCents: Cents,
  autopay: z.boolean(),
  prov: Provenance,
});

export const GridProcedure = z.object({
  code: z.string().nullable(),
  name: z.string(),
  /** Unit price before overhead. */
  unitCents: Cents.nullable(),
  overheadApplied: z.boolean(),
  /** "procedure" lines are marked up; "non_procedure" = staff fees, stipends, etc. */
  category: z.enum(["procedure", "non_procedure"]),
  /** Keyed by GridVisit.code. Missing key = not done at that visit. */
  cells: z.record(z.string(), GridCell),
  prov: Provenance,
});

export const BudgetGrid = z.object({
  id: z.string(),
  label: z.string(),
  /** e.g. "Arm A De Novo", or null when the study has one arm. */
  arm: z.string().nullable(),
  statedOverheadPct: z.number().nullable(),
  visits: z.array(GridVisit),
  procedures: z.array(GridProcedure),
  /** Printed per-patient totals, e.g. [{label:"Double blind only", cents:823800}]. */
  perPatientTotals: z.array(z.object({ label: z.string(), cents: Cents, prov: Provenance })),
  /** Header fields printed on the grid page (to catch wrong PI/site). */
  header: z.object({ investigator: z.string().nullable(), siteName: z.string().nullable() }),
  prov: Provenance,
});
export type BudgetGrid = z.infer<typeof BudgetGrid>;

export const Cap = z.object({
  kind: z.enum(["none", "count", "amount", "ratio_to_randomized", "blocks_with_reauth"]),
  /** count/amount limit, or block size for blocks_with_reauth. */
  n: z.number().nullable(),
  /** e.g. 1 for "1 SF per 1 randomized". */
  ratio: z.number().nullable(),
});

export const Invoiceable = z.object({
  code: z.string().nullable(),
  name: z.string(),
  amountCents: Cents.nullable(),
  /** As printed in a "cost with overhead" column; the billable amount when present. */
  amountWithOverheadCents: Cents.nullable(),
  basis: z.enum(["fixed", "actual_cost", "per_procedure", "per_hour", "per_mile"]),
  /** Free text as written: "per occurrence", "per SAE", "per day". */
  frequency: z.string(),
  cap: Cap,
  requiresPreApproval: z.boolean(),
  requiredDocs: z.array(z.string()),
  prov: Provenance,
});

export const ScreenFail = z.object({
  amountCents: Cents.nullable(),
  basis: z.enum(["fixed", "per_procedure"]),
  cap: Cap,
  paidVia: z.enum(["auto_edc", "invoice"]),
  requiredDocs: z.array(z.string()),
  prov: Provenance,
});

export const SiteFee = z.object({
  code: z.string().nullable(),
  name: z.string(),
  amountCents: Cents.nullable(),
  trigger: z.enum(["agreement_execution", "study_initiation", "regulatory_package", "closeout", "annual", "per_event", "one_time", "actual_cost"]),
  /** Days after the trigger when payment is due, if stated. */
  dueDays: z.number().int().nullable(),
  prov: Provenance,
});

export const Holdback = z.object({
  pct: z.number(),
  appliesTo: z.string(),
  releaseConditions: z.array(z.string()),
  prov: Provenance,
});

export const Deadline = z.object({
  kind: z.enum([
    "invoice_days_from_expense",
    "invoice_months_after_study_close",
    "final_invoice_days_after_closeout",
    "query_resolution_days",
    "dispute_days_after_final_payment",
    "edc_entry_business_days",
  ]),
  value: z.number().int(),
  consequence: z.string(),
  prov: Provenance,
});

export const Overpayment = z.object({
  refundDays: z.number().int().nullable(),
  sponsorMayOffset: z.boolean(),
  prov: Provenance,
});

export const Rulebook = z.object({
  schemaVersion: z.literal(1),
  study: StudyInfo,
  documents: z.array(RulebookDocument),
  referencedDocuments: z.array(ReferencedDocument),
  overhead: Overhead,
  payment: Payment,
  budgetGrids: z.array(BudgetGrid),
  /** Chosen by the accountant when budgetGrids has more than one conflicting grid for the same arm. */
  governingGridId: z.string().nullable(),
  invoiceables: z.array(Invoiceable),
  screenFail: ScreenFail.nullable(),
  siteFees: z.array(SiteFee),
  holdback: Holdback.nullable(),
  deadlines: z.array(Deadline),
  overpayment: Overpayment.nullable(),
  rounding: sourced(z.enum(["printed_amounts", "cents", "unspecified"])),
  /** Amendments: date new terms apply from; retroactive when before execution. */
  appliesFrom: sourced(z.string().nullable()),
});
export type Rulebook = z.infer<typeof Rulebook>;
