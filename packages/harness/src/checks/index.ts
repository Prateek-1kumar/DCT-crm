import type { Rulebook } from "@dct/shared";
import type { CheckReport, Checks, LoadedDoc, Page, Problem } from "../types";
import { checkCitations } from "./cells";
import { checkGrid } from "./grid";
import { checkQuote } from "./quote";
import { checkRelations, lessRelationProven, withRelationProof } from "./relations";
import { requiredDecisions } from "./required";
import { unaccounted } from "./unaccounted";
import { usd } from "./text";

export const SCAN_PAGE_REASON = "scanned page: this amount needs the contract's arithmetic or a closer second read";

type Term = Rulebook["terms"][number];
const PROVEN = new Set<Term["evidence"]>(["math", "two_reads", "person"]);

export const needsProof = (t: Term, page: Page | undefined) => page !== undefined && page.kind !== "text" && t.amountCents !== null && !PROVEN.has(t.evidence);

function runChecks(rulebook: Rulebook, docs: LoadedDoc[]): CheckReport {
  const problems: Problem[] = [];
  // a relation that fails is the agent's to fix while it compiles (put_relations), never a problem that blocks approval
  const relations = checkRelations(rulebook, docs);

  const grids: CheckReport["grids"] = {};
  for (const g of rulebook.grids) {
    const result = (grids[g.id] = lessRelationProven(g, checkGrid(g, docs), relations, docs));
    const where = { check: "grid", id: g.id, doc: g.doc, page: g.pages[0] } as const;
    result.problems.forEach((message) => problems.push({ ...where, message }));
    if (!result.problems.length && result.unproven.length) {
      const cells = result.unproven.slice(0, 5).map(({ row, col }) => `row '${g.rows[row]!.name}' at visit '${g.visits[col]}'`).join("; ");
      const more = result.unproven.length > 5 ? ` and ${result.unproven.length - 5} more` : "";
      problems.push({ ...where, message: `${result.unproven.length} cells have no printed total proving them: ${cells}${more}.` });
    }
  }

  const quotes: CheckReport["quotes"] = {};
  // re-derived, so a "math" the relations no longer back can't excuse a term from proof
  for (const t of withRelationProof(rulebook, docs, relations.proven).terms) {
    const page = docs.find((d) => d.name === t.source.doc)?.pages.find((p) => p.page === t.source.page);
    const reason = checkQuote(t.source, docs) ?? (needsProof(t, page) ? SCAN_PAGE_REASON : null);
    if (!reason) continue;
    quotes[t.id] = reason;
    problems.push({ check: "quote", id: t.id, doc: t.source.doc, page: t.source.page, message: reason, ...(reason === SCAN_PAGE_REASON && { afterCompile: true as const }) });
  }

  problems.push(...checkCitations(rulebook, docs).problems);

  const stray = unaccounted(rulebook, docs);
  for (const u of stray) {
    problems.push(
      u.secondRead
        ? { check: "unaccounted", doc: u.doc, page: u.page, afterCompile: true, message: `${usd(u.amountCents)} on p.${u.page} of ${u.doc} was found only by a second reading of the page ("${u.context}"): answer the question about it.` }
        : { check: "unaccounted", doc: u.doc, page: u.page, message: `${usd(u.amountCents)} on p.${u.page} of ${u.doc} is not in the rulebook ("${u.context}"): add it to a term or grid, or list it as accounted with a reason.` },
    );
  }

  return { grids, quotes, unaccounted: stray, required: requiredDecisions(rulebook), problems };
}

export const checks: Checks = { checkGrid, checkQuote, unaccounted, requiredDecisions, runChecks };
