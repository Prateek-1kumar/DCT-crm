import { Billing, TermCategory } from "@dct/shared";
import { z } from "zod";

// Fits strict JSON mode for both providers (see Ask in ../models/reader.ts): every field required, nullable not optional.
const text = z.string();

const Change = z.object({ target: z.enum(["term", "grid"]), id: text, field: text, value: text });
export type Change = z.infer<typeof Change>;

const NewTerm = z.object({
  category: TermCategory,
  name: text,
  amount: text.nullable(),
  unit: text.nullable(),
  billing: Billing,
  trigger: text.nullable(),
  formula: text.nullable(),
  conditions: text.nullable(),
  deadline: text.nullable(),
  notes: text.nullable(),
});
export type NewTerm = z.infer<typeof NewTerm>;

/**
 * The topics every review must report on, in the order they are asked. They are the decisions the answer keys show an
 * expert expects again and again: left to the model's own choice of what to look at, a topic was examined on one run
 * and skipped on the next. The value is the topic's name in the accountant's words, for the log and a fallback question.
 * How a term is billed, the holdback's reach and overhead are not here: ../checks/required.ts asks those from the rulebook.
 */
export const TOPICS = {
  partial_payment: "what is paid when only part of the work is done",
  ratio_rounding: "how a ratio or allowance is rounded or carried forward",
  words_vs_tables: "two places in the contract that state the same amount or rule differently",
  missing_payment_document: "an amount or payment rule taken from a document that was not uploaded",
  counted_twice: "an amount inside a total that is also listed as a fee of its own",
  flat_or_cap: "a fee printed with no unit: a flat fee or a limit on actual cost",
  visit_coverage: "what an unscheduled-visit or screen-failure payment covers",
  combined_visits: "a combined, optional or conditional visit that leaves out a line the other visits pay",
  extra_visits: "a visit amount printed outside the per-patient total: when it is paid, and instead of which visit",
  amendment_timing: "from when an amendment's amounts apply, and what happens to payments already made",
} as const;
export type TopicId = keyof typeof TOPICS;
export const TOPIC_IDS = Object.keys(TOPICS) as [TopicId, ...TopicId[]];

const Finding = z.object({
  /** The checklist topic this finding answers, null for one outside the checklist. Tagged here, not by position in the checklist, so a miscounted index can't tie a topic to the wrong finding. */
  topic: z.enum(TOPIC_IDS).nullable(),
  type: z.enum(["judgment", "inconsistency", "contradiction", "missed_rule"]),
  /** What the answer changes for the site; "none" findings are dropped. */
  affects: z.enum(["how_much", "how_billed", "when_paid", "none"]),
  about: z.object({ target: z.enum(["term", "grid", "study", "none"]), id: text.nullable() }),
  question: text,
  context: text,
  doc: text,
  page: z.number().int(),
  quote: text,
  region: z.array(z.number()).nullable(),
  options: z.array(z.object({ label: text, changes: z.array(Change) })),
  suggestion: z.object({ option: z.number().int(), reason: text }).nullable(),
  newTerm: NewTerm.nullable(),
});
export type Finding = z.infer<typeof Finding>;

/** already_asked exists so a topic an open question covers isn't reported "open" with nothing to point at, or asked twice. */
export const Verdict = z.enum(["not_in_contract", "contract_settles", "open", "already_asked"]);

const ChecklistEntry = z.object({
  topic: z.enum(TOPIC_IDS),
  verdict: Verdict,
  /** Where the contract settles it or leaves it open; all three null for not_in_contract and already_asked. */
  doc: text.nullable(),
  page: z.number().int().nullable(),
  quote: text.nullable(),
});
export type ChecklistEntry = z.infer<typeof ChecklistEntry>;

// The checklist comes first so the model writes its verdicts before any free-form finding.
export const Findings = z.object({ checklist: z.array(ChecklistEntry), findings: z.array(Finding) });
