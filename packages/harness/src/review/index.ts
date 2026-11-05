import type { Question, Rulebook } from "@dct/shared";
import { spentOn, type Budget, type Part, type Reader } from "../models/reader";
import { pdfReader } from "../pdf";
import type { LoadedDoc } from "../types";
import { SYSTEM_PROMPT } from "./prompt";
import { toQuestions } from "./questions";
import { Findings } from "./schema";

export interface ReviewResult {
  questions: Question[];
  usd: number;
  error?: string;
}

async function pagesOf(doc: LoadedDoc): Promise<Part[]> {
  const parts: Part[] = [];
  for (const page of doc.pages) {
    const label = `=== ${doc.name} p${page.page} ===`;
    if (page.kind === "text") parts.push({ type: "text", text: `${label}\n${page.layout}` });
    else parts.push({ type: "text", text: `${label} (scan, shown as an image)` }, { type: "image", png: await pdfReader.render(doc, page.page) });
  }
  return parts;
}

export async function review(rulebook: Rulebook, docs: LoadedDoc[], opts: { reader: Reader; budget: Budget }): Promise<ReviewResult> {
  const { reader, budget } = opts;
  if (budget.spent >= budget.limit) return { questions: [], usd: 0, error: `The review was skipped: this read has already reached its $${budget.limit} limit.` };

  const { study, terms, grids, accounted } = rulebook;
  const open = rulebook.questions.map((q) => ({ question: q.question, about: q.about, doc: q.source.doc, page: q.source.page }));
  // a document missing from study.documents is read as money-bearing, so nothing is skipped by accident
  const moneyDocs = docs.filter((d) => study.documents.find((r) => r.doc === d.name)?.hasMoney !== false);
  const parts: Part[] = [
    { type: "text", text: `Rulebook:\n${JSON.stringify({ study, terms, grids, accounted })}` },
    { type: "text", text: `Questions already open:\n${JSON.stringify(open)}` },
    ...(await Promise.all(moneyDocs.map(pagesOf))).flat(),
  ];

  try {
    const { value, usd } = await reader.ask({ name: "review", system: SYSTEM_PROMPT, parts, schema: Findings, effort: "high" });
    budget.spent += usd;
    return { questions: toQuestions(value.findings, rulebook, docs), usd };
  } catch (err) {
    budget.spent += spentOn(err);
    return { questions: [], usd: spentOn(err), error: `The review could not be completed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
