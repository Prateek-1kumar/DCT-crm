import type { Question } from "@dct/shared";
import type { Version } from "@/lib/types";

export function questionCounts(v: Version) {
  const open = v.rulebook?.questions.filter((q) => q.state === "open") ?? [];
  const must = open.filter((q) => q.blocking).length;
  return { must, look: open.length - must };
}

/** The questions a person walks through: must-answer first, then worth-a-look, each group in the rulebook's order. */
export const walkOrder = (questions: Question[]) => questions.filter((q) => q.state !== "auto_resolved").sort((a, b) => Number(!a.blocking) - Number(!b.blocking));

export const nextOpen = (list: Question[], afterId: string) => {
  const at = list.findIndex((q) => q.id === afterId);
  return list.find((q, i) => i > at && q.state === "open");
};

/** The next open question after this one, coming back round to the start so a skipped one is never lost; undefined when this is the only open one. */
export const nextOpenWrapping = (list: Question[], fromId: string) => {
  const at = list.findIndex((q) => q.id === fromId);
  return list.find((q, i) => i > at && q.state === "open") ?? list.find((q, i) => i < at && q.state === "open");
};

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** What kind of question this is, in words an accountant would use; the codes behind it are never shown. */
export function kindLabel(q: Pick<Question, "kind" | "blocking">): string {
  if (!q.blocking) return "Worth a look";
  if (q.kind === "reading") return "Checking a printed figure";
  if (q.kind === "elsewhere") return "Checking elsewhere in the contract";
  return "The contract doesn't say";
}

/** Names of the people who answered this version's questions, once each, in the order they first answered. */
export const answerers = (v: Pick<Version, "answers">) => [...new Set(v.answers.map((a) => a.by))];

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const answeredByMe = (v: Pick<Version, "answers">, me: string | null) => !!me && v.answers.some((a) => sameName(a.by, me));

/** How many questions in `after` weren't in `before`: the checks can raise new ones once an answer changes the rulebook. */
export const newQuestions = (before: Question[], after: Question[]) => {
  const seen = new Set(before.map((q) => q.id));
  return after.filter((q) => !seen.has(q.id)).length;
};
