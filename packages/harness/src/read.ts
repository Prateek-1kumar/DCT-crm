import type { Question, Rulebook } from "@dct/shared";
import { compile, type CompileResult } from "./agent";
import type { ModelClient } from "./agent/client";
import { checks } from "./checks";
import type { Budget, Reader } from "./models";
import { resolve } from "./resolve";
import { review, reviewUsd } from "./review";
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
// Of what is left once the reviewer and the closer reads are set aside; the rest absorbs compile's last turn past its
// limit, and the resolver's reads. A scan-free compile has used about a third of $3.
const COMPILE_SHARE = 0.7;
/** Kept back for each scanned page's closer second read: measured at $0.02–0.08 a page. */
export const VERIFY_PAGE_USD = 0.08;

export const NOT_REVIEWED = "This read wasn't checked for judgment calls. Start the read again; the pages already read are kept.";

/** A rulebook nobody checked for silent judgment calls can't be approved, and no answer can wave that through. */
const NOT_REVIEWED_ID = "review:not-run";
const notReviewed = (docs: LoadedDoc[]): Question => ({
  id: NOT_REVIEWED_ID, kind: "decision", origin: "reviewer", about: null, question: NOT_REVIEWED,
  context: "The second reader, which looks for choices the rulebook made that the contract doesn't settle, couldn't run on this read.",
  source: { doc: docs[0]!.name, page: 1, quote: "" }, options: [], suggestion: null, state: "open", blocking: true, readings: [], resolution: null,
});

const scannedPages = (docs: LoadedDoc[]) => docs.reduce((n, d) => n + d.pages.filter((p) => p.kind !== "text").length, 0);

function withRequired(rulebook: Rulebook, report: CheckReport): Rulebook {
  const known = new Set(rulebook.questions.map((q) => q.id));
  return { ...rulebook, questions: [...rulebook.questions, ...report.required.filter((q) => !known.has(q.id))] };
}

export function defaultMaxUsd(): number {
  const envUsd = Number(process.env.HARNESS_MAX_USD);
  return envUsd > 0 ? envUsd : 3;
}

/**
 * An explicit limit is the whole budget; otherwise the default, plus what the scanned pages still to read are expected to
 * cost, plus a closer read of every scanned page, which each read may pay for again.
 */
export const readBudget = (maxUsd: number | undefined, untranscribedPages: number, scanned: number) =>
  maxUsd ?? defaultMaxUsd() + SCAN_PAGE_USD * untranscribedPages + VERIFY_PAGE_USD * scanned;

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
    // the reviewer and the closer reads are what make a draft safe to approve, so compile can't spend their share
    const reserved = (await reviewUsd(opts.openai, docs)) + VERIFY_PAGE_USD * scannedPages(docs);
    const maxUsd = Math.max(0, budget.limit - budget.spent - reserved) * COMPILE_SHARE;
    compiled = await compile(docs, { client: opts.anthropic, model: opts.claude.model, maxUsd, onProgress: say });
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
  rulebook = withRequired(resolved.rulebook, report);
  // a rulebook carried over from an earlier read may hold the item already; this review decides whether it still applies
  const questions = rulebook.questions.filter((q) => q.id !== NOT_REVIEWED_ID);
  rulebook = { ...rulebook, questions: reviewed.error ? [...questions, notReviewed(docs)] : questions };
  return { rulebook, report, usd: budget.spent, compiled, ...(reviewed.error && { reviewError: reviewed.error }), log };
}
