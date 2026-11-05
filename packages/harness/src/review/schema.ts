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

const Finding = z.object({
  type: z.enum(["judgment", "inconsistency", "contradiction", "missed_rule"]),
  kind: z.enum(["elsewhere", "decision"]),
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

export const Findings = z.object({ findings: z.array(Finding) });
