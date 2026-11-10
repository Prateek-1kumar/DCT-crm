"use client";

import type { Cell, Grid } from "@dct/shared";
import { cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { calculatedTotals, gridRowMatches } from "./model";

const stickyHead = "sticky left-0 z-30 bg-sunken px-5 py-3 text-left font-medium print:static";
const stickyCell = "sticky left-0 z-10 bg-surface px-5 py-2.5 text-left font-normal print:static";
const CALCULATED = "Calculated by adding up the amounts shown. The contract doesn't print this total.";

function Pill({ children }: { children: string }) {
  return <span className="inline-flex h-6 items-center rounded-full bg-ink/[0.06] px-2.5 text-small text-muted">{children}</span>;
}

const show = (cell: Cell) => (typeof cell === "number" ? formatCents(cell) : cell);

/**
 * `proofread` / `doubtful`: "row:col" keys of item cells a person proofread, or that were missed or flagged when the page was checked.
 * `query` narrows the items to those it matches (all stay when it matches none: the grid was then found by its name or a visit);
 * `unreadOnly` keeps the items with an amount nobody has proofread.
 */
export function GridTable({ grid, selected, onCellClick, proofread, doubtful, query = "", unreadOnly }: { grid: Grid; selected?: { row: number; col: number } | null; onCellClick?: (row: number, col: number) => void; proofread?: Set<string>; doubtful?: Set<string>; query?: string; unreadOnly?: boolean }) {
  const calc = calculatedTotals(grid);
  const hits = grid.rows.map((r) => gridRowMatches(r, query));
  const narrowed = hits.some(Boolean) && !hits.every(Boolean);
  // the row's own index is kept: it is what a click, a proofread mark and a doubt are keyed by
  const shown = grid.rows
    .map((row, r) => ({ row, r }))
    .filter(({ row, r }) => (!narrowed || hits[r]) && (!unreadOnly || row.cells.some((c, col) => typeof c === "number" && !proofread?.has(`${r}:${col}`))));
  const lines: { label: string; cells: Cell[]; total?: number | null; strong?: boolean }[] = [];
  if (grid.subtotal) lines.push({ label: "Subtotal", cells: grid.subtotal });
  if (grid.overhead) lines.push({ label: grid.overheadPct === null ? "Overhead" : `Overhead (${grid.overheadPct}%)`, cells: grid.overhead });
  for (const a of grid.additions) lines.push({ label: a.name, cells: a.cells });
  if (grid.total || grid.grandTotalCents !== null) lines.push({ label: "Total", cells: grid.total ?? [], total: grid.grandTotalCents, strong: true });

  const cell = (value: Cell, row: number, col: number, label: string) => {
    const on = selected?.row === row && selected.col === col;
    const text = show(value);
    const content = typeof value === "string" ? <Pill>{value}</Pill> : text;
    const key = `${row}:${col}`;
    const checked = proofread?.has(key);
    const doubt = doubtful?.has(key);
    return (
      <td key={col} title={doubt ? "Doubtful: this amount was missed or couldn't be read clearly. Check it against the contract." : checked ? "Proofread" : undefined} className={cx("px-2 py-1.5 text-right", doubt && "bg-warn-soft", on && "bg-brand-soft")}>
        {checked && <span className="sr-only">Proofread. </span>}
        {doubt && <span className="sr-only">Doubtful. </span>}
        {onCellClick && text !== null ? (
          <button
            type="button"
            aria-label={`${label}, ${grid.visits[col]}: ${text}`}
            aria-pressed={on}
            onClick={() => onCellClick(row, col)}
            className={cx("w-full rounded-[8px] px-3 py-1 text-right hover:bg-brand-soft", checked && "bg-ok-soft text-ok", on && "ring-2 ring-brand")}
          >
            {content}
          </button>
        ) : (
          <span className={cx("block px-3 py-1", checked && "text-ok")}>{content}</span>
        )}
      </td>
    );
  };

  return (
    // Its own scroll box in both directions: a wide grid never widens the page, and the item column and the visit headers stay in view.
    <div className="max-h-[70vh] max-w-full overflow-auto print:max-h-none print:overflow-visible">
      <table className="w-max min-w-full text-body print:w-full print:text-[8px] print:[&_td]:px-0.5 print:[&_th]:px-1">
        <caption className="sr-only">{grid.name}</caption>
        <thead className="sticky top-0 z-20 bg-sunken text-small text-muted print:static">
          <tr>
            <th scope="col" className={stickyHead}>
              Item
            </th>
            {grid.visits.map((v) => (
              <th key={v} scope="col" className="px-4 py-3 text-right font-medium whitespace-nowrap">
                {v}
              </th>
            ))}
            <th scope="col" className="px-5 py-3 text-right font-medium whitespace-nowrap">
              Item total
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {shown.length === 0 && (
            <tr>
              <td colSpan={grid.visits.length + 2} className="px-5 py-6 text-center text-muted">
                Every item in this grid has been proofread.
              </td>
            </tr>
          )}
          {shown.map(({ row, r }) => (
            <tr key={r}>
              <th scope="row" className={stickyCell}>
                <span className="block max-w-[28ch] font-medium break-words">{row.name}</span>
                {(row.code || row.unitCostCents !== null) && (
                  <span className="num text-small text-faint">{[row.code, row.unitCostCents !== null && formatCents(row.unitCostCents)].filter(Boolean).join(" · ")}</span>
                )}
              </th>
              {grid.visits.map((_, c) => cell(row.cells[c] ?? null, r, c, row.name))}
              <td className="num px-5 py-2.5 text-right whitespace-nowrap">
                {row.printedRowTotalCents !== null ? (
                  formatCents(row.printedRowTotalCents)
                ) : calc.rows[r] !== null ? (
                  <span title={CALCULATED} className="text-muted italic">
                    {formatCents(calc.rows[r])} <span className="text-small not-italic">calculated</span>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
          {calc.visits && !narrowed && !unreadOnly && (
            <tr title={CALCULATED} className="bg-sunken/60 text-muted italic">
              <th scope="row" className={cx(stickyCell, "bg-sunken font-medium")}>
                Calculated total <span className="block text-small font-normal not-italic">Not printed in the contract</span>
              </th>
              {calc.visits.map((v, c) => (
                <td key={c} className="num px-5 py-2.5 text-right whitespace-nowrap">
                  {v !== null && formatCents(v)}
                </td>
              ))}
              <td />
            </tr>
          )}
          {lines.map((line, l) => (
            <tr key={`line${l}`} className={cx("bg-sunken/60", line.strong && "font-semibold")}>
              <th scope="row" className={cx(stickyCell, "bg-sunken", line.strong ? "font-semibold" : "font-medium")}>
                {line.label}
              </th>
              {grid.visits.map((_, c) => cell(line.cells[c] ?? null, -1, c, line.label))}
              <td className="num px-5 py-2.5 text-right whitespace-nowrap">{line.total != null && formatCents(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
