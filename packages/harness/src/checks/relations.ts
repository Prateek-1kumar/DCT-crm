import { parseCents, parsePercent, type Relation, type Rulebook } from "@dct/shared";
import type { ScanCell } from "../scan/cells";
import type { GridResult, LoadedDoc, Problem } from "../types";
import { cellOf, cellsOn, citeGrid, citeTerm, isMarked } from "./cells";
import { amountsIn, usd } from "./text";

/*
 * How relation proof reaches the rest of the harness:
 * - a term is proven by its persisted evidence "math", which withRelationProof sets (and clears when it no longer holds)
 *   after the compile; runChecks re-derives it, so its report never trusts a stale one;
 * - a grid's `unproven` cells are relation-aware only in runChecks' report, never from checkGrid alone;
 * - relations live on the rulebook, so every copy of a rulebook has to keep `relations` or loses this proof.
 */

type Grid = Rulebook["grids"][number];

/** Cell ids are only unique within a document, so a proven cell is keyed by both. */
export const cellKey = (doc: string, id: string) => `${doc}:${id}`;

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?|\.\d+`;
const PERCENT = new RegExp(String.raw`[-−]?(?:${NUMBER})\s*(?:%|per\s*cent\b)`, "gi");
const TOTAL = "a total has to add up every amount printed before it in its row or column, and be the last amount there; otherwise the cells may only happen to add up.";
const MARKED = (id: string) => `${id} is handwritten, struck out or initialed, so a person checks it: arithmetic can't prove it.`;
const ALIGNED = "the result and the cells it is made of have to be in one printed row or one printed column of one table, with the result after them (a row total, a column total, or a fee followed by the fee with overhead).";

/** A rate as printed, exactly: `units` in its last printed digit, so 12.5% is 125 at scale 1. */
interface Rate {
  units: bigint;
  scale: number;
  percent: boolean;
}

function formula(r: Relation): string {
  if (r.kind === "same") return `${r.result} = ${r.operands.join(" = ")}`;
  if (r.kind === "product") return `${r.result} = ${[...r.operands, ...(r.rate ? [r.rate] : [])].join(" × ")}`;
  return `${r.result} = ${r.operands.join(" + ")}${r.rate ? ` plus ${r.rate} on top` : ""}`;
}

function amountOf(cell: ScanCell): number | string {
  if (isMarked(cell)) return MARKED(cell.id);
  const amounts = amountsIn(cell.text);
  const cents = amounts.length === 1 ? amounts[0]! : amounts.length ? null : parseCents(cell.text);
  return cents ?? `${cell.id} prints "${cell.text}", not one amount.`;
}

// a line prints its rate among words ("overhead of 30% is added"); a cell prints it bare ("30%", "8.00")
function rateText(cell: ScanCell) {
  const percents = cell.text.match(PERCENT) ?? [];
  return { printed: percents.length === 1 ? percents[0]! : cell.text, percent: percents.length > 0 };
}

// a bare amount ("300.00") looks like a count too; counting it as a rate only refuses more
const looksLikeRate = (cell: ScanCell) => parsePercent(rateText(cell).printed) !== null;

function rateOf(cell: ScanCell): Rate | string {
  if (isMarked(cell)) return MARKED(cell.id);
  const { printed, percent } = rateText(cell);
  const value = parsePercent(printed);
  if (value === null) return `${cell.id} prints "${cell.text}", not one percent or count.`;
  if (value <= 0) return `${cell.id} prints "${cell.text}", and a rate has to be above zero.`;
  const [whole = "", decimals = ""] = new RegExp(NUMBER).exec(printed)![0].replace(/,/g, "").split(".");
  const units = BigInt((whole || "0") + decimals);
  // the digits counted have to be the number parsePercent read, not another one printed beside it ("Year 2 (3)")
  if (Number(units) / 10 ** decimals.length !== value) return `${cell.id} prints "${cell.text}", not one percent or count.`;
  return { units, scale: decimals.length, percent };
}

const isAmount = (cell: ScanCell) => amountsIn(cell.text).length > 0 || parseCents(cell.text) !== null;

/** Why the operands of a sum of two or more cells aren't every amount before the result in its row or column, or the result isn't the last. */
function partial(doc: LoadedDoc, result: ScanCell, operands: ScanCell[]): string | null {
  const inRow = operands.every((c) => c.row === result.row);
  const line = (cellsOn(doc, result.page) ?? []).filter(
    (c) => c.table === result.table && c.row !== null && c.col !== 0 && (inRow ? c.row === result.row : c.col === result.col) && isAmount(c),
  );
  const at = (c: ScanCell) => (inRow ? c.col! : c.row!);
  const before = line.filter((c) => at(c) < at(result)).map((c) => c.id).sort();
  const covered = before.join() === operands.map((c) => c.id).sort().join();
  return covered && line.every((c) => at(c) <= at(result)) ? null : TOTAL;
}

/** n / d rounded half up to a multiple of `step` cents. */
function rounded(n: bigint, d: bigint, step: bigint): number {
  const sign = n < 0n ? -1n : 1n;
  const abs = n * sign;
  return Number(sign * ((2n * abs + d * step) / (2n * d * step)) * step);
}

/** What the arithmetic gives, as a fraction n / d of cents, so no float rounding decides a cent. */
function fraction(kind: Relation["kind"], operands: number[], rate: Rate | null): [bigint, bigint] {
  const sum = BigInt(operands.reduce((a, b) => a + b, 0));
  if (!rate) return [sum, 1n];
  const base = 10n ** BigInt(rate.scale) * (rate.percent ? 100n : 1n);
  return kind === "sum" ? [sum * (base + rate.units), base] : [sum * rate.units, base];
}

/**
 * Whether the result is what the arithmetic gives, half up to the cent, or with `dollars` to the dollar, which a result
 * printed in whole dollars may be (and which a few cents' error in an operand also passes).
 */
function holds(kind: Relation["kind"], result: number, operands: number[], rate: Rate | null, dollars = false): boolean {
  const [n, d] = fraction(kind, operands, rate);
  return dollars ? result % 100 === 0 && result === rounded(n, d, 100n) : result === rounded(n, d, 1n);
}

/** Every rulebook value that cites a cell, in words. */
function citersOf(rulebook: Rulebook, doc: string, id: string): string[] {
  return [
    ...rulebook.terms.filter((t) => t.source.doc === doc).flatMap((t) => [...(t.source.cell === id ? [`term ${t.id}`] : []), ...(t.source.capCell === id ? [`the cap of term ${t.id}`] : [])]),
    ...rulebook.grids.filter((g) => g.doc === doc).flatMap((g) => Object.entries(g.cellIds ?? {}).flatMap(([path, cell]) => (cell === id ? [`grid ${g.id} at ${path}`] : []))),
  ];
}

/** Why the cells can't be read as one printed row or column, or the rate is on another page; null when they line up. */
function misaligned(r: Relation, result: ScanCell, operands: ScanCell[], rate: ScanCell | undefined): string | null {
  if (r.kind === "same") {
    // each page is transcribed in its own call; one call can repeat a misread
    const page = operands[0]!.page;
    return page === result.page ? `both cells are on p.${page}, which was read in one go, so one misread could repeat in both: 'same' proves only one value printed on two different pages.` : null;
  }
  const cells = [result, ...operands];
  const oneTable = cells.every((c) => c.row !== null && c.page === result.page && c.table === result.table);
  const inRow = cells.every((c) => c.row === result.row);
  // a total is printed after its parts; a "total" printed before them is more likely a coincidence of unrelated cells
  const after = inRow ? operands.every((c) => c.col! < result.col!) : cells.every((c) => c.col === result.col) && operands.every((c) => c.row! < result.row!);
  if (!oneTable || !after) return ALIGNED;
  return rate && rate.page !== result.page ? `the rate ${r.rate} is on p.${rate.page}: use one printed on p.${result.page}, the page of the result.` : null;
}

/** `dollarTable`: the table (doc:p1.t2) whose result this relation could only match rounded to the dollar. */
export type Evaluated = { proven: string[]; dollarTable?: string } | { problem: string };

/**
 * A relation evaluated on the transcribed cells. When it holds, it proves the cells a one-cent change (or one in a rate's
 * last printed digit) would break it for: a misread of any other cell would pass it unnoticed. `dollarTables` are the
 * tables another relation showed to round to the dollar.
 */
export function evaluateRelation(r: Relation, rulebook: Rulebook, docs: LoadedDoc[], dollarTables = new Set<string>()): Evaluated {
  const why = (reason: string) => ({ problem: `${formula(r)}: ${reason}` });
  const doc = docs.find((d) => d.name === r.doc);
  if (!doc) return why(`there is no document called "${r.doc}".`);
  const ids = [r.result, ...r.operands, ...(r.rate ? [r.rate] : [])];
  const missing = ids.find((id) => !cellOf(doc, id));
  if (missing !== undefined) return why(`${doc.name} has no cell or line called ${missing}. A relation is made of cell ids as read_pages shows them, never typed numbers.`);
  if (new Set(ids).size < ids.length) return why(`a relation needs different cells${r.kind === "same" ? "; 'same' is for one fee printed in two different places" : ""}.`);
  if (r.kind === "same" && (r.operands.length !== 1 || r.rate)) return why("'same' takes one other cell and no rate.");
  if (r.kind === "product" && (r.operands.length !== 1 || !r.rate)) return why("a product takes one cell and a rate: the cell printing the count or percent it is multiplied by.");
  if (r.kind === "sum" && r.operands.length < 2 && !r.rate) return why("a sum adds two or more cells, or one cell and a rate on top.");
  const rateCell = r.rate ? cellOf(doc, r.rate) : undefined;
  const resultCell = cellOf(doc, r.result)!;
  const operandCells = r.operands.map((id) => cellOf(doc, id)!);
  const off = misaligned(r, resultCell, operandCells, rateCell) ?? (r.operands.length > 1 ? partial(doc, resultCell, operandCells) : null);
  if (off) return why(off);

  const amounts = [r.result, ...r.operands].map((id) => amountOf(cellOf(doc, id)!));
  const bad = amounts.find((a) => typeof a === "string");
  if (bad !== undefined) return why(bad);
  const [result, ...operands] = amounts as [number, ...number[]];
  if (result === 0) return why(`${r.result} prints $0.00, and a zero total proves nothing.`);

  if (r.kind === "same") {
    if (result !== operands[0]) return why(`${r.result} prints ${usd(result)} but ${r.operands[0]} prints ${usd(operands[0]!)}.`);
    const values = new Set([r.result, r.operands[0]!].flatMap((id) => citersOf(rulebook, doc.name, id)));
    if (!values.size) return why("no rulebook value cites either cell; 'same' proves the one value that cites one of them, so write that first.");
    // one value printed twice is two reads of it; two values that print one amount prove nothing about each other
    if (values.size > 1) return why(`these cells are cited by different rulebook values (${[...values].join(", ")}); 'same' only shows one value printed twice.`);
    return { proven: [r.result, r.operands[0]!] };
  }
  // a product by 1 or a sum that adds nothing is 'same' in disguise, without its rules
  if (operands.includes(result)) return why(`${r.result} prints the same amount as a cell it is made of, so nothing is checked; for one fee printed twice use 'same'.`);

  const rate = rateCell ? rateOf(rateCell) : null;
  if (typeof rate === "string") return why(rate);
  if (rate && !rate.percent && r.kind === "sum") return why(`${r.rate} prints "${rateCell!.text}", not a percent: a sum adds a percent on top; for a quantity use a product.`);
  if (rateCell && rateCell.table !== null) {
    // a rate in a table belongs to one line of it; a line of text states a rule for the page
    const inRow = operandCells.every((c) => c.row === resultCell.row);
    // a bare number heading a column is a visit or year number, never a quantity
    const heading = rate!.percent && rateCell.row === null && rateCell.col === resultCell.col;
    const line = rateCell.row === resultCell.row || (!inRow && rateCell.col === resultCell.col);
    if (rateCell.table !== resultCell.table || !(heading || line)) {
      return why(`the rate ${r.rate} has to be printed in the result's own row (or its column, in a table printed sideways), in its column's heading, or in a line of text on the page.`);
    }
    const alongRow = rateCell.row === resultCell.row;
    const between = (x: number | null, a: number, b: number) => x !== null && x > Math.min(a, b) && x < Math.max(a, b);
    const past = (cellsOn(doc, resultCell.page) ?? []).find(
      (c) => c.table === resultCell.table && (alongRow ? c.row === resultCell.row && between(c.col, rateCell.col!, resultCell.col!) : c.col === resultCell.col && between(c.row, rateCell.row ?? 0, resultCell.row!)) && looksLikeRate(c),
    );
    if (past) return why(`another rate (${past.id}) is printed between ${r.rate} and the result: use the rate on the result's line nearest to it.`);
  }
  const table = `${r.doc}:${/^p\d+\.t\d+/.exec(r.result)![0]}`;
  const toTheDollar = !holds(r.kind, result, operands, rate);
  if (toTheDollar && !holds(r.kind, result, operands, rate, true)) {
    const want = rounded(...fraction(r.kind, operands, rate), 1n);
    return { problem: `${formula(r)} doesn't hold: the cells it is made of come to ${usd(want)}, but ${r.result} prints ${usd(result)}.` };
  }
  // a table that rounds one result to the dollar may round them all: a round result's cent match is then no proof of its operands
  const dollars = toTheDollar || (result % 100 === 0 && dollarTables.has(table));

  const breaks = (nudged: (by: number) => boolean) => !nudged(1) && !nudged(-1);
  const proven = [
    ...(breaks((by) => holds(r.kind, result + by, operands, rate, dollars)) ? [r.result] : []),
    // rounded to the dollar, an operand a few cents off rounds the same, so the operands rest on the result's rounding alone
    ...(dollars ? [] : r.operands.filter((_, i) => breaks((by) => holds(r.kind, result, operands.map((o, j) => (j === i ? o + by : o)), rate)))),
    ...(rate && breaks((by) => holds(r.kind, result, operands, { ...rate, units: rate.units + BigInt(by) }, dollars)) ? [r.rate!] : []),
  ];
  return { proven, ...(toTheDollar && { dollarTable: table }) };
}

/** What a holding relation proved, in words for the agent. */
export function provenText(r: Relation, proven: string[]): string {
  const ids = [r.result, ...r.operands, ...(r.rate ? [r.rate] : [])];
  if (proven.length === ids.length) return `${formula(r)} proves all ${ids.length} of its cells.`;
  const left = ids.filter((id) => !proven.includes(id));
  const which = proven.length ? ` (${proven.join(", ")})` : "";
  return `${formula(r)} proves ${proven.length} of its ${ids.length} cells${which}: it would still hold with ${left.join(", ")} misread by a cent (or a rate by its last digit), so those need other proof.`;
}

/**
 * The cells (by cellKey) that a holding relation proves, and why each other relation proves nothing; `outcomes` follows the
 * rulebook's relations one for one.
 */
export function checkRelations(rulebook: Rulebook, docs: LoadedDoc[]): { proven: Set<string>; problems: Problem[]; outcomes: Evaluated[] } {
  const relations = rulebook.relations ?? [];
  const first = relations.map((r) => evaluateRelation(r, rulebook, docs));
  const dollarTables = new Set(first.flatMap((out) => ("dollarTable" in out && out.dollarTable ? [out.dollarTable] : [])));
  const outcomes = dollarTables.size ? relations.map((r) => evaluateRelation(r, rulebook, docs, dollarTables)) : first;
  const proven = new Set<string>();
  const problems: Problem[] = [];
  outcomes.forEach((out, i) => {
    const doc = relations[i]!.doc;
    if ("problem" in out) problems.push({ check: "relation", doc, message: out.problem });
    else for (const id of out.proven) proven.add(cellKey(doc, id));
  });
  return { proven, problems, outcomes };
}

/**
 * The rulebook with evidence "math" on each scanned term whose cited cells (the amount's, and an amount cap's) a holding
 * relation proves, and without it on a term whose cited cell is in a relation that no longer proves it.
 */
export function withRelationProof(rulebook: Rulebook, docs: LoadedDoc[], proven = checkRelations(rulebook, docs).proven): Rulebook {
  const at = (doc: string, id: string | undefined) => id !== undefined && proven.has(cellKey(doc, id));
  // a "math" on a term no relation touches was earned some other way, and isn't this function's to take back
  const related = new Set((rulebook.relations ?? []).flatMap((r) => [r.result, ...r.operands].map((id) => cellKey(r.doc, id))));
  const terms = rulebook.terms.map((t) => {
    const { doc, cell, capCell } = t.source;
    const capped = t.cap?.kind === "amount" && t.cap.value !== null;
    const math = t.amountCents !== null && at(doc, cell) && (!capped || at(doc, capCell)) && !citeTerm(t, docs).length;
    if (t.evidence === "none" && math) return { ...t, evidence: "math" as const };
    const stale = t.evidence === "math" && !math && cell !== undefined && related.has(cellKey(doc, cell));
    return stale ? { ...t, evidence: "none" as const } : t;
  });
  return { ...rulebook, terms };
}

/** A grid's unproven cells without those whose cited cell a holding relation proves. A grid whose citations fail keeps them all. */
export function lessRelationProven(g: Grid, result: GridResult, proven: Set<string>, docs: LoadedDoc[]): GridResult {
  if (!g.cellIds || citeGrid(g, docs).length) return result;
  const byRelation = (row: number, col: number) => {
    const id = g.cellIds?.[`rows.${row}.cells.${col}`];
    return typeof id === "string" && proven.has(cellKey(g.doc, id));
  };
  return { ...result, unproven: result.unproven.filter(({ row, col }) => !byRelation(row, col)) };
}
