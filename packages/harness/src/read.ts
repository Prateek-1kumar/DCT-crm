import type { Rulebook } from "@dct/shared";
import { compile, type CompileResult } from "./agent";
import type { ModelClient } from "./agent/client";
import { checks } from "./checks";
import type { Budget, Reader } from "./models";
import { resolve } from "./resolve";
import { review } from "./review";
import type { CheckReport, LoadedDoc } from "./types";

export interface ReadOptions {
  anthropic: ModelClient;
  claude: Reader;
  openai: Reader;
  maxUsd?: number;
  onProgress?: (line: string) => void;
  /** A rulebook compiled earlier: skip compiling and only review and resolve it. */
  rulebook?: Rulebook;
}

export interface ReadResult {
  rulebook: Rulebook;
  report: CheckReport;
  usd: number;
  compiled?: CompileResult;
  reviewError?: string;
  log: string[];
}

const COMPILED = new Set(["done", "finishes_exhausted"]);
// The rest is kept for the second reader and the resolver; a scan-free compile has used about a third of $3.
const COMPILE_SHARE = 0.7;

function withRequired(rulebook: Rulebook, report: CheckReport): Rulebook {
  const known = new Set(rulebook.questions.map((q) => q.id));
  return { ...rulebook, questions: [...rulebook.questions, ...report.required.filter((q) => !known.has(q.id))] };
}

/** Pages that are scans, as "file p.1, 2, 5"; empty when every page has text. */
export function scannedPages(docs: LoadedDoc[]): string[] {
  return docs.flatMap((d) => {
    const pages = d.pages.filter((p) => p.kind === "image").map((p) => p.page);
    return pages.length ? [`${d.name} p.${pages.join(", ")}`] : [];
  });
}

export async function read(docs: LoadedDoc[], opts: ReadOptions): Promise<ReadResult> {
  // Bank details can only be found in a text layer, so a scan can't be masked and must not leave the machine.
  const scanned = scannedPages(docs);
  if (scanned.length) {
    throw new Error(`These pages are scans: ${scanned.join("; ")}. Bank details can't yet be found and hidden on scans, so the contract wasn't sent to any model.`);
  }
  const envUsd = Number(process.env.HARNESS_MAX_USD);
  const budget: Budget = { limit: opts.maxUsd ?? (envUsd > 0 ? envUsd : 3), spent: 0 };
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    opts.onProgress?.(line);
  };

  let rulebook = opts.rulebook;
  let compiled: CompileResult | undefined;
  if (!rulebook) {
    compiled = await compile(docs, { client: opts.anthropic, model: opts.claude.model, maxUsd: budget.limit * COMPILE_SHARE, onProgress: say });
    budget.spent = compiled.usd;
    if (!COMPILED.has(compiled.stopReason)) return { rulebook: compiled.rulebook, report: compiled.report, usd: budget.spent, compiled, log };
    rulebook = compiled.rulebook;
  }
  rulebook = withRequired(rulebook, checks.runChecks(rulebook, docs));

  say("Second reader: checking the rulebook for unasked judgment calls");
  const reviewed = await review(rulebook, docs, { reader: opts.openai, budget });
  if (reviewed.error) say(reviewed.error);
  else say(`Second reader raised ${reviewed.questions.length} ${reviewed.questions.length === 1 ? "question" : "questions"}`);
  rulebook = { ...rulebook, questions: [...rulebook.questions, ...reviewed.questions] };

  const resolved = await resolve(rulebook, docs, checks.runChecks(rulebook, docs), { claude: opts.claude, openai: opts.openai, budget });
  resolved.log.forEach(say);

  const report = checks.runChecks(resolved.rulebook, docs);
  return { rulebook: withRequired(resolved.rulebook, report), report, usd: budget.spent, compiled, ...(reviewed.error && { reviewError: reviewed.error }), log };
}
