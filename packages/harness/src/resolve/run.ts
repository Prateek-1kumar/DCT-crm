import type { Question, Region, Rulebook } from "@dct/shared";
import { estimateUsd, spentOn, type Ask, type Budget, type Reader } from "../models/reader";
import type { LoadedDoc } from "../types";

export interface Run {
  rulebook: Rulebook;
  docs: LoadedDoc[];
  claude: Reader;
  openai: Reader;
  budget: Budget;
  usd: number;
  log: string[];
  /** Where a scanned page's value was looked at closely, by the id of the question to raise if the reads still disagree. */
  crops: Map<string, Region>;
}

const OUTPUT_TOKENS = 4000;

/** One model call inside the budget. Failures throw a plain-English message for the log; the model's own error text is never shown. */
export async function call<T>(run: Run, reader: Reader, ask: Ask<T>): Promise<T> {
  const estimate = estimateUsd(reader, ask.parts, OUTPUT_TOKENS);
  if (run.budget.spent + estimate > run.budget.limit) throw new Error(`the $${run.budget.limit} limit would be passed`);
  // held while the call runs, so a call made in parallel can't count on the same money
  run.budget.spent += estimate;
  const settle = (usd: number) => {
    run.budget.spent += usd - estimate;
    run.usd += usd;
  };
  try {
    const answer = await reader.ask(ask);
    settle(answer.usd);
    return answer.value;
  } catch (err) {
    settle(spentOn(err));
    throw new Error(`${reader.model} couldn't answer`);
  }
}

export function setQuestion(run: Run, id: string, change: Partial<Question>) {
  run.rulebook = { ...run.rulebook, questions: run.rulebook.questions.map((q) => (q.id === id ? { ...q, ...change } : q)) };
}
