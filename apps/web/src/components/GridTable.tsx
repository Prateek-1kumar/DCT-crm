"use client";

import type { BudgetGrid } from "@dct/shared";
import type { ReactNode } from "react";
import { formatCents } from "@/lib/money";
import { isHit, useRulebook, Val } from "./review-context";
import { Badge, cx } from "./ui";

const FOOT: { key: "procedureSubtotalCents" | "overheadCents" | "nonProcedureCents" | "totalCents"; label: string }[] = [
  { key: "procedureSubtotalCents", label: "Procedure subtotal" },
  { key: "overheadCents", label: "Overhead" },
  { key: "nonProcedureCents", label: "Non-procedure" },
  { key: "totalCents", label: "Visit total" },
];

/** Procedure × visit grid: sticky headers and first column, horizontal scroll, invoiceable cells marked. */
export function GridTable({ index }: { index: number }) {
  const { rulebook, show, focused, masked, hits } = useRulebook();
  const grid = rulebook.budgetGrids[index]!;
  const base = `/budgetGrids/${index}`;
  const visits = [...grid.visits].sort((a, b) => a.order - b.order);
  const governing = rulebook.governingGridId === grid.id;

  const cell = (path: string, label: string, prov: BudgetGrid["prov"], text: ReactNode) => (
    <button
      type="button"
      data-path={path}
      className={cx("num flex w-full justify-end px-2 py-1.5 hover:bg-accent-soft focus-visible:relative", focused === path && "bg-highlight")}
      onClick={() => show(path, prov, label)}
    >
      <Val path={path}>{text}</Val>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{grid.label}</span>
        {grid.arm && <Badge>{grid.arm}</Badge>}
        {governing && <Badge tone="ok">Billed from this grid</Badge>}
        <span className="text-muted">
          Stated overhead {grid.statedOverheadPct ?? "—"}% · Header:{" "}
          {masked.has(`${base}/header`) ? <span className="text-warn">needs you</span> : `${grid.header.investigator ?? "—"}, ${grid.header.siteName ?? "—"}`}
        </span>
        <button type="button" className="text-accent hover:underline" onClick={() => show(base, grid.prov, grid.label)}>
          Show in the contract
        </button>
      </div>

      <div className="max-h-[520px] overflow-auto rounded-[10px] border border-line" tabIndex={0} aria-label={`${grid.label} grid`}>
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th scope="col" className="eyebrow sticky top-0 left-0 z-20 min-w-56 border-b border-line bg-sunken px-2 py-2 text-left">
                Procedure
              </th>
              <th scope="col" className="eyebrow sticky top-0 z-10 border-b border-line bg-sunken px-2 py-2 text-right">
                Unit
              </th>
              {visits.map((v) => (
                <th
                  key={v.code}
                  scope="col"
                  className={cx("sticky top-0 z-10 min-w-24 border-b border-line px-2 py-2 text-right font-medium", isHit(hits, `${base}/visits/${grid.visits.indexOf(v)}`) ? "bg-brand-soft" : "bg-sunken")}
                >
                  <span className="block">{v.code}</span>
                  <span className="block font-normal text-muted">{v.name}</span>
                  {!v.autopay && <span className="block font-normal text-warn">invoice</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.procedures.map((p, pi) => (
              <tr key={pi} className={cx("group", isHit(hits, `${base}/procedures/${pi}`) && "bg-brand-soft")}>
                <th
                  scope="row"
                  className={cx(
                    "sticky left-0 z-10 border-b border-line px-2 py-1.5 text-left font-normal group-hover:bg-sunken",
                    isHit(hits, `${base}/procedures/${pi}`) ? "bg-brand-soft" : "bg-surface",
                  )}
                >
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="text-muted">
                    {p.code ?? "—"} · {p.category === "procedure" ? "procedure" : "non-procedure"}
                    {p.overheadApplied ? " · +overhead" : ""}
                  </span>
                </th>
                <td className="border-b border-line p-0">{cell(`${base}/procedures/${pi}/unitCents`, `${p.name} · unit price`, p.prov, formatCents(p.unitCents))}</td>
                {visits.map((v) => {
                  const c = p.cells[v.code];
                  return (
                    <td key={v.code} className="border-b border-line p-0">
                      {c === undefined ? (
                        <span className="block px-2 py-1.5 text-right text-faint" aria-label="Not done at this visit">
                          ·
                        </span>
                      ) : (
                        cell(`${base}/procedures/${pi}/cells/${v.code}`, `${p.name} × ${v.name}`, p.prov, c === "invoiceable" ? <Badge tone="info">Inv.</Badge> : formatCents(c))
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {FOOT.map((f) => (
              <tr key={f.key} className={f.key === "totalCents" ? "font-medium" : ""}>
                <th scope="row" colSpan={2} className="sticky left-0 z-10 border-b border-line bg-sunken px-2 py-1.5 text-left font-medium">
                  {f.label}
                </th>
                {visits.map((v) => {
                  const vi = grid.visits.indexOf(v);
                  return (
                    <td key={v.code} className="border-b border-line bg-sunken p-0">
                      {cell(`${base}/visits/${vi}/${f.key}`, `${v.name} · ${f.label.toLowerCase()}`, v.prov, formatCents(v[f.key]))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap gap-4 text-[13px]">
        {grid.perPatientTotals.map((t, i) => {
          const path = `${base}/perPatientTotals/${i}/cents`;
          return (
            <button key={i} type="button" className="hover:text-accent" onClick={() => show(path, t.prov, t.label)}>
              <span className="text-muted">{t.label}: </span>
              <Val path={path}>
                <span className="num font-medium">{formatCents(t.cents)}</span>
              </Val>
            </button>
          );
        })}
        <span className="text-muted">
          <Badge tone="info">Inv.</Badge> = invoiceable, billed separately · <span className="text-faint">·</span> = not done at this visit
        </span>
      </div>
    </div>
  );
}
