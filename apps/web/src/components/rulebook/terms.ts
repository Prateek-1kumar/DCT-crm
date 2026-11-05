import type { Term } from "@dct/shared";
import { formatCents } from "@/lib/money";

export const CATEGORY_LABEL: Record<Term["category"], string> = {
  payment_terms: "Payment terms",
  invoicing: "Invoicing",
  holdback: "Holdback",
  overhead: "Overhead",
  site_fee: "One-time fee",
  recurring_fee: "Recurring fee",
  invoiceable: "Billed on an invoice",
  conditional_procedure: "Extra procedure",
  screen_failure: "Screen failure",
  unscheduled_visit: "Unscheduled visit",
  stipend_travel: "Stipend or travel",
  bonus: "Bonus",
  cap_or_limit: "Limit",
  deadline: "Deadline",
  other: "Other",
};

export const BILLING_LABEL: Record<Term["billing"], string> = {
  auto_paid: "Paid without an invoice",
  invoice: "You invoice for it",
  unknown: "How this is paid isn't settled yet",
};

export const HOLDBACK_LABEL: Record<Term["holdbackApplies"], string> = {
  yes: "Holdback applies",
  no: "Paid in full, no holdback",
  unclear: "Not clear whether the holdback applies",
  "n/a": "No holdback in this contract",
};

export const OVERHEAD_LABEL: Record<Term["overheadApplies"], string> = {
  included: "Overhead is already in the amount",
  added: "Overhead is added on top",
  no: "No overhead",
  unclear: "Not clear how overhead applies",
  "n/a": "No overhead in this contract",
};

export const EVIDENCE_LABEL: Record<Term["evidence"], string> = {
  math: "Totals add up",
  quote: "Matches the contract",
  ocr_match: "Scanned page: OCR and the reader agree",
  two_reads: "Read twice, both agree",
  house_rule: "Follows a standing rule",
  person: "Decided by a person",
  none: "Not checked yet",
};

const capText = ({ kind, value, period, text }: NonNullable<Term["cap"]>): string => {
  if (kind === "none") return "";
  if (value === null) return text;
  const limit = { amount: formatCents(value), hours: `${value} hours`, ratio: `${value}:1`, count: String(value) }[kind];
  return `capped at ${limit}${period ? ` per ${period.replace(/^per\s+/i, "")}` : ""}`;
};

/** The money without how it is paid: "$85.00 per hour · capped at 10 hours". Empty when the term has no amount or rule. */
export function termAmount(term: Term): string {
  const money = term.formula ?? (term.amountCents === null ? "" : `${formatCents(term.amountCents)}${term.unit ? ` ${term.unit}` : ""}`);
  return [money, term.cap ? capText(term.cap) : ""].filter(Boolean).join(" · ");
}

const BILLING_NOTE: Partial<Record<Term["billing"], string>> = { invoice: "invoiced", unknown: "how it's paid isn't settled yet" };

export function termValue(term: Term): string {
  return [termAmount(term), BILLING_NOTE[term.billing]].filter(Boolean).join(" · ") || "No amount stated";
}
