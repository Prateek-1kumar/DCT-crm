"use client";

import type { BudgetGrid } from "@dct/shared";
import { useState } from "react";
import { formatCents } from "@/lib/money";
import { Badge, Button, ErrorNote, cx, inputCls } from "./ui";

/** Which cells differ between two grids (procedures matched by name, visits by code). */
export function gridDifferences(a: BudgetGrid, b: BudgetGrid) {
  const cells = new Set<string>();
  const units = new Set<string>();
  const totals = new Set<string>();
  const byName = (g: BudgetGrid) => new Map(g.procedures.map((p) => [p.name, p]));
  const pa = byName(a);
  const pb = byName(b);
  const codes = new Set([...a.visits, ...b.visits].map((v) => v.code));
  for (const name of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(name);
    const y = pb.get(name);
    if (x?.unitCents !== y?.unitCents) units.add(name);
    for (const c of codes) if (x?.cells[c] !== y?.cells[c]) cells.add(`${name}|${c}`);
  }
  for (const c of codes) {
    if (a.visits.find((v) => v.code === c)?.totalCents !== b.visits.find((v) => v.code === c)?.totalCents) totals.add(c);
  }
  return { cells, units, totals, count: cells.size };
}

function Mini({ grid, diff, other }: { grid: BudgetGrid; diff: ReturnType<typeof gridDifferences>; other: BudgetGrid }) {
  const visits = [...grid.visits].sort((x, y) => x.order - y.order);
  const otherProcs = new Map(other.procedures.map((p) => [p.name, p]));
  const mark = "bg-warn-soft font-semibold text-warn";
  return (
    <div className="max-h-[55vh] overflow-auto rounded-md border border-line">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 border-b border-line bg-sunken px-2 py-1.5 text-left font-medium">Procedure</th>
            <th className="sticky top-0 border-b border-line bg-sunken px-2 py-1.5 text-right font-medium">Unit</th>
            {visits.map((v) => (
              <th key={v.code} className="sticky top-0 border-b border-line bg-sunken px-2 py-1.5 text-right font-medium">
                {v.code}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.procedures.map((p) => (
            <tr key={p.name}>
              <th scope="row" className={cx("sticky left-0 border-b border-line bg-surface px-2 py-1 text-left font-normal whitespace-nowrap", !otherProcs.has(p.name) && mark)}>
                {p.name}
              </th>
              <td className={cx("num border-b border-line px-2 py-1 text-right", diff.units.has(p.name) && mark)}>{formatCents(p.unitCents)}</td>
              {visits.map((v) => {
                const c = p.cells[v.code];
                return (
                  <td key={v.code} className={cx("num border-b border-line px-2 py-1 text-right", diff.cells.has(`${p.name}|${v.code}`) && mark)}>
                    {c === undefined ? <span className="text-faint">·</span> : c === "invoiceable" ? "Inv." : formatCents(c)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th colSpan={2} className="sticky left-0 border-b border-line bg-sunken px-2 py-1 text-left">
              Visit total
            </th>
            {visits.map((v) => (
              <td key={v.code} className={cx("num border-b border-line bg-sunken px-2 py-1 text-right", diff.totals.has(v.code) && mark)}>
                {formatCents(v.totalCents)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Side-by-side comparison of two conflicting grids with a "use this grid" choice. */
export function GridCompare({ grids, onChoose, busy, error }: { grids: [BudgetGrid, BudgetGrid]; onChoose: (gridId: string, note: string) => void; busy: boolean; error: unknown }) {
  const [a, b] = grids;
  const diff = gridDifferences(a, b);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const total = (g: BudgetGrid) => g.perPatientTotals[0];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        <Badge tone="warn">{diff.count} cells differ</Badge>
        {diff.units.size > 0 && <span className="ml-2 text-muted">Unit prices differ for: {[...diff.units].join(", ")}.</span>}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {grids.map((g, i) => (
          <label key={g.id} className={cx("flex cursor-pointer flex-col gap-2 rounded-card border-2 p-3", choice === g.id ? "border-accent bg-accent-soft/30" : "border-line")}>
            <span className="flex items-center gap-2">
              <input type="radio" name="grid" value={g.id} checked={choice === g.id} onChange={() => setChoice(g.id)} />
              <span className="font-medium">{g.label}</span>
              {g.arm && <Badge>{g.arm}</Badge>}
              <span className="ml-auto text-sm">
                {total(g) && (
                  <>
                    <span className="text-muted">{total(g)!.label}: </span>
                    <span className="num font-semibold">{formatCents(total(g)!.cents)}</span>
                  </>
                )}
              </span>
            </span>
            <span className="text-xs text-muted">
              Stated overhead {g.statedOverheadPct ?? "—"}% · {g.prov.source ? `p.${g.prov.source.page}` : "no page ref"}
            </span>
            <Mini grid={g} diff={diff} other={grids[1 - i]!} />
          </label>
        ))}
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice && note.trim()) onChoose(choice, note.trim());
        }}
      >
        <label htmlFor="grid-note" className="text-xs font-medium text-muted">
          Why this grid governs (required)
        </label>
        <textarea id="grid-note" rows={2} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Work order §2 says Exhibit A controls over attachments." />
        <ErrorNote error={error} />
        <div>
          <Button type="submit" variant="primary" disabled={!choice || !note.trim() || busy}>
            {busy ? "Saving…" : choice ? `Use ${grids.find((g) => g.id === choice)!.label}` : "Choose a grid above"}
          </Button>
        </div>
      </form>
    </div>
  );
}
