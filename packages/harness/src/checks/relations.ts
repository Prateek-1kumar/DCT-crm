import { parseCents, parsePercent, type Relation, type Rulebook } from "@dct/shared";
import type { ScanCell } from "../scan/cells";
import type { GridResult, LoadedDoc, Problem } from "../types";
import { cellOf, citeGrid, citeTerm, isMarked } from "./cells";
import { ROUNDING_TOLERANCE_CENTS } from "./grid";
import { amountsIn, usd } from "./text";

type Grid = Rulebook["grids"][number];

/** Cell ids are only unique within a document, so a proven cell is keyed by both. */
export const cellKey = (doc: string, id: string) => `${doc}:${id}`;

const PERCENT = /[-−]?\d[\d,]*(?:\.\d+)?\s*(?:%|per\s*cent\b)/gi;
const MARKED = (id: string) => `${id} is handwritten, struck out or initialed, so a person checks it: arithmetic can't prove it.`;

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
function rateOf(cell: ScanCell): { value: number; percent: boolean } | string {
  if (isMarked(cell)) return MARKED(cell.id);
  const percents = cell.text.match(PERCENT) ?? [];
  const value = parsePercent(percents.length === 1 ? percents[0]! : cell.text);
  return value === null ? `${cell.id} prints "${cell.text}", not one percent or count.` : { value, percent: percents.length > 0 };
}

/** Every rulebook value that cites a cell, in words. */
function citersOf(rulebook: Rulebook, doc: string, id: string): string[] {
  return [
    ...rulebook.terms.filter((t) => t.source.doc === doc).flatMap((t) => [...(t.source.cell === id ? [`term ${t.id}`] : []), ...(t.source.capCell === id ? [`the cap of term ${t.id}`] : [])]),
    ...rulebook.grids.filter((g) => g.doc === doc).flatMap((g) => Object.entries(g.cellIds ?? {}).flatMap(([path, cell]) => (cell === id ? [`grid ${g.id} at ${path}`] : []))),
  ];
}

/** Why a relation proves nothing, in words for the agent, or null when it holds on the transcribed cells. */
export function checkRelation(r: Relation, rulebook: Rulebook, docs: LoadedDoc[]): string | null {
  const why = (reason: string) => `${formula(r)}: ${reason}`;
  const doc = docs.find((d) => d.name === r.doc);
  if (!doc) return why(`there is no document called "${r.doc}".`);
  const ids = [r.result, ...r.operands, ...(r.rate ? [r.rate] : [])];
  const missing = ids.find((id) => !cellOf(doc, id));
  if (missing !== undefined) return why(`${doc.name} has no cell or line called ${missing}. A relation is made of cell ids as read_pages shows them, never typed numbers.`);
  if (new Set(ids).size < ids.length) return why(`a relation needs different cells${r.kind === "same" ? "; 'same' is for one fee printed in two different places" : ""}.`);
  if (r.kind === "same" && (r.operands.length !== 1 || r.rate)) return why("'same' takes one other cell and no rate.");
  if (r.kind === "product" && (r.operands.length !== 1 || !r.rate)) return why("a product takes one cell and a rate: the cell printing the count or percent it is multiplied by.");
  if (r.kind === "sum" && r.operands.length < 2 && !r.rate) return why("a sum adds two or more cells, or one cell and a rate on top.");

  const amounts = [r.result, ...r.operands].map((id) => amountOf(cellOf(doc, id)!));
  const bad = amounts.find((a) => typeof a === "string");
  if (bad !== undefined) return why(bad);
  const [result, ...operands] = amounts as number[];

  if (r.kind === "same") {
    if (result !== operands[0]) return why(`${r.result} prints ${usd(result!)} but ${r.operands[0]} prints ${usd(operands[0]!)}.`);
    const values = new Set([r.result, r.operands[0]!].flatMap((id) => citersOf(rulebook, doc.name, id)));
    if (!values.size) return why("no rulebook value cites either cell; 'same' proves the one value that cites one of them, so write that first.");
    // one value printed twice is two reads of it; two values that print one amount prove nothing about each other
    if (values.size > 1) return why(`these cells are cited by different rulebook values (${[...values].join(", ")}); 'same' only shows one value printed twice.`);
    return null;
  }
  // a product by 1 or a sum that adds nothing is 'same' in disguise, without its rule
  if (operands.includes(result!)) return why(`${r.result} prints the same amount as a cell it is made of, so nothing is checked; for one fee printed twice use 'same'.`);

  let factor = 1;
  let tolerance = 0;
  if (r.rate) {
    const rate = rateOf(cellOf(doc, r.rate)!);
    if (typeof rate === "string") return why(rate);
    if (r.kind === "sum" && !rate.percent) return why(`${r.rate} is not a percent: a sum adds a percent on top.`);
    factor = r.kind === "sum" ? 1 + rate.value / 100 : rate.percent ? rate.value / 100 : rate.value;
    // only a percent leaves a fraction of a cent for the contract to round
    if (rate.percent) tolerance = ROUNDING_TOLERANCE_CENTS;
  }
  const want = Math.round(operands.reduce((a, b) => a + b, 0) * factor);
  if (Math.abs(result! - want) > tolerance) return `${formula(r)} doesn't hold: the cells it is made of come to ${usd(want)}, but ${r.result} prints ${usd(result!)}.`;
  return null;
}

/** The cells (by cellKey) that a holding relation proves, and why each other relation proves nothing. */
export function checkRelations(rulebook: Rulebook, docs: LoadedDoc[]): { proven: Set<string>; problems: Problem[] } {
  const proven = new Set<string>();
  const problems: Problem[] = [];
  for (const r of rulebook.relations ?? []) {
    const reason = checkRelation(r, rulebook, docs);
    if (reason) problems.push({ check: "relation", doc: r.doc, message: reason });
    else for (const id of [r.result, ...r.operands, ...(r.rate ? [r.rate] : [])]) proven.add(cellKey(r.doc, id));
  }
  return { proven, problems };
}

/** The rulebook with evidence "math" on each scanned term whose cited cells (the amount's, and an amount cap's) a holding relation proves. */
export function withRelationProof(rulebook: Rulebook, docs: LoadedDoc[], proven = checkRelations(rulebook, docs).proven): Rulebook {
  const at = (doc: string, id: string | undefined) => id !== undefined && proven.has(cellKey(doc, id));
  const terms = rulebook.terms.map((t) => {
    const { doc, cell, capCell } = t.source;
    const capped = t.cap?.kind === "amount" && t.cap.value !== null;
    if (t.evidence !== "none" || t.amountCents === null || !at(doc, cell) || (capped && !at(doc, capCell)) || citeTerm(t, docs).length) return t;
    return { ...t, evidence: "math" as const };
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
