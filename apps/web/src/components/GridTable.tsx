"use client";

import type { BudgetGrid } from "@dct/shared";
import { useState } from "react";
import { formatValue } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { findProv, getAt } from "@/lib/pointer";
import { ProvChips } from "./Prov";
import { isFlagged, useRulebook } from "./review-context";
import { Badge, Button, cx } from "./ui";
import { ValueEditor } from "./ValueEditor";

type Sel = { path: string; label: string; prov: BudgetGrid["prov"] };

const FOOT: { key: "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents" | "totalCents"; label: string }[] = [
  { key: "procedureSubtotalCents", label: "Procedure subtotal" },
  { key: "overheadCents", label: "Overhead" },
  { key: "nonProcedureCents", label: "Non-procedure" },
  { key: "totalCents", label: "Visit total" },
];

/** Procedure × visit grid: sticky headers and first column, horizontal scroll, invoiceable cells marked. */
export function GridTable({ index }: { index: number }) {
  const { rulebook, show, editable, editing, setEditing, save, flagged, focused } = useRulebook();
  const grid = rulebook.budgetGrids[index]!;
  const base = `/budgetGrids/${index}`;
  const [sel, setSel] = useState<Sel | null>(null);
  const visits = [...grid.visits].sort((a, b) => a.order - b.order);
  const governing = rulebook.governingGridId === grid.id;

  const pick = (s: Sel) => {
    setSel(s);
    show(s.path, s.prov, s.label);
  };
  const cellCls = (path: string) =>
    cx(
      "num w-full px-2 py-1.5 text-right hover:bg-accent-soft focus-visible:relative",
      (sel?.path === path || focused === path) && "bg-highlight/70",
      isFlagged(flagged, path) && "bg-warn-soft font-semibold text-warn",
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{grid.label}</span>
        {grid.arm && <Badge>{grid.arm}</Badge>}
        {governing && <Badge tone="ok">Governing grid</Badge>}
        <span className="text-muted">
          <span className={cx(isFlagged(flagged, `${base}/statedOverheadPct`) && "font-medium text-warn")}>Stated overhead {grid.statedOverheadPct ?? "—"}%</span> ·{" "}
          <span className={cx(isFlagged(flagged, `${base}/header`) && "font-medium text-warn")}>
            Header: {grid.header.investigator ?? "—"}, {grid.header.siteName ?? "—"}
          </span>
        </span>
        <button type="button" className="text-accent hover:underline" onClick={() => show(base, grid.prov, grid.label)}>
          Show in contract
        </button>
        <span className="ml-auto">
          <ProvChips prov={grid.prov} compact />
        </span>
      </div>

      {sel && (
        <div className="rounded-md border border-line bg-sunken px-3 py-2 text-sm">
          {editing === sel.path ? (
            <ValueEditor
              path={sel.path}
              value={getAt(rulebook, sel.path)}
              label={sel.label}
              onCancel={() => setEditing(null)}
              onSave={async (v, note) => {
                await save(sel.path, v, note);
                setEditing(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{sel.label}</span>
              <span className="num">{formatValue(sel.path, getAt(rulebook, sel.path))}</span>
              <ProvChips prov={findProv(rulebook, sel.path)} compact />
              {editable && (
                <Button size="sm" className="ml-auto" onClick={() => setEditing(sel.path)}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSel(null)} aria-label="Clear selection" className={editable ? "" : "ml-auto"}>
                ✕
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="max-h-[520px] overflow-auto rounded-md border border-line" tabIndex={0} aria-label={`${grid.label} grid`}>
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th scope="col" className="sticky top-0 left-0 z-20 min-w-56 border-b border-line bg-sunken px-2 py-2 text-left font-medium">
                Procedure
              </th>
              <th scope="col" className="sticky top-0 z-10 border-b border-line bg-sunken px-2 py-2 text-right font-medium">
                Unit
              </th>
              {visits.map((v) => (
                <th key={v.code} scope="col" className="sticky top-0 z-10 min-w-24 border-b border-line bg-sunken px-2 py-2 text-right font-medium">
                  <span className="block">{v.code}</span>
                  <span className="block font-normal text-muted">{v.name}</span>
                  {!v.autopay && <span className="block font-normal text-warn">invoice</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.procedures.map((p, pi) => (
              <tr key={pi} className="group">
                <th scope="row" className="sticky left-0 z-10 border-b border-line bg-surface px-2 py-1.5 text-left font-normal group-hover:bg-sunken">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="text-muted">
                    {p.code ?? "—"} · {p.category === "procedure" ? "procedure" : "non-procedure"}
                    {p.overheadApplied ? " · +OH" : ""}
                  </span>
                  {p.prov.crossCheck === "disagree" && <span className="ml-1 text-danger">≠</span>}
                </th>
                <td className="border-b border-line p-0">
                  {(() => {
                    const path = `${base}/procedures/${pi}/unitCents`;
                    return (
                      <button type="button" className={cellCls(path)} onClick={() => pick({ path, label: `${p.name} · unit price`, prov: p.prov })}>
                        {formatCents(p.unitCents)}
                      </button>
                    );
                  })()}
                </td>
                {visits.map((v) => {
                  const c = p.cells[v.code];
                  const path = `${base}/procedures/${pi}/cells/${v.code}`;
                  return (
                    <td key={v.code} className="border-b border-line p-0">
                      {c === undefined ? (
                        <span className="block px-2 py-1.5 text-right text-faint" aria-label="Not done at this visit">
                          ·
                        </span>
                      ) : (
                        <button type="button" className={cellCls(path)} onClick={() => pick({ path, label: `${p.name} × ${v.code} (${v.name})`, prov: p.prov })}>
                          {c === "invoiceable" ? <Badge tone="info">Inv.</Badge> : formatCents(c)}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {FOOT.map((f) => (
              <tr key={f.key} className={f.key === "totalCents" ? "font-semibold" : ""}>
                <th scope="row" colSpan={2} className="sticky left-0 z-10 border-b border-line bg-sunken px-2 py-1.5 text-left font-medium">
                  {f.label}
                </th>
                {visits.map((v) => {
                  const vi = grid.visits.indexOf(v);
                  const path = `${base}/visits/${vi}/${f.key}`;
                  return (
                    <td key={v.code} className="border-b border-line bg-sunken p-0">
                      <button type="button" className={cellCls(path)} onClick={() => pick({ path, label: `${v.code} ${f.label.toLowerCase()}`, prov: v.prov })}>
                        {formatCents(v[f.key])}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {grid.perPatientTotals.map((t, i) => (
          <button key={i} type="button" className="hover:text-accent" onClick={() => show(`${base}/perPatientTotals/${i}/cents`, t.prov, t.label)}>
            <span className="text-muted">{t.label}: </span>
            <span className="num font-semibold">{formatCents(t.cents)}</span>
          </button>
        ))}
        <span className="text-muted">
          <Badge tone="info">Inv.</Badge> = invoiceable, billed separately · <span className="text-faint">·</span> = not done at this visit
        </span>
      </div>
    </div>
  );
}
