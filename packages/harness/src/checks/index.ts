import type { Rulebook } from "@dct/shared";
import type { CheckReport, Checks, LoadedDoc, Page, Problem } from "../types";
import { checkGrid } from "./grid";
import { checkQuote } from "./quote";
import { requiredDecisions } from "./required";
import { unaccounted } from "./unaccounted";
import { usd } from "./text";

export const OCR_PAGE_REASON = "scanned page: this amount needs the contract's arithmetic, a match with what OCR read there, or two independent reads";

type Term = Rulebook["terms"][number];
const PROVEN = new Set<Term["evidence"]>(["math", "ocr_match", "two_reads", "person"]);

export const needsProof = (t: Term, page: Page | undefined) => page !== undefined && page.kind !== "text" && t.amountCents !== null && !PROVEN.has(t.evidence);

function runChecks(rulebook: Rulebook, docs: LoadedDoc[]): CheckReport {
  const problems: Problem[] = [];

  const grids: CheckReport["grids"] = {};
  for (const g of rulebook.grids) {
    const result = (grids[g.id] = checkGrid(g, docs));
    const where = { check: "grid", id: g.id, doc: g.doc, page: g.pages[0] } as const;
    result.problems.forEach((message) => problems.push({ ...where, message }));
    if (!result.problems.length && result.unproven.length) {
      const cells = result.unproven.slice(0, 5).map(({ row, col }) => `row '${g.rows[row]!.name}' at visit '${g.visits[col]}'`).join("; ");
      const more = result.unproven.length > 5 ? ` and ${result.unproven.length - 5} more` : "";
      problems.push({ ...where, message: `${result.unproven.length} cells have no printed total proving them: ${cells}${more}.` });
    }
  }

  const quotes: CheckReport["quotes"] = {};
  for (const t of rulebook.terms) {
    const page = docs.find((d) => d.name === t.source.doc)?.pages.find((p) => p.page === t.source.page);
    const reason = checkQuote(t.source, docs) ?? (needsProof(t, page) ? OCR_PAGE_REASON : null);
    if (!reason) continue;
    quotes[t.id] = reason;
    problems.push({ check: "quote", id: t.id, doc: t.source.doc, page: t.source.page, message: reason });
  }

  const stray = unaccounted(rulebook, docs);
  for (const u of stray) {
    problems.push({
      check: "unaccounted", doc: u.doc, page: u.page,
      message: `${usd(u.amountCents)} on p.${u.page} of ${u.doc} is not in the rulebook ("${u.context}"): add it to a term or grid, or list it as accounted with a reason.`,
    });
  }

  return { grids, quotes, unaccounted: stray, required: requiredDecisions(rulebook), problems };
}

export const checks: Checks = { checkGrid, checkQuote, unaccounted, requiredDecisions, runChecks };
