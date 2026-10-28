import { z } from "zod";

/**
 * Evidence and review queue (docs/phase-1/adr-001-extraction-evidence.md).
 * A value is unconfirmed until the PDF's own text or a person confirms it.
 */

/** A spot on a contract page. */
export const PageBox = z.object({
  documentId: z.string(),
  page: z.number().int().positive(),
  /** x, y, width, height as fractions (0–1) of the page as stored in the PDF; null when only the page is known. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export type PageBox = z.infer<typeof PageBox>;

/** What backs one rulebook value. */
export const ValueEvidence = z.object({
  /** JSON pointer into the rulebook, e.g. "/budgetGrids/0/procedures/3/cells/V2". */
  path: z.string(),
  /** confirmed: the PDF text at that spot says the same · attested: a person typed or chose it · conflict: the PDF text says otherwise · ungrounded: not found on the page. */
  status: z.enum(["confirmed", "attested", "conflict", "ungrounded"]),
  where: z.array(PageBox),
  /** Text printed at that spot, e.g. "4,295.00"; null when nothing was found. */
  printed: z.string().nullable(),
  /** e.g. "page reference corrected from 4 to 9". */
  note: z.string().nullable(),
});
export type ValueEvidence = z.infer<typeof ValueEvidence>;

/**
 * confirm_value: type what the page says (conflicts, values not found, spot checks) · unaccounted: found in the contract but not in the master ·
 * contract_problem: the document itself is inconsistent · interpretation: how a clause should be read · unclassified: a money term the master can't hold yet.
 */
export const ReviewKind = z.enum(["confirm_value", "unaccounted", "contract_problem", "interpretation", "unclassified"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

export const ReviewAnswer = z.object({
  /** Typed value: cents for money, a number for % / days / counts, ISO date, or text. */
  value: z.unknown().optional(),
  optionId: z.string().optional(),
  cantTell: z.boolean().optional(),
  note: z.string().optional(),
  by: z.string(),
  at: z.string(),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

/** One thing a person must look at, shown one at a time. Never carries the tool's reading before it is answered (blind entry). */
export const ReviewItem = z.object({
  /** Stable within a version. */
  id: z.string(),
  kind: ReviewKind,
  /** Why it is here: an anomaly code, "spot_check", ... */
  reason: z.string(),
  path: z.string().nullable(),
  /** Plain-language question, e.g. "What amount is printed for the Visit 4 total?" */
  question: z.string(),
  /** What the person types; null for choice items. */
  input: z.enum(["money", "percent", "number", "date", "text"]).nullable(),
  /** Choices, none pre-selected. */
  options: z.array(z.object({ id: z.string(), label: z.string() })),
  where: z.array(PageBox),
  /** Must be settled before approval. */
  blocking: z.boolean(),
  answer: ReviewAnswer.nullable(),
  /** matched / chosen settle the item; differs keeps it open and fills `compare`; cant_tell leaves it for the approver. */
  outcome: z.enum(["matched", "differs", "chosen", "cant_tell"]).nullable(),
  /** Filled only after a typed answer differs from the reading. */
  compare: z.object({ typed: z.unknown(), read: z.unknown(), printed: z.string().nullable() }).nullable(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const settled = (i: ReviewItem) => i.outcome === "matched" || i.outcome === "chosen";

/**
 * POST /studies/:id/versions/:v/report: "This looks wrong" on any value. On a draft it adds a blocking confirm_value item;
 * on a live version it opens a correction draft (copy of the live version + that item). Returns the draft.
 */
export const ReportValueBody = z.object({ path: z.string(), note: z.string().min(1), by: z.string().min(1) });

/**
 * POST /studies/:id/versions/by-hand: blank draft for a contract that couldn't be read; every value typed is `attested`.
 * POST /studies/:id/versions/:v/by-hand/done (same body): typing finished; a different person re-types up to 10 random values blind.
 */
export const ByHandBody = z.object({ by: z.string().min(1) });

/** POST /studies/:id/versions/:v/review/:itemId */
export const AnswerReviewBody = z.object({
  value: z.unknown().optional(),
  optionId: z.string().optional(),
  cantTell: z.boolean().optional(),
  /** Required when re-answering an item whose outcome is "differs". */
  note: z.string().optional(),
  by: z.string().min(1),
});
