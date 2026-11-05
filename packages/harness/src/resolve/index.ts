import type { Rulebook } from "@dct/shared";
import type { Budget, Reader } from "../models/reader";
import type { CheckReport, LoadedDoc } from "../types";
import { checks } from "../checks";
import { elsewhere } from "./elsewhere";
import { reconcile } from "./ocr";
import { readAll, readJobs } from "./read";
import type { Run } from "./run";

export interface ResolveOptions {
  claude: Reader;
  openai: Reader;
  budget: Budget;
}

export interface Resolved {
  rulebook: Rulebook;
  usd: number;
  log: string[];
}

/** Settles what two independent reads or a citation can settle (§5.5); decisions are left alone. */
export async function resolve(rulebook: Rulebook, docs: LoadedDoc[], report: CheckReport, opts: ResolveOptions): Promise<Resolved> {
  const run: Run = { rulebook, docs, usd: 0, log: [], crops: new Map(), ...opts };
  await reconcile(run, report);
  await readAll(run, readJobs(run.rulebook, checks.runChecks(run.rulebook, docs)));
  await elsewhere(run);
  return { rulebook: run.rulebook, usd: run.usd, log: run.log };
}
