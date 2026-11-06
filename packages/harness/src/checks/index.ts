import type { Rulebook } from "@dct/shared";
import type { CheckReport, Checks, LoadedDoc, Page, Problem } from "../types";
import { checkCitations } from "./cells";
import { NOT_PRINTED, checkGrid } from "./grid";
import { checkQuote } from "./quote";
import { checkRelations, lessRelationProven, withRelationProof } from "./relations";
import { requiredDecisions } from "./required";
import { unaccounted } from "./unaccounted";
import { usd } from "./text";

export const SCAN_PAGE_REASON = "scanned page: this amount needs the contract's own arithmetic or a second reading of the page";

type Term = Rulebook["terms"][number];
const ACCOUNT_IT = ": add it to a term or grid, or list it as accounted with a reason.";
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
      // cells a printed sum holds but doesn't prove rest on the second read, which the agent can't give
      const second = result.unproven.every(({ row, col }) => result.bySumOnly?.some((u) => u.row === row && u.col === col));
      problems.push({ ...where, message: `${result.unproven.length} cells have no printed total proving them: ${cells}${more}.`, ...(second && { afterCompile: true as const }) });
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
        : { check: "unaccounted", doc: u.doc, page: u.page, message: `${usd(u.amountCents)} on p.${u.page} of ${u.doc} is not in the rulebook ("${u.context}")${ACCOUNT_IT}` },
    );
  }

  return { grids, quotes, unaccounted: stray, required: requiredDecisions(rulebook), problems };
}

/**
 * A problem in words for the accountant: what tells the compile agent which ids and tools to use becomes what a person can
 * do, which is answer a question or start the read again.
 */
export function forPerson(p: Pick<Problem, "doc" | "page" | "message"> & { check: string }): string {
  const where = p.page === undefined ? (p.doc ?? "the contract") : `p.${p.page} of ${p.doc}`;
  if (p.check === "cell") return `A scanned amount on ${where} doesn't match what the page prints yet; start the read again or answer its question.`;
  if (p.check === "unaccounted" && p.message.endsWith(ACCOUNT_IT)) return `${p.message.slice(0, -ACCOUNT_IT.length)}: start the read again, or answer its question.`;
  if (p.check === "grid" && p.message === NOT_PRINTED) return `Some figures of a budget on ${where} aren't proven by a printed total or a second reading yet; start the read again.`;
  return p.message;
}

export const checks: Checks = { checkGrid, checkQuote, unaccounted, requiredDecisions, runChecks };
