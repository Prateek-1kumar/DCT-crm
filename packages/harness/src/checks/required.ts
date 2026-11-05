import type { Question, Rulebook, Source, TermCategory } from "@dct/shared";

type Term = Rulebook["terms"][number];
type Field = "billing" | "holdbackApplies" | "overheadApplies";

// Contract rules (refunds, subject injury, termination) are not payments the site bills, so they never ask how they're paid.
const PAYABLE = new Set<TermCategory>(["site_fee", "recurring_fee", "invoiceable", "conditional_procedure", "screen_failure", "unscheduled_visit", "stipend_travel", "bonus"]);

const setAll = (terms: Term[], field: Field, value: string) => terms.map((t) => ({ target: "term" as const, id: t.id, set: { [field]: value } }));

function grouped(
  id: string,
  terms: Term[],
  source: Source,
  question: string,
  context: string,
  choices: [label: string, field: Field, value: string][],
): Question {
  return {
    id,
    kind: "decision",
    origin: "rule",
    about: terms.length === 1 ? { target: "term", id: terms[0]!.id } : null,
    question,
    context: `${context} ${terms.length === 1 ? "Item" : "Items"}: ${terms.map((t) => t.name).join("; ")}.`,
    source,
    options: [
      ...choices.map(([label, field, value]) => ({ label, patches: setAll(terms, field, value) })),
      ...(terms.length > 1 ? [{ label: "It differs: I'll say for each", patches: [] }] : []),
    ],
    suggestion: null,
    state: "open",
    blocking: true,
    readings: [],
    resolution: null,
  };
}

export function requiredDecisions(rulebook: Rulebook): Question[] {
  const payable = rulebook.terms.filter((t) => PAYABLE.has(t.category));
  const rule = (category: TermCategory) => rulebook.terms.find((t) => t.category === category)?.source;
  const out: Question[] = [];

  const billing = payable.filter((t) => t.billing === "unknown");
  if (billing.length) {
    out.push(
      grouped("rule:billing", billing, billing[0]!.source, "How are these paid: automatically, or does the site invoice them?",
        "The contract does not say whether these are paid without an invoice or only when the site bills for them.", [
        ["All are paid automatically", "billing", "auto_paid"],
        ["The site invoices all of them", "billing", "invoice"],
      ]),
    );
  }

  const holdbackClause = rule("holdback");
  const holdback = payable.filter((t) => t.holdbackApplies === "unclear");
  if (holdbackClause && holdback.length) {
    out.push(
      grouped("rule:holdback", holdback, holdbackClause, "Does the holdback apply to these payments?",
        "The contract holds back part of the payments but does not say whether these are included.", [
        ["Yes, to all of them", "holdbackApplies", "yes"],
        ["No, these are paid in full", "holdbackApplies", "no"],
      ]),
    );
  }

  const overhead = payable.filter((t) => t.overheadApplies === "unclear");
  if (overhead.length) {
    out.push(
      grouped("rule:overhead", overhead, rule("overhead") ?? overhead[0]!.source, "How does overhead relate to these amounts?",
        "The contract charges overhead but does not say whether these amounts already include it.", [
        ["Overhead is already included", "overheadApplies", "included"],
        ["Overhead is added on top", "overheadApplies", "added"],
        ["No overhead on these", "overheadApplies", "no"],
      ]),
    );
  }

  for (const d of rulebook.study.documents) {
    if (d.role !== "amendment" || d.effectiveFrom !== null) continue;
    out.push({
      id: `rule:effective:${d.doc}`,
      kind: "decision",
      origin: "rule",
      about: { target: "study", id: d.doc },
      question: "From what date do the amendment's terms apply?",
      context: `${d.doc} is an amendment, and it does not give a clear date from which its terms take effect.`,
      source: { doc: d.doc, page: 1, quote: "" },
      options: [
        { label: "From the date it was signed", patches: [] },
        { label: "Retroactively, from an earlier date (you will be asked for the date)", patches: [] },
      ],
      suggestion: null,
      state: "open",
      blocking: true,
      readings: [],
      resolution: null,
    });
  }
  return out;
}
