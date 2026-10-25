import type { ContractAnomalyCode, DocumentKind, StudyStatus } from "@dct/shared";
import { formatCents } from "./money";
import { segments } from "./pointer";

export const DOC_KIND_LABEL: Record<DocumentKind, string> = {
  master_agreement: "Master agreement",
  work_order: "Work order",
  adoption: "Adoption",
  amendment: "Amendment",
  budget: "Budget",
  other: "Other",
};

export const STATUS_LABEL: Record<StudyStatus, string> = {
  setting_up: "Setting up",
  extracting: "Extracting",
  extraction_failed: "Extraction failed",
  needs_review: "Needs review",
  live: "Live",
  amendment_in_review: "Amendment in review",
};

export const ANOMALY_LABEL: Record<ContractAnomalyCode, string> = {
  VISIT_TOTAL_MISMATCH: "Visit total doesn't add up",
  PER_PATIENT_TOTAL_MISMATCH: "Per-patient total doesn't add up",
  OVERHEAD_LABEL_MISMATCH: "Overhead % doesn't match its label",
  GRID_CONFLICT: "Two budget grids conflict",
  DUPLICATE_ITEM: "Item billed twice",
  MISSING_REFERENCED_DOC: "Referenced document missing",
  HEADER_MISMATCH: "Grid header doesn't match contract",
  AI_DISAGREEMENT: "The two AI reads disagree",
  LOW_CONFIDENCE: "Low confidence",
  REQUIRED_MISSING: "Required term not found",
  RETROACTIVE_NO_DATE: "Retroactive with no start date",
  UNREADABLE_PAGE: "Page couldn't be read",
  AMBIGUOUS_TERM: "Ambiguous wording",
};

/** Options for enum-valued fields, keyed by the field name in the rulebook. */
export const ENUM_OPTIONS: Record<string, Record<string, string>> = {
  visitPayment: { auto_edc: "Automatic (from EDC)", invoice: "By invoice", mixed: "Mixed", unspecified: "Not stated" },
  frequency: { monthly: "Monthly", quarterly: "Quarterly", other: "Other", unspecified: "Not stated" },
  appliesTo: {
    procedures_only: "Procedures only",
    procedures_and_staff: "Procedures and staff",
    all_per_patient_lines: "All per-patient lines",
    none: "None",
    unspecified: "Not stated",
  },
  rounding: { printed_amounts: "Use printed amounts", cents: "Round to cents", unspecified: "Not stated" },
  basis: { fixed: "Fixed", actual_cost: "Actual cost", per_procedure: "Per procedure", per_hour: "Per hour", per_mile: "Per mile" },
  paidVia: { auto_edc: "Automatic (from EDC)", invoice: "By invoice" },
  trigger: {
    agreement_execution: "On agreement execution",
    study_initiation: "On study initiation",
    regulatory_package: "On regulatory package",
    closeout: "At closeout",
    annual: "Annually",
    per_event: "Per event",
    one_time: "One time",
    actual_cost: "At actual cost",
  },
  kind: {
    invoice_days_from_expense: "Invoice within N days of expense",
    invoice_months_after_study_close: "Invoice within N months of study close",
    final_invoice_days_after_closeout: "Final invoice within N days of closeout",
    query_resolution_days: "Resolve queries within N days",
    dispute_days_after_final_payment: "Dispute within N days of final payment",
    edc_entry_business_days: "EDC entry within N business days",
  },
};

export type ValueKind = "money" | "cell" | "int" | "number" | "text" | "date" | "list" | "bool" | "enum";

/** Field name a pointer ends at; "/payment/netDays/value" → "netDays", "/deadlines/0/value" → "value". */
export function fieldKey(path: string): string {
  const segs = segments(path);
  const last = segs[segs.length - 1] ?? "";
  const prev = segs[segs.length - 2];
  return last === "value" && prev && !/^\d+$/.test(prev) ? prev : last;
}

export function isMoneyPath(path: string): boolean {
  return /cents$/i.test(fieldKey(path));
}

/** Pick an editor from the pointer and current value. */
export function inferKind(path: string, value: unknown): ValueKind {
  const key = fieldKey(path);
  if (segments(path).includes("cells")) return "cell";
  if (isMoneyPath(path)) return "money";
  if (ENUM_OPTIONS[key] && (typeof value === "string" || value === null)) return "enum";
  if (/date|appliesFrom/i.test(key)) return "date";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (/days|value$|^n$|count/i.test(key) && (typeof value === "number" || value === null)) return "int";
  if (typeof value === "number") return "number";
  return "text";
}

/** Human display for any rulebook value. */
export function formatValue(path: string, value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "Not stated";
  if (value === "invoiceable") return "Invoiceable";
  const key = fieldKey(path);
  if (typeof value === "number") {
    if (isMoneyPath(path) || segments(path).includes("cells")) return formatCents(value);
    if (/pct$/i.test(key)) return `${value}%`;
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return ENUM_OPTIONS[key]?.[value] ?? value;
  if (Array.isArray(value)) return value.length ? value.map((v) => formatValue("", v)).join(", ") : "None";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const name = o.name ?? o.label ?? o.title ?? o.description;
    const amount = (["amountCents", "amountWithOverheadCents", "totalCents", "cents"] as const).find((k) => typeof o[k] === "number");
    if (typeof name === "string") return amount ? `${name} · ${formatCents(o[amount] as number)}` : name;
    if ("value" in o) return formatValue(path, o.value);
    return JSON.stringify(o);
  }
  return String(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : formatDate(iso);
}

export function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}
