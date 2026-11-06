import type { Question, Rulebook } from "@dct/shared";
import type { Budget, Reader } from "../models/reader";
import type { CheckReport, LoadedDoc, ScanStore } from "../types";
import { checks } from "../checks";
import { elsewhere } from "./elsewhere";
import { readAll, readJobs } from "./read";
import { settleScans } from "./scan";
import type { Run } from "./run";

export interface ResolveOptions {
  claude: Reader;
  openai: Reader;
  budget: Budget;
  /** Where second reads of scanned pages are kept; without it they are made again on every run. */
  scans?: ScanStore;
}

export interface Resolved {
  rulebook: Rulebook;
  usd: number;
  log: string[];
}

/** The open questions a resolver run raises itself; `read:<grid>:printed` is raised by the answer route, which resolve never re-creates. */
const raisedByResolve = (q: Question) => q.origin === "check" && q.state === "open" && /^(read|person):/.test(q.id) && !/:printed\d*$/.test(q.id);

/** Settles what two independent reads or a citation can settle (§5.5); decisions are left alone. */
export async function resolve(rulebook: Rulebook, docs: LoadedDoc[], report: CheckReport, opts: ResolveOptions): Promise<Resolved> {
  // a re-run starts from the earlier run's rulebook; whatever still applies is raised again below
  const run: Run = { rulebook: { ...rulebook, questions: rulebook.questions.filter((q) => !raisedByResolve(q)) }, docs, usd: 0, log: [], ...opts };
  await settleScans(run, report);
  await readAll(run, readJobs(run, checks.runChecks(run.rulebook, docs)));
  await elsewhere(run);
  return { rulebook: run.rulebook, usd: run.usd, log: run.log };
}
