"use client";

import type { Grid, Term } from "@dct/shared";
import type { ReactNode } from "react";
import { formatCents } from "@/lib/money";
import type { CoverageAmount, CoverageRef } from "@/lib/types";
import { BILLING_LABEL, EVIDENCE_LABEL, GridTable, termValue } from "@/components/rulebook";
import { Badge, Button, Card } from "../ui";
import { decidedBy, DOUBT_WORDS, findGrid, findTerm, groupTitle, STATUS, type ProofData } from "./model";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="text-body text-ink">{children}</dd>
    </div>
  );
}

function TermDetail({ data, term }: { data: ProofData; term: Term }) {
  const decided = term.evidence === "person" ? decidedBy(data, { target: "term", id: term.id }) : null;
  const conditions = [term.trigger, term.conditions].filter(Boolean).join(" · ");
  return (
    <dl className="grid gap-3">
      <Row label="Rulebook line">{term.name}</Row>
      <Row label="Kind of payment">{groupTitle(term.category)}</Row>
      <Row label="Value">{termValue(term)}</Row>
      <Row label="Billing">{BILLING_LABEL[term.billing]}</Row>
      {conditions && <Row label="Conditions">{conditions}</Row>}
      <Row label="In the contract">
        <q>{term.source.quote}</q>
        <span className="block text-small text-muted">
          {term.source.doc}, page {term.source.page}
        </span>
      </Row>
      <Row label="Proof">{decided ? `Decided by ${decided}` : EVIDENCE_LABEL[term.evidence]}</Row>
    </dl>
  );
}

const cellText = (c: Grid["rows"][number]["cells"][number]) => (typeof c === "number" ? formatCents(c) : (c ?? "blank"));

function GridDetail({ data, grid, cell }: { data: ProofData; grid: Grid; cell: { row: number; col: number } }) {
  const row = grid.rows[cell.row];
  const decided = decidedBy(data, { target: "grid", id: grid.id, ...cell });
  const twice = grid.cellsReadTwice.some(([r, c]) => r === cell.row && c === cell.col);
  return (
    <div className="grid gap-3">
      <dl className="grid gap-3">
        <Row label="Budget">{grid.name}</Row>
        <Row label="Item">{row ? row.name : "A total line"}</Row>
        <Row label="Visit">{grid.visits[cell.col] ?? "—"}</Row>
        {row && <Row label="Value">{cellText(row.cells[cell.col] ?? null)}</Row>}
        <Row label="Proof">{decided ? `Decided by ${decided}` : twice ? EVIDENCE_LABEL.two_reads : EVIDENCE_LABEL.math}</Row>
      </dl>
      <div className="overflow-x-auto">
        <GridTable grid={grid} selected={cell} />
      </div>
    </div>
  );
}

function LineDetail({ data, line }: { data: ProofData; line: CoverageRef }) {
  const term = line.target === "term" ? findTerm(data, line.id) : undefined;
  const grid = line.target === "grid" ? findGrid(data, line.id) : undefined;
  if (term) return <TermDetail data={data} term={term} />;
  if (grid && line.target === "grid") return <GridDetail data={data} grid={grid} cell={line} />;
  return <p className="text-body text-muted">This line is no longer in the rulebook.</p>;
}

export function DetailPanel({ data, amount, line, onShowInRulebook }: { data: ProofData; amount?: CoverageAmount; line: CoverageRef | null; onShowInRulebook: () => void }) {
  const shown = amount?.status === "missing" || amount?.status === "set_aside" ? null : line;
  return (
    <Card className="p-5">
      <h2 className="text-title font-semibold tracking-tight">What this became</h2>
      <div className="mt-4 grid gap-4" aria-live="polite">
        {!amount && !line && <p className="text-body text-muted">Click an amount or a piece of rule wording on the contract to see where it went in the rulebook.</p>}
        {amount && (
          <div className="flex items-center gap-3">
            <span className="num text-heading font-semibold">{amount.text}</span>
            <Badge tone={STATUS[amount.status].tone}>{STATUS[amount.status].proof}</Badge>
            {amount.doubt && <Badge tone="warn">{DOUBT_WORDS[amount.doubt]}</Badge>}
          </div>
        )}
        {amount?.status === "missing" && (
          <p role="alert" className="rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
            Not in the rulebook yet: this needs a look before approval. The contract prints {amount.text} here, but no line in the rulebook accounts for it.
          </p>
        )}
        {amount?.status === "set_aside" && <p className="text-body text-ink-2">{amount.reason ?? "No reason was recorded."}</p>}
        {shown && <LineDetail data={data} line={shown} />}
        {shown && (
          <Button size="sm" onClick={onShowInRulebook} className="justify-self-start">
            Show in rulebook
          </Button>
        )}
      </div>
    </Card>
  );
}
