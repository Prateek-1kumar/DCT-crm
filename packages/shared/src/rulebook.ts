// Money is integer cents; the harness converts printed amounts with parseCents, never float math.
import { z } from "zod";

const text = z.string().min(1);
const cents = z.number().int();
const nullableText = z.string().nullable();

/** [x0, y0, x1, y1] as fractions 0–1 of the page, origin top-left. */
export const Region = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Region = z.infer<typeof Region>;

export const Source = z.object({ doc: text, page: z.number().int().positive(), quote: z.string(), region: Region.optional() });
export type Source = z.infer<typeof Source>;

/** `ocr_match`: on a scanned page, the value the model read is what OCR read at that spot (§ OCR phase). */
export const Evidence = z.enum(["math", "quote", "ocr_match", "two_reads", "house_rule", "person", "none"]);
export type Evidence = z.infer<typeof Evidence>;

export const TermCategory = z.enum([
  "payment_terms", "invoicing", "holdback", "overhead", "site_fee", "recurring_fee", "invoiceable", "conditional_procedure",
  "screen_failure", "unscheduled_visit", "stipend_travel", "bonus", "cap_or_limit", "deadline", "other",
]);
export type TermCategory = z.infer<typeof TermCategory>;

export const Billing = z.enum(["auto_paid", "invoice", "unknown"]);
/** Whether a rule (the holdback) reaches this term. `unclear` always becomes a decision question (§5.3.5). */
export const Applies = z.enum(["yes", "no", "unclear", "n/a"]);
/** How overhead relates to this term's amount. `unclear` always becomes a decision question. */
export const OverheadApplies = z.enum(["included", "added", "no", "unclear", "n/a"]);

export const Cap = z.object({
  kind: z.enum(["count", "amount", "ratio", "hours", "none"]),
  /** The limit's number: a count, cents (kind amount), hours, or the ratio's left side (e.g. 3 for "3:1"). */
  value: z.number().nullable(),
  period: nullableText,
  text: z.string(),
});

export const Term = z.object({
  id: text,
  category: TermCategory,
  name: text,
  amountCents: cents.nullable(),
  unit: nullableText,
  billing: Billing,
  trigger: nullableText,
  cap: Cap.nullable(),
  /** Money that is a rule, not one amount: "100% V1 + 75% V2, max 41; first 10 as they occur, then 9 per 11 randomized". */
  formula: nullableText,
  conditions: nullableText,
  holdbackApplies: Applies,
  overheadApplies: OverheadApplies,
  deadline: nullableText,
  source: Source,
  evidence: Evidence,
  houseRuleIds: z.array(z.string()),
  notes: nullableText,
});
export type Term = z.infer<typeof Term>;

/** A grid cell: cents, the printed text when it isn't an amount ("Invoice", "Inc in PE", "N/A", "X"), or blank. */
export const Cell = z.union([cents, z.string(), z.null()]);
export type Cell = z.infer<typeof Cell>;

export const GridRow = z.object({
  name: text,
  code: nullableText,
  unitCostCents: cents.nullable(),
  cells: z.array(Cell),
  printedRowTotalCents: cents.nullable(),
});
export type GridRow = z.infer<typeof GridRow>;

export const Grid = z.object({
  id: text,
  name: text,
  arm: nullableText,
  doc: text,
  pages: z.array(z.number().int().positive()).min(1),
  visits: z.array(text).min(1),
  overheadPct: z.number().nullable(),
  rows: z.array(GridRow),
  /** Printed rows; they are what proves the cells. */
  subtotal: z.array(Cell).nullable(),
  overhead: z.array(Cell).nullable(),
  /** Lines added after overhead (stipends, end-of-study bonus), one value per visit. */
  additions: z.array(z.object({ name: text, cells: z.array(Cell) })),
  total: z.array(Cell).nullable(),
  grandTotalCents: cents.nullable(),
  /** [row, visit] cells settled by two independent reads, for grids with no printed total to prove them. */
  cellsReadTwice: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
});
export type Grid = z.infer<typeof Grid>;

/** A dollar amount (or whole pages) deliberately not a rulebook value, with the reason (superseded budget, insurance limit, citation). */
export const Accounted = z
  .object({ doc: text, page: z.number().int().positive().optional(), pages: z.array(z.number().int().positive()).optional(), amountCents: cents.optional(), reason: text })
  .refine((a) => (a.page !== undefined) !== (a.pages !== undefined), { error: "give either page (with amountCents) or pages" });
export type Accounted = z.infer<typeof Accounted>;

export const DocumentRole = z.object({
  doc: text,
  role: z.enum(["cta", "work_order", "master_agreement", "amendment", "budget", "protocol", "other"]),
  /** False only for documents with no payment terms at all (a protocol): their pages skip the every-dollar check. */
  hasMoney: z.boolean(),
  supersedes: z.array(z.string()),
  effectiveFrom: nullableText,
  retroactive: z.boolean(),
  notes: nullableText,
});
export type DocumentRole = z.infer<typeof DocumentRole>;

export const Study = z.object({
  protocol: text,
  sponsor: text,
  payer: nullableText,
  siteEntity: text,
  siteNumber: nullableText,
  pi: nullableText,
  effectiveDate: nullableText,
  documents: z.array(DocumentRole),
});
export type Study = z.infer<typeof Study>;

/** `set` keys are term fields, or dotted paths into a grid ("rows.3.cells.5", "total.2", "grandTotalCents"). */
export const Patch = z.object({ target: z.enum(["term", "grid"]), id: text, set: z.record(z.string(), z.unknown()) });
export type Patch = z.infer<typeof Patch>;

export const QuestionKind = z.enum(["reading", "elsewhere", "decision"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const Question = z.object({
  id: text,
  kind: QuestionKind,
  origin: z.enum(["check", "compile", "reviewer", "rule"]),
  about: z.object({ target: z.enum(["term", "grid", "study"]), id: z.string() }).nullable(),
  question: text,
  context: z.string(),
  source: Source,
  options: z.array(z.object({ label: text, patches: z.array(Patch) })),
  suggestion: z.object({ option: z.number().int().nonnegative(), reason: z.string() }).nullable(),
  state: z.enum(["open", "auto_resolved", "answered"]),
  /** False for a reviewer's lower-stakes finding: shown as worth a look, but approval doesn't wait for it. */
  blocking: z.boolean(),
  /** What each model read independently, for a `reading` question; a person sees these when the reads disagree. */
  readings: z.array(z.object({ model: text, answer: z.string() })),
  resolution: z.object({ by: z.enum(["two_reads", "citation"]), patches: z.array(Patch), citation: Source.nullable() }).nullable(),
});
export type Question = z.infer<typeof Question>;

export const Rulebook = z.object({
  study: Study,
  terms: z.array(Term),
  grids: z.array(Grid),
  accounted: z.array(Accounted),
  questions: z.array(Question),
});
export type Rulebook = z.infer<typeof Rulebook>;
