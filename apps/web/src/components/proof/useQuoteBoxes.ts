"use client";

import type { Region } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "@/lib/queries";
import type { CoverageRef } from "@/lib/types";
import { findTerm, pageAt, sourceOf, type ProofData, type Spot } from "./model";

/** Where the words a term quotes sit on its page: found by searching a text page, else the boxes the checker saved. Empty unless `spot` is the quote's own page. `approx` says the boxes are a larger area, not the exact words. */
export function useQuoteBoxes(data: ProofData, ref: CoverageRef | null, spot: Spot | null): { boxes: Region[]; approx: boolean } {
  const term = ref?.target === "term" ? findTerm(data, ref.id) : undefined;
  const home = term && ref ? sourceOf(data, ref) : null;
  const homePage = pageAt(data, home);
  const quote = term?.source.quote ?? "";
  const search = useQuery({
    queryKey: keys.find(home?.doc ?? "", home?.page ?? 0, quote),
    queryFn: () => api.find(home!.doc, home!.page, quote),
    enabled: !!home && homePage?.kind === "text" && quote !== "",
  });
  if (!home || !spot || home.doc !== spot.doc || home.page !== spot.page) return { boxes: [], approx: false };
  if (search.data?.boxes.length) return { boxes: search.data.boxes, approx: !!search.data.approx };
  const clauses = homePage?.clauses.filter((c) => c.termId === term?.id) ?? [];
  return { boxes: clauses.flatMap((c) => c.boxes), approx: clauses.some((c) => c.approx) };
}
