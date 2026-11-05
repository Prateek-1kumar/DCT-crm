import type { Question, Rulebook } from "@dct/shared";
import { estimateUsd, spentOn, type Budget, type Part, type Reader } from "../models/reader";
import { pdfReader } from "../pdf";
import type { LoadedDoc } from "../types";
import { SYSTEM_PROMPT } from "./prompt";
import { toQuestions } from "./questions";
import { Findings } from "./schema";

// A high-effort review has written up to ~25k tokens, most of them reasoning.
const OUTPUT_TOKENS = 30000;

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
    else {
      const heading = page.kind === "ocr" ? `${label} (OCR, scanned: the image is the page; the text below was read by OCR and may contain misreads)\n${page.layout}` : `${label} (scan, shown as an image)`;
      parts.push({ type: "text", text: heading }, { type: "image", png: await pdfReader.render(doc, page.page) });
    }
  }
  return parts;
}

export async function review(rulebook: Rulebook, docs: LoadedDoc[], opts: { reader: Reader; budget: Budget }): Promise<ReviewResult> {
  const { reader, budget } = opts;

  const { study, terms, grids, accounted } = rulebook;
  const open = rulebook.questions.map((q) => ({ question: q.question, about: q.about, doc: q.source.doc, page: q.source.page }));
  // a document missing from study.documents is read as money-bearing, so nothing is skipped by accident
  const moneyDocs = docs.filter((d) => study.documents.find((r) => r.doc === d.name)?.hasMoney !== false);
  const parts: Part[] = [
    { type: "text", text: `Rulebook:\n${JSON.stringify({ study, terms, grids, accounted })}` },
    { type: "text", text: `Questions already open:\n${JSON.stringify(open)}` },
    ...(await Promise.all(moneyDocs.map(pagesOf))).flat(),
  ];

  if (budget.spent + estimateUsd(reader, parts, OUTPUT_TOKENS) > budget.limit) {
    return { questions: [], usd: 0, error: `The review was skipped: it would pass this read's $${budget.limit} limit.` };
  }
  try {
    const { value, usd } = await reader.ask({ name: "review", system: SYSTEM_PROMPT, parts, schema: Findings, effort: "high" });
    budget.spent += usd;
    return { questions: toQuestions(value.findings, rulebook, docs), usd };
  } catch (err) {
    budget.spent += spentOn(err);
    return { questions: [], usd: spentOn(err), error: `The review could not be completed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
