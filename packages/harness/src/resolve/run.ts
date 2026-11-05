import type { Question, Rulebook } from "@dct/shared";
import { spentOn, type Ask, type Budget, type Reader } from "../models/reader";
import type { LoadedDoc } from "../types";

export interface Run {
  rulebook: Rulebook;
  docs: LoadedDoc[];
  claude: Reader;
  openai: Reader;
  budget: Budget;
  usd: number;
  log: string[];
}

/** One model call inside the budget. Failures throw a plain-English message for the log; the model's own error text is never shown. */
export async function call<T>(run: Run, reader: Reader, ask: Ask<T>): Promise<T> {
  if (run.budget.spent >= run.budget.limit) throw new Error(`the $${run.budget.limit} limit was reached`);
  const answer = await reader.ask(ask).catch((err: unknown) => {
    run.budget.spent += spentOn(err);
    run.usd += spentOn(err);
    throw new Error(`${reader.model} couldn't answer`);
  });
  run.budget.spent += answer.usd;
  run.usd += answer.usd;
  return answer.value;
}

export function setQuestion(run: Run, id: string, change: Partial<Question>) {
  run.rulebook = { ...run.rulebook, questions: run.rulebook.questions.map((q) => (q.id === id ? { ...q, ...change } : q)) };
}
