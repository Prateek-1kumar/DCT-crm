import type { Region } from "@dct/shared";
import type { CoverageAmount, CoveragePage, CoverageRef } from "@/lib/types";
import { amountsOf, isProblem } from "../contract/highlights";
import { findTerm, STATUS, type ProofData } from "./model";
import type { ViewerBox, ViewerTone } from "../viewer";

/** The one box around several (a quote that runs over lines or columns), so the viewer can zoom to the whole passage. */
export function union(boxes: Region[]): Region | null {
  if (boxes.length === 0) return null;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

/** A doubt is drawn as a doubt even when the amount matched; a missing amount is the problem tone. */
export const amountTone = (a: CoverageAmount): ViewerTone => (a.doubt ? "doubt" : a.status === "missing" ? "problem" : a.status);

const doubtWords = (a: CoverageAmount) => (a.doubt ? ` · read with a doubt: ${a.doubt.replace("_", " ")}` : "");

/**
 * What the viewer draws for one page: the spot a line came from (the quoted words, and the amounts that line points at)
 * and, besides it, only the problem amounts, or every amount when `showAll`. `selectedBox` is an amount a link or a click
 * picked (an index into the page's amounts); it is always drawn as the focus.
 */
export function viewerBoxes(data: ProofData, page: CoveragePage | null | undefined | false, o: { ref: CoverageRef | null; quote: Region[]; selectedBox: number | null; showAll: boolean }): { boxes: ViewerBox[]; focus: Region | null; problems: number } {
  if (!page) return { boxes: [], focus: null, problems: 0 };
  const strong = new Set([...(o.ref ? amountsOf(page, o.ref) : []), ...(o.selectedBox !== null && page.amounts[o.selectedBox] ? [o.selectedBox] : [])]);
  const named = (a: CoverageAmount) => {
    const r = a.ref;
    return r && (r.target === "term" ? findTerm(data, r.id)?.name : data.rulebook.grids.find((g) => g.id === r.id)?.name);
  };
  const label = (a: CoverageAmount) => `${a.text} · ${STATUS[a.status].chip}${named(a) ? ` as ${named(a)}` : ""}${doubtWords(a)}`;

  const boxes: ViewerBox[] = o.quote.map((box, i) => ({ id: `quote:${i}`, box, tone: "focus", label: "The words quoted in the rulebook" }));
  page.amounts.forEach((a, i) => {
    if (strong.has(i)) boxes.push({ id: `amt:${i}`, box: a.box, tone: "focus", label: label(a) });
    else if (o.showAll || isProblem(a)) boxes.push({ id: `amt:${i}`, box: a.box, tone: amountTone(a), label: label(a) });
  });

  const picked = o.selectedBox !== null ? page.amounts[o.selectedBox]?.box : undefined;
  const firstStrong = [...strong].sort((a, b) => a - b)[0];
  const focus = picked ?? union(o.quote) ?? (firstStrong !== undefined ? page.amounts[firstStrong]!.box : null);
  return { boxes, focus, problems: page.amounts.filter(isProblem).length };
}

/** The amount a viewer box id stands for ("amt:3"), or null for the quote's boxes. */
export const amountIndex = (id: string) => (id.startsWith("amt:") ? Number(id.slice(4)) : null);
