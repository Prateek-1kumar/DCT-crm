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

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
