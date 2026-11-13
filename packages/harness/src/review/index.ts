import type { Question, Rulebook } from "@dct/shared";
import { estimateUsd, spentOn, type Budget, type Part, type Reader } from "../models/reader";
import { pdfReader } from "../pdf";
import type { LoadedDoc } from "../types";
import { checkChecklist, type TopicResult } from "./checklist";
import { SYSTEM_PROMPT } from "./prompt";
import { toQuestions } from "./questions";
import { Findings } from "./schema";

// A high-effort review has written up to ~25k tokens, most of them reasoning.
const OUTPUT_TOKENS = 30000;

export interface ReviewResult {
  questions: Question[];
  usd: number;
  /** Plain-English lines about findings that were left out, and what the checklist found. */
  log: string[];
  /** One entry per checklist topic; absent when the review did not run. */
  checklist?: TopicResult[];
  error?: string;
}

async function pagesOf(doc: LoadedDoc, render = (n: number) => pdfReader.render(doc, n)): Promise<Part[]> {
  const parts: Part[] = [];
  for (const page of doc.pages) {
    const label = `=== ${doc.name} p${page.page} ===`;
    if (page.kind === "text") parts.push({ type: "text", text: `${label}\n${page.layout}` });
    else {
      const heading = page.kind === "scan" ? `${label} (scan: the text below was transcribed from the image, which is attached)\n${page.layout}` : `${label} (scan, shown as an image)`;
      parts.push({ type: "text", text: heading }, { type: "image", png: await render(page.page) });
    }
  }
  return parts;
}

// A page not transcribed yet is costed at the most a transcription writes, about 4,000 tokens, so the estimate made
// before reading it isn't below the one made after.
const UNREAD_PAGE: Part = { type: "text", text: " ".repeat(14000) };

/**
 * What the review of these documents is expected to cost, before the rulebook is written: that is taken to be as long as
 * the pages' text, and an estimate counts an image without looking at it.
 */
export async function reviewUsd(reader: Reader, docs: LoadedDoc[]): Promise<number> {
  const pages = (await Promise.all(docs.map((d) => pagesOf(d, async () => Buffer.alloc(0))))).flat();
  const unread = docs.flatMap((d) => d.pages.filter((p) => p.kind === "image").map(() => UNREAD_PAGE));
  const text = [...pages.filter((p) => p.type === "text"), ...unread];
  // the pages, what their unread ones will hold, and a rulebook as long as all their text
  return estimateUsd(reader, [...pages, ...unread, ...text], OUTPUT_TOKENS);
}

/** `keep` is left in the budget for what has to run after the review, the second reads of scanned pages. */
export async function review(rulebook: Rulebook, docs: LoadedDoc[], opts: { reader: Reader; budget: Budget; keep?: number }): Promise<ReviewResult> {
  const { reader, budget, keep = 0 } = opts;

  const { study } = rulebook;
  // Everything the rulebook holds is sent, so a part added to it later reaches the reviewer without a change here.
  // Left out: the questions, sent below in short form, and the scan arithmetic, which the checks prove.
  const sent = Object.fromEntries(Object.entries(rulebook).filter(([key]) => key !== "questions" && key !== "relations"));
  const open = rulebook.questions.map((q) => ({ question: q.question, about: q.about, doc: q.source.doc, page: q.source.page }));
  // a document missing from study.documents is read as money-bearing, so nothing is skipped by accident
  const moneyDocs = docs.filter((d) => study.documents.find((r) => r.doc === d.name)?.hasMoney !== false);
  const parts: Part[] = [
    { type: "text", text: `Rulebook:\n${JSON.stringify(sent)}` },
    { type: "text", text: `Questions already open:\n${JSON.stringify(open)}` },
    ...(await Promise.all(moneyDocs.map((d) => pagesOf(d)))).flat(),
  ];

  if (budget.spent + estimateUsd(reader, parts, OUTPUT_TOKENS) + keep > budget.limit) {
    return { questions: [], usd: 0, log: [], error: `The review was skipped: it would pass this read's $${budget.limit.toFixed(2)} limit.` };
  }
  try {
    const { value, usd } = await reader.ask({ name: "review", system: SYSTEM_PROMPT, parts, schema: Findings, effort: "high" });
    budget.spent += usd;
    const log: string[] = [];
    const raised = toQuestions(value.findings, rulebook, docs, log);
    const checked = checkChecklist(value.checklist, value.findings, raised, rulebook, docs, log);
    return { questions: [...raised, ...checked.questions], usd, log, checklist: checked.topics };
  } catch (err) {
    budget.spent += spentOn(err);
    return { questions: [], usd: spentOn(err), log: [], error: `The review could not be completed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
