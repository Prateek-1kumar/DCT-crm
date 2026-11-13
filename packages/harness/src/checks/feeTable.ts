import type { FeeTable, Rulebook } from "@dct/shared";
import { usd } from "./text";
import { ROUNDING_TOLERANCE_CENTS } from "./grid";

type Term = Rulebook["terms"][number];

/** What the compile agent is told to do about it; a person is told something they can do instead. */
export const FEE_TABLE_FIX = " Re-read the table and correct the line, the quantity or the term's amount.";

export interface FeeTableResult {
  problems: string[];
  /** Terms whose amount times the line's printed quantity is the printed line total. */
  proven: string[];
  /** Terms whose amount fails that arithmetic: the heuristic amount guard stays quiet about them, so one mistake is reported once. */
  refuted: string[];
}

/**
 * The arithmetic a fee table prints, which is to fee terms what a grid's total rows are to its cells: the lines add up to
 * the printed table total (no line dropped or misread), and a line's quantity times its one term's amount is the printed
 * line total (the amount is what one pays, not the line's total). A line with several terms or no quantity has no product
 * to check; it still counts toward the sum.
 */
export function checkFeeTable(table: FeeTable, terms: Term[]): FeeTableResult {
  const byId = new Map(terms.map((t) => [t.id, t]));
  const result: FeeTableResult = { problems: [], proven: [], refuted: [] };
  const problem = (message: string) => result.problems.push(message + FEE_TABLE_FIX);

  if (table.totalCents !== null) {
    const sum = table.lines.reduce((s, l) => s + l.totalCents, 0);
    const off = sum - table.totalCents;
    if (off) problem(`the lines add up to ${usd(sum)} but the printed total is ${usd(table.totalCents)}, ${usd(Math.abs(off))} ${off < 0 ? "short: a line is missing or misread" : "over: a line is misread or listed twice"}.`);
  }

  for (const line of table.lines) {
    for (const id of line.termIds) if (!byId.has(id)) problem(`line '${line.name}' lists a fee ('${id}') that is not in the rulebook.`);
    const term = line.termIds.length === 1 ? byId.get(line.termIds[0]!) : undefined;
    // a person's answer stands, as in the amount guard: they have seen the amount and its unit
    if (line.quantity === null || !term || term.amountCents === null || term.evidence === "person") continue;
    const product = Math.round(term.amountCents * line.quantity);
    // whole counts multiply to the cent; only a fractional quantity (hours, a rate) can round
    const tolerance = Number.isInteger(line.quantity) ? 0 : ROUNDING_TOLERANCE_CENTS;
    if (Math.abs(product - line.totalCents) <= tolerance) {
      result.proven.push(term.id);
      continue;
    }
    result.refuted.push(term.id);
    const isTotal = term.amountCents === line.totalCents ? " The amount is the line's total, not the payment for one." : "";
    problem(`line '${line.name}': ${line.quantity} × ${usd(term.amountCents)} (the amount of '${term.name}') comes to ${usd(product)} but the printed line total is ${usd(line.totalCents)}.${isTotal}`);
  }
  return result;
}
