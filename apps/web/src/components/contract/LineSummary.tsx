import type { ReactNode } from "react";
import type { Evidence } from "@dct/shared";
import { formatCents } from "@/lib/money";
import type { CoverageRef } from "@/lib/types";
import { BILLING_LABEL, termValue } from "../rulebook";
import { gridProof } from "../rulebook/model";
import { ProofBadge } from "../rulebook/parts";
import { decidedBy, findGrid, findTerm, type ProofData } from "../proof/model";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-body break-words text-ink">{children}</dd>
    </div>
  );
}

/** What a line of the rulebook says, in words: its name, value, proof, and the quote it was taken from. */
export function LineSummary({ data, line }: { data: ProofData; line: CoverageRef }) {
  const term = line.target === "term" ? findTerm(data, line.id) : undefined;
  if (term) {
    const decided = term.evidence === "person" ? decidedBy(data, line) : null;
    const conditions = [term.trigger, term.conditions].filter(Boolean).join(" · ");
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="min-w-0 text-title font-semibold tracking-tight break-words">{term.name}</h3>
          <ProofBadge evidence={term.evidence} />
        </div>
        <dl className="grid gap-3">
          <Row label="Value">{termValue(term)}</Row>
          <Row label="How it is paid">{BILLING_LABEL[term.billing]}</Row>
          {conditions && <Row label="Conditions">{conditions}</Row>}
          {decided && <Row label="Decided by">{decided}</Row>}
          <Row label="In the contract">
            <q>{term.source.quote}</q>
            <span className="block text-small text-muted">
              {term.source.doc}, page {term.source.page}
            </span>
          </Row>
        </dl>
      </div>
    );
  }

  const grid = line.target === "grid" ? findGrid(data, line.id) : undefined;
  if (!grid || line.target !== "grid") return <p className="text-body text-muted">This line is no longer in the rulebook.</p>;
  const row = grid.rows[line.row];
  const cell = row?.cells[line.col];
  const decided = row ? decidedBy(data, line) : null;
  const twice = grid.cellsReadTwice.some(([r, c]) => r === line.row && c === line.col);
  const evidence: Evidence = decided ? "person" : twice ? "two_reads" : gridProof(grid, data.version);
  const shown = typeof cell === "number" ? formatCents(cell) : (cell ?? "blank");
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 text-title font-semibold tracking-tight break-words">{row ? `${row.name}, ${grid.visits[line.col] ?? "a visit"}` : grid.name}</h3>
        <ProofBadge evidence={evidence} />
      </div>
      <dl className="grid gap-3">
        <Row label="Budget">{grid.arm ? `${grid.name} · ${grid.arm}` : grid.name}</Row>
        {row ? <Row label="Value">{shown}</Row> : <Row label="Shows">{grid.grandTotalCents === null ? "The whole budget" : `The whole budget, ${formatCents(grid.grandTotalCents)} per patient`}</Row>}
        {decided && <Row label="Decided by">{decided}</Row>}
        <Row label="In the contract">
          {grid.doc}, page {grid.pages.join(", ")}
        </Row>
      </dl>
    </div>
  );
}

