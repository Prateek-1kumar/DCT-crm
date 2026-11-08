import type { Evidence } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { CoverageRef } from "@/lib/types";
import { itemsOf } from "../contract/proofreads";
import { gridProof } from "../rulebook/model";
import { BILLING_LABEL, capText } from "../rulebook/terms";
import { decidedBy, findGrid, findTerm, type ProofData } from "./model";
import type { Line } from "./lines";

/** What the claim strip says about the selected item, in words. */
export interface Claim {
  name: string;
  value: string;
  evidence: Evidence | null;
  /** The words quoted from the contract; null for a grid, which has no quote. */
  quote: string | null;
  /** Where the claim was read from. */
  page: number | null;
  doc: string;
  /** The "Details" disclosure: label and value pairs, empty ones left out. */
  details: { label: string; value: string }[];
  /** What a proofread mark is stored under: the term, or the grid cell the person is looking at, or every cell of the grid. */
  items: string[];
}

const some = (rows: [string, string | null | undefined][]) => rows.flatMap(([label, value]) => (value ? [{ label, value }] : []));

/**
 * The claim for one line. `ref` is the finer pick a link can carry (one grid cell); when it names a cell of this line's
 * grid the claim is that cell, otherwise it is the line itself.
 */
export function claimOf(data: ProofData, line: Line, ref: CoverageRef | null): Claim {
  if (line.ref.target === "term") {
    const t = findTerm(data, line.ref.id);
    if (!t) return { name: line.name, value: line.value, evidence: line.evidence, quote: null, page: null, doc: "the contract", details: [], items: line.items };
    return {
      name: t.name,
      value: line.value,
      evidence: t.evidence,
      quote: t.source.quote,
      page: t.source.page,
      doc: t.source.doc,
      details: some([
        ["Conditions", [t.trigger, t.conditions].filter(Boolean).join(" · ")],
        ["How it is paid", BILLING_LABEL[t.billing]],
        ["Cap", t.cap ? capText(t.cap) : null],
        ["Deadline", t.deadline],
        ["Decided by", t.evidence === "person" ? decidedBy(data, line.ref) : null],
      ]),
      items: line.items,
    };
  }

  const g = findGrid(data, line.ref.id);
  const cell = ref && ref.target === "grid" && ref.id === line.ref.id && ref.row >= 0 ? ref : null;
  const row = cell && g?.rows[cell.row];
  const budget = g ? (g.arm ? `${g.name} · ${g.arm}` : g.name) : line.name;
  const where = { page: g?.pages[0] ?? null, doc: g?.doc ?? "the contract" };
  if (g && cell && row) {
    const v = row.cells[cell.col];
    const decided = decidedBy(data, cell);
    const twice = g.cellsReadTwice.some(([r, c]) => r === cell.row && c === cell.col);
    return {
      name: `${row.name}, ${g.visits[cell.col] ?? "a visit"}`,
      value: typeof v === "number" ? formatCents(v) : (v ?? "blank"),
      evidence: decided ? "person" : twice ? "two_reads" : gridProof(g, data.version),
      quote: null,
      ...where,
      details: some([["Budget grid", budget], ["Decided by", decided]]),
      items: itemsOf(data.rulebook, cell),
    };
  }
  return {
    name: line.name,
    value: line.value,
    evidence: line.evidence,
    quote: null,
    ...where,
    details: some([["Budget grid", budget], ["Pages", g?.pages.join(", ")], ["Decided by", decidedBy(data, line.ref)]]),
    items: line.items,
  };
}

/** "Page 18 · Contract.pdf", or just the file when the page isn't known. */
export const sourceText = (c: Pick<Claim, "page" | "doc">) => (c.page ? `Page ${c.page} · ${c.doc}` : c.doc);
