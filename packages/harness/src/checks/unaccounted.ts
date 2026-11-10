import type { Rulebook } from "@dct/shared";
import type { LoadedDoc, UnaccountedAmount } from "../types";
import { coverage } from "./coverage";

// The proof screen's colour map and this check are one computation, so a red amount there is always a failed check here.
export function unaccounted(rulebook: Rulebook, docs: LoadedDoc[]): UnaccountedAmount[] {
  return coverage(rulebook, docs).pages.flatMap((p) => {
    const seen = new Set<number>();
    return p.amounts.flatMap((a) => {
      if (a.status !== "missing" || seen.has(a.cents)) return [];
      seen.add(a.cents);
      return [{ doc: p.doc, page: p.page, amountCents: a.cents, context: a.line, ...(a.secondRead !== undefined && { secondRead: true as const }) }];
    });
  });
}
