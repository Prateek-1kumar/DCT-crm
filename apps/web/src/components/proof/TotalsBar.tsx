"use client";

import type { Coverage, AmountStatus } from "@/lib/types";
import { Badge, Button, cx } from "../ui";
import { plural, STATUS } from "./model";

export interface Layers {
  amounts: boolean;
  clauses: boolean;
}

const COUNTS: [AmountStatus, keyof Coverage["totals"]][] = [
  ["captured", "captured"],
  ["decided", "decided"],
  ["set_aside", "setAside"],
  ["missing", "missing"],
];

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cx("h-8 rounded-full border px-3.5 text-small font-medium", on ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted")}>
      {children}
    </button>
  );
}

export function TotalsBar({ totals, scanned, filter, onFilter, onNext, layers, onLayers }: {
  totals: Coverage["totals"];
  scanned: number;
  filter: AmountStatus | null;
  onFilter: (f: AmountStatus | null) => void;
  onNext: () => void;
  layers: Layers;
  onLayers: (l: Layers) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <p className="text-title font-semibold tracking-tight">{plural(totals.amounts, "amount")} in the contract</p>
        <ul className="flex flex-wrap gap-2" aria-label="Filter by what happened to each amount">
          {COUNTS.map(([status, key]) => (
            <li key={status}>
              <button type="button" aria-pressed={filter === status} disabled={totals[key] === 0} onClick={() => onFilter(filter === status ? null : status)} className="rounded-full disabled:cursor-default">
                <Badge tone={STATUS[status].tone} className={cx("h-8 px-3.5 text-body", filter === status && "ring-2 ring-current")}>
                  {totals[key]} {STATUS[status].chip}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex flex-wrap gap-2" role="group" aria-label="Show on the pages">
          <Toggle on={layers.amounts} onClick={() => onLayers({ ...layers, amounts: !layers.amounts })}>Amounts</Toggle>
          <Toggle on={layers.clauses} onClick={() => onLayers({ ...layers, clauses: !layers.clauses })}>Rule wording</Toggle>
        </div>
      </div>
      {totals.missing > 0 ? (
        <p role="alert" className="flex flex-wrap items-center gap-3 rounded-field bg-danger-soft px-4 py-3 text-body text-danger">
          Not in the rulebook yet: this needs a look before approval.
          <Button variant="danger" size="sm" onClick={onNext}>
            Next missing
          </Button>
        </p>
      ) : (
        <p className="rounded-field bg-ok-soft px-4 py-3 text-body text-ok">Nothing missing: every amount we could read in the contract is in the rulebook.</p>
      )}
      {scanned > 0 && (
        <p className="rounded-field bg-warn-soft px-4 py-3 text-body text-warn">
          {plural(scanned, "page")} in this contract {scanned === 1 ? "is" : "are"} scanned: amounts on {scanned === 1 ? "it" : "them"} can&apos;t be checked.
        </p>
      )}
    </div>
  );
}
