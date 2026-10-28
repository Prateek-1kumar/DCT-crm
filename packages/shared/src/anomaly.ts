import { z } from "zod";
import { SourceRef } from "./rulebook";

/** Contract-level problems found before sign-off (Phase 1). */
export const ContractAnomalyCode = z.enum([
  "VISIT_TOTAL_MISMATCH", // visit total ≠ subtotal + overhead + non-procedure, or ≠ sum of its procedures
  "PER_PATIENT_TOTAL_MISMATCH", // sum of visit totals ≠ printed per-patient total
  "OVERHEAD_LABEL_MISMATCH", // stated % ≠ computed % (McAllen: says 35%, computes 25%)
  "GRID_CONFLICT", // two grids for the same arm disagree (McAllen) — needs governingGridId
  "DUPLICATE_ITEM", // same item billed in a visit and as an invoiceable (HCWC central labs)
  "MISSING_REFERENCED_DOC", // master/base agreement referenced but not uploaded
  "HEADER_MISMATCH", // grid header PI/site ≠ contract PI/site (HCWC Arm B)
  "AI_DISAGREEMENT", // Claude and OpenAI read different values
  "LOW_CONFIDENCE", // extraction confidence below threshold
  "REQUIRED_MISSING", // required field not found
  "RETROACTIVE_NO_DATE", // amendment says retroactive but gives no date (Shah)
  "UNREADABLE_PAGE", // page could not be read
  "AMBIGUOUS_TERM", // contract wording is ambiguous (e.g. overhead on site costs)
  "TEXT_LAYER_MISMATCH", // digital PDF: an amount the AI read isn't printed in the PDF's own text
]);
export type ContractAnomalyCode = z.infer<typeof ContractAnomalyCode>;

export const Resolution = z.object({
  kind: z.enum(["fixed", "chosen", "accepted_with_note"]),
  note: z.string().min(1),
  by: z.string().min(1),
  /** ISO timestamp. */
  at: z.string(),
});
export type Resolution = z.infer<typeof Resolution>;

export const ContractAnomaly = z.object({
  /** Stable within a rulebook version: code + path. */
  id: z.string(),
  code: ContractAnomalyCode,
  severity: z.enum(["blocker", "warning", "info"]),
  message: z.string(),
  /** JSON pointer into the rulebook, e.g. "/budgetGrids/0/visits/3/totalCents". */
  path: z.string().nullable(),
  refs: z.array(SourceRef),
  /** Code-specific data, e.g. {expected: 745500, actual: 745400} or {claude: 80000, openai: 80100}. */
  detail: z.record(z.string(), z.unknown()),
  resolution: Resolution.nullable(),
});
export type ContractAnomaly = z.infer<typeof ContractAnomaly>;
