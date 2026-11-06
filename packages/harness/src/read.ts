import type { Rulebook } from "@dct/shared";
import { compile, type CompileResult } from "./agent";
import type { ModelClient } from "./agent/client";
import { checks } from "./checks";
import type { Budget, Reader } from "./models";
import { resolve } from "./resolve";
import { review } from "./review";
import { SCAN_PAGE_USD, scanDocs } from "./scan";
import type { CheckReport, LoadedDoc, ScanStore } from "./types";

export interface ReadOptions {
  anthropic: ModelClient;
  claude: Reader;
  openai: Reader;
  maxUsd?: number;
  onProgress?: (line: string) => void;
  /** Where transcribed scanned pages are kept; required when a file has pages with no text layer. */
  scans?: ScanStore;
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

/** A read that stopped. The message is plain English for the accountant; `usd` is what it had spent, so it can be recorded. */
export class ReadFailed extends Error {
  constructor(
    message: string,
    readonly usd: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const COMPILED = new Set(["done", "finishes_exhausted"]);
// The rest is kept for the second reader and the resolver; a scan-free compile has used about a third of $3.
const COMPILE_SHARE = 0.7;

function withRequired(rulebook: Rulebook, report: CheckReport): Rulebook {
  const known = new Set(rulebook.questions.map((q) => q.id));
  return { ...rulebook, questions: [...rulebook.questions, ...report.required.filter((q) => !known.has(q.id))] };
}

export function defaultMaxUsd(): number {
  const envUsd = Number(process.env.HARNESS_MAX_USD);
  return envUsd > 0 ? envUsd : 3;
}

/** An explicit limit is the whole budget; otherwise the default, plus what the scanned pages still to read are expected to cost. */
export const readBudget = (maxUsd: number | undefined, scanPages: number) => maxUsd ?? defaultMaxUsd() + SCAN_PAGE_USD * scanPages;

export async function read(docs: LoadedDoc[], opts: ReadOptions): Promise<ReadResult> {
  if (!opts.scans && docs.some((d) => d.pages.some((p) => p.kind === "image"))) {
    throw new ReadFailed("Some pages in these files are scans, and there's nowhere to keep what is read from them. Tell the team; nothing was sent to any model.", 0);
  }
  const budget: Budget = { limit: opts.maxUsd ?? defaultMaxUsd(), spent: 0 };
  try {
    return await stages(docs, opts, budget);
  } catch (err) {
    if (err instanceof ReadFailed) throw err;
    throw new ReadFailed("The read stopped because of a problem on the server. Start it again; if it keeps happening, tell the team.", budget.spent, { cause: err });
  }
}

async function stages(unscanned: LoadedDoc[], opts: ReadOptions, budget: Budget): Promise<ReadResult> {
  const log: string[] = [];
  const say = (line: string) => {
    log.push(line);
    opts.onProgress?.(line);
  };

  const docs = opts.scans ? await scanDocs(unscanned, { reader: opts.openai, store: opts.scans, budget, onProgress: say }) : unscanned;

  let rulebook = opts.rulebook;
  let compiled: CompileResult | undefined;
  if (!rulebook) {
    compiled = await compile(docs, { client: opts.anthropic, model: opts.claude.model, maxUsd: (budget.limit - budget.spent) * COMPILE_SHARE, onProgress: say });
    budget.spent += compiled.usd;
    if (!COMPILED.has(compiled.stopReason)) return { rulebook: compiled.rulebook, report: compiled.report, usd: budget.spent, compiled, log };
    rulebook = compiled.rulebook;
  }
  rulebook = withRequired(rulebook, checks.runChecks(rulebook, docs));

  say("Second reader: checking the rulebook for unasked judgment calls");
  const reviewed = await review(rulebook, docs, { reader: opts.openai, budget });
  reviewed.log.forEach(say);
  if (reviewed.error) say(reviewed.error);
  else say(`Second reader raised ${reviewed.questions.length} ${reviewed.questions.length === 1 ? "question" : "questions"}`);
  rulebook = { ...rulebook, questions: [...rulebook.questions, ...reviewed.questions] };

  const resolved = await resolve(rulebook, docs, checks.runChecks(rulebook, docs), { claude: opts.claude, openai: opts.openai, budget, scans: opts.scans });
  resolved.log.forEach(say);

  const report = checks.runChecks(resolved.rulebook, docs);
  return { rulebook: withRequired(resolved.rulebook, report), report, usd: budget.spent, compiled, ...(reviewed.error && { reviewError: reviewed.error }), log };
}
