"use client";

import type { Grid } from "@dct/shared";
import { Card, Empty } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { GridTable } from "./GridTable";
import { doubtfulCells, gridMatches, gridProof, gridProofreads, gridsNeedingDecision, proofreadCells, type TabProps } from "./model";
import { DecisionPill, ProofBadge } from "./parts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function GridCard({ grid, decision, version, coverage, onShow, query, unreadOnly }: { grid: Grid; decision: boolean } & Pick<TabProps, "version" | "coverage" | "onShow" | "query" | "unreadOnly">) {
  const { names, cells } = gridProofreads(version, grid.id);
  const doubtful = doubtfulCells(coverage, grid.id);
  return (
    <Card className="min-w-0 overflow-hidden print:overflow-visible print:shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 pt-5 pb-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-title font-semibold tracking-tight break-words">{grid.arm ?? grid.name}</h2>
          <p className="mt-0.5 text-small text-muted break-words">
            {[grid.arm && grid.name !== grid.arm && grid.name, `${grid.doc}, page${grid.pages.length === 1 ? "" : "s"} ${grid.pages.join(", ")}`, plural(grid.visits.length, "visit")].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <p className="num text-heading font-semibold tracking-tight">
            {grid.grandTotalCents === null ? "No total printed" : formatCents(grid.grandTotalCents)}
            {grid.grandTotalCents !== null && <span className="ml-1.5 text-small font-normal text-muted">per patient</span>}
          </p>
          <p className="text-small text-muted">{grid.overheadPct === null ? "No overhead rate printed" : `Overhead ${grid.overheadPct}%`}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-sunken/60 px-5 py-2.5 text-small text-muted sm:px-6">
        <ProofBadge evidence={gridProof(grid, version)} />
        {decision && <DecisionPill />}
        <span>{cells ? `${plural(cells, "cell")} proofread${names.length ? ` by ${names.join(", ")}` : ""}` : "No cells proofread yet"}</span>
        {doubtful.size > 0 && <span className="font-medium text-warn">{plural(doubtful.size, "cell")} to double-check</span>}
      </div>
      <GridTable grid={grid} query={query} unreadOnly={unreadOnly} proofread={proofreadCells(version, grid.id)} doubtful={doubtful} onCellClick={(row, col) => onShow({ target: "grid", id: grid.id, row, col })} />
    </Card>
  );
}

/** Each grid by arm: the per-patient total, the overhead rate, proof status, and the grid itself in its own scroll box. */
export function BudgetGridTab({ version, coverage, query, unreadOnly, onShow }: TabProps) {
  const rulebook = version.rulebook;
  if (!rulebook) return <Empty title="Nothing to show yet">The budget grids appear here once the contract has been read.</Empty>;
  if (!rulebook.grids.length) return <Empty title="No budget grid found in this contract">The contract has no table of visits and prices. Fees that aren&apos;t tied to a visit are under Fees &amp; invoiceables.</Empty>;

  const grids = rulebook.grids.filter((g) => gridMatches(g, query));
  if (!grids.length) return <Empty title={`Nothing matches “${query.trim()}”`}>Try a different word or amount, or clear the search.</Empty>;

  const decision = gridsNeedingDecision(rulebook);
  return (
    <div className="grid min-w-0 gap-6">
      {grids.map((g) => (
        <GridCard key={g.id} grid={g} decision={decision.has(g.id)} version={version} coverage={coverage} onShow={onShow} query={query} unreadOnly={unreadOnly} />
      ))}
    </div>
  );
}
