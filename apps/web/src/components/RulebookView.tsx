"use client";

import type { Rulebook } from "@dct/shared";
import { Fragment, useState, type ReactNode } from "react";
import { DOC_KIND_LABEL, ENUM_OPTIONS, formatDate, formatValue } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { findProv, getAt } from "@/lib/pointer";
import { GridTable } from "./GridTable";
import { ProvChips } from "./Prov";
import { isFlagged, useRulebook } from "./review-context";
import { Badge, Button, cx } from "./ui";
import { ValueEditor } from "./ValueEditor";

const SECTIONS = [
  ["study", "Study"],
  ["payment", "Payment"],
  ["overhead", "Overhead"],
  ["grids", "Budget grid"],
  ["invoiceables", "Invoiceables"],
  ["screen-fail", "Screen fail"],
  ["site-fees", "Site fees"],
  ["holdback", "Holdback"],
  ["deadlines", "Deadlines"],
  ["overpayment", "Overpayment"],
  ["rounding", "Rounding"],
] as const;

export function formatCap(cap: Rulebook["invoiceables"][number]["cap"]): string {
  switch (cap.kind) {
    case "none":
      return "No cap";
    case "count":
      return `Max ${cap.n ?? "?"}`;
    case "amount":
      return `Max ${cap.n === null ? "?" : formatCents(cap.n)}`;
    case "ratio_to_randomized":
      return `${cap.ratio ?? "?"} per randomized subject`;
    case "blocks_with_reauth":
      return `Blocks of ${cap.n ?? "?"}, then re-authorize`;
  }
}

/** The whole rulebook, grouped in sections. Editing is on when the context says so. */
export function RulebookView() {
  const { rulebook: rb } = useRulebook();
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Rulebook sections" className="sticky top-[calc(3.5rem+var(--bar,0px))] z-20 -mx-1 flex gap-1 overflow-x-auto bg-canvas/95 px-1 py-2 backdrop-blur">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#rb-${id}`} className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs whitespace-nowrap text-muted hover:border-accent hover:text-ink">
            {id === "grids" && rb.budgetGrids.length > 1 ? `Budget grids (${rb.budgetGrids.length})` : label}
          </a>
        ))}
      </nav>

      <Section id="study" title="Study">
        <dl>
          <Sourced label="Sponsor" at="/study/sponsor" />
          <Sourced label="Paying agent / CRO" at="/study/payingAgent" />
          <Sourced label="Protocol" at="/study/protocol" />
          <Sourced label="Site" at="/study/siteName" />
          <Sourced label="Principal investigator" at="/study/investigator" />
          <Sourced label="Effective date" at="/study/effectiveDate" />
          <Sourced label="Amendment applies from" at="/appliesFrom" />
        </dl>
        <h4 className="mt-4 mb-1 text-xs font-medium text-muted">Documents in this rulebook</h4>
        <ul className="flex flex-col gap-1 text-sm">
          {rb.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <Badge tone="accent">{DOC_KIND_LABEL[d.kind]}</Badge> {d.title} <span className="text-muted">{formatDate(d.date)}</span>
            </li>
          ))}
          {rb.referencedDocuments.map((r, i) => (
            <li key={`r${i}`} className="flex items-center gap-2">
              {r.present ? <Badge tone="ok">Referenced · present</Badge> : <Badge tone="danger">Referenced · missing</Badge>}
              {r.description} <span className="text-muted">{formatDate(r.date)}</span>
              <ShowLink path={`/referencedDocuments/${i}`} label={r.description} />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="payment" title="Payment">
        <dl>
          <Sourced label="Visit payments" at="/payment/visitPayment" />
          <Sourced label="Frequency" at="/payment/frequency" />
          <Sourced label="Net days" at="/payment/netDays" />
          <Sourced label="Net days counted from" at="/payment/netDaysFrom" />
          <Sourced label="Invoice address" at="/payment/invoiceAddress" />
          <Sourced label="Every invoice must show" at="/payment/requiredReferences" />
          <Sourced label="Paid only when" at="/payment/paymentConditions" />
        </dl>
      </Section>

      <Section id="overhead" title="Overhead">
        <dl>
          <Sourced label="Overhead %" at="/overhead/pct" />
          <Sourced label="Applies to" at="/overhead/appliesTo" />
        </dl>
      </Section>

      <Section id="grids" title={rb.budgetGrids.length > 1 ? `Budget grids (${rb.budgetGrids.length})` : "Budget grid"}>
        {rb.budgetGrids.length === 0 ? (
          <p className="text-sm text-muted">No budget grid in this rulebook.</p>
        ) : (
          <Grids />
        )}
      </Section>

      <Section id="invoiceables" title={`Invoiceables (${rb.invoiceables.length})`}>
        <ItemTable
          at="/invoiceables"
          cols={[
            { key: "name", label: "Item", edit: true },
            { key: "amountCents", label: "Amount", edit: true, num: true },
            { key: "amountWithOverheadCents", label: "With overhead", edit: true, num: true },
            { key: "basis", label: "Basis" },
            { key: "frequency", label: "Frequency" },
            { key: "cap", label: "Cap", fmt: (o) => formatCap(o.cap as never) },
            { key: "requiresPreApproval", label: "Pre-approval", edit: true },
            { key: "requiredDocs", label: "Needs", edit: true },
          ]}
        />
      </Section>

      <Section id="screen-fail" title="Screen fail">
        {rb.screenFail ? (
          <dl>
            <Row label="Amount" path="/screenFail/amountCents" />
            <Row label="Basis" path="/screenFail/basis" />
            <Row label="Cap" path="/screenFail/cap" display={formatCap(rb.screenFail.cap)} readOnly />
            <Row label="Paid via" path="/screenFail/paidVia" />
            <Row label="Needs" path="/screenFail/requiredDocs" />
          </dl>
        ) : (
          <NotInContract />
        )}
      </Section>

      <Section id="site-fees" title={`Site fees (${rb.siteFees.length})`}>
        <ItemTable
          at="/siteFees"
          cols={[
            { key: "name", label: "Fee", edit: true },
            { key: "amountCents", label: "Amount", edit: true, num: true },
            { key: "trigger", label: "When", edit: true },
            { key: "dueDays", label: "Due (days)", edit: true, num: true },
          ]}
        />
      </Section>

      <Section id="holdback" title="Holdback">
        {rb.holdback ? (
          <dl>
            <Row label="Holdback %" path="/holdback/pct" />
            <Row label="Applies to" path="/holdback/appliesTo" />
            <Row label="Released when" path="/holdback/releaseConditions" />
          </dl>
        ) : (
          <NotInContract />
        )}
      </Section>

      <Section id="deadlines" title={`Deadlines (${rb.deadlines.length})`}>
        <ItemTable
          at="/deadlines"
          cols={[
            { key: "kind", label: "Rule", fmt: (o) => ENUM_OPTIONS.kind?.[o.kind as string] ?? String(o.kind) },
            { key: "value", label: "N", edit: true, num: true },
            { key: "consequence", label: "If missed", edit: true },
          ]}
        />
      </Section>

      <Section id="overpayment" title="Overpayment">
        {rb.overpayment ? (
          <dl>
            <Row label="Refund within (days)" path="/overpayment/refundDays" />
            <Row label="Sponsor may offset" path="/overpayment/sponsorMayOffset" />
          </dl>
        ) : (
          <NotInContract />
        )}
      </Section>

      <Section id="rounding" title="Rounding">
        <dl>
          <Sourced label="Rounding" at="/rounding" />
        </dl>
      </Section>
    </div>
  );
}

function Grids() {
  const { rulebook: rb } = useRulebook();
  const [tab, setTab] = useState(0);
  if (rb.budgetGrids.length === 1) return <GridTable index={0} />;
  const i = Math.min(tab, rb.budgetGrids.length - 1);
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Budget grids" className="flex flex-wrap gap-1">
        {rb.budgetGrids.map((g, gi) => (
          <button
            key={g.id}
            role="tab"
            type="button"
            aria-selected={gi === i}
            onClick={() => setTab(gi)}
            className={cx("rounded-md border px-3 py-1.5 text-sm", gi === i ? "border-accent bg-accent-soft font-medium text-accent" : "border-line text-muted hover:text-ink")}
          >
            {g.label}
            {g.arm && <span className="text-muted"> · {g.arm}</span>}
            {rb.governingGridId === g.id && " ✓"}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <GridTable key={i} index={i} />
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`rb-${id}`} aria-labelledby={`rb-${id}-h`} className="scroll-mt-[calc(6.5rem+var(--bar,0px))] rounded-card border border-line bg-surface p-4">
      <h3 id={`rb-${id}-h`} className="mb-2 text-sm font-semibold tracking-tight">
        {title}
      </h3>
      {children}
    </section>
  );
}

const NotInContract = () => <p className="text-sm text-muted">Not in the contract.</p>;

function ShowLink({ path, label }: { path: string; label: string }) {
  const { rulebook, show } = useRulebook();
  const prov = findProv(rulebook, path);
  if (!prov?.source) return null;
  return (
    <button type="button" onClick={() => show(path, prov, label)} className="text-xs whitespace-nowrap text-accent hover:underline">
      p.{prov.source.page} ↗
    </button>
  );
}

function Sourced({ label, at }: { label: string; at: string }) {
  return <Row label={label} path={`${at}/value`} />;
}

/** One labelled value: click to see it in the contract, edit inline with a note. */
function Row({ label, path, display, readOnly }: { label: string; path: string; display?: string; readOnly?: boolean }) {
  const { rulebook, show, editable, editing, setEditing, save, flagged, focused } = useRulebook();
  const value = getAt(rulebook, path);
  const prov = findProv(rulebook, path);
  const flag = isFlagged(flagged, path);
  return (
    <div className={cx("grid grid-cols-[minmax(8rem,13rem)_1fr_auto] items-start gap-x-3 border-b border-line py-1.5 last:border-0", focused === path && "bg-highlight/40")}>
      <dt className="pt-0.5 text-sm text-muted">{label}</dt>
      <dd className="min-w-0">
        <button
          type="button"
          onClick={() => show(path, prov, label)}
          className={cx("rounded px-1 -mx-1 text-left text-sm hover:bg-accent-soft", flag && "bg-warn-soft font-medium text-warn", value === null && "text-faint italic")}
          title={prov?.source ? `Show p.${prov.source.page} in the contract` : "No page reference"}
        >
          <span className={typeof value === "number" ? "num" : ""}>{display ?? formatValue(path, value)}</span>
        </button>
      </dd>
      <div className="flex items-center gap-1.5">
        <ProvChips prov={prov} compact />
        {editable && !readOnly && editing !== path && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(path)} aria-label={`Edit ${label}`}>
            ✎
          </Button>
        )}
      </div>
      {editing === path && (
        <div className="col-span-3 py-2">
          <ValueEditor path={path} value={value} label={label} onCancel={() => setEditing(null)} onSave={async (v, n) => (await save(path, v, n), setEditing(null))} />
        </div>
      )}
    </div>
  );
}

type Col = { key: string; label: string; edit?: boolean; num?: boolean; fmt?: (o: Record<string, unknown>) => string };

function ItemTable({ at, cols }: { at: string; cols: Col[] }) {
  const { rulebook, show, editable, editing, setEditing, save, flagged, focused } = useRulebook();
  const items = (getAt(rulebook, at) as Record<string, unknown>[] | undefined) ?? [];
  if (!items.length) return <NotInContract />;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            {cols.map((c) => (
              <th key={c.key} scope="col" className={cx("px-2 py-1.5 font-medium first:pl-4", c.num && "text-right")}>
                {c.label}
              </th>
            ))}
            <th scope="col" className="px-2 py-1.5 pr-4 text-right font-medium">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o, i) => {
            const rowPath = `${at}/${i}`;
            const prov = findProv(rulebook, rowPath);
            const name = String(o.name ?? o.kind ?? `#${i + 1}`);
            const editingHere = editing?.startsWith(`${rowPath}/`) ? editing : null;
            return (
              <Fragment key={i}>
                <tr className={cx("border-b border-line align-top", isFlagged(flagged, rowPath) && "bg-warn-soft/60", focused?.startsWith(rowPath) && "bg-highlight/40")}>
                  {cols.map((c) => {
                    const path = `${rowPath}/${c.key}`;
                    return (
                      <td key={c.key} className={cx("px-2 py-1.5 first:pl-4", c.num && "num text-right")}>
                        <span className="group inline-flex items-center gap-1">
                          <button type="button" className="rounded px-1 -mx-1 text-left hover:bg-accent-soft" onClick={() => show(path, prov, `${name} · ${c.label}`)}>
                            {c.fmt ? c.fmt(o) : formatValue(path, o[c.key])}
                          </button>
                          {editable && c.edit && (
                            <button
                              type="button"
                              aria-label={`Edit ${name} ${c.label}`}
                              onClick={() => setEditing(path)}
                              className="rounded px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-accent focus-visible:opacity-100"
                            >
                              ✎
                            </button>
                          )}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 pr-4 text-right whitespace-nowrap">
                    <ProvChips prov={prov} compact />
                  </td>
                </tr>
                {editingHere && (
                  <tr>
                    <td colSpan={cols.length + 1} className="px-4 py-2">
                      <ValueEditor
                        path={editingHere}
                        value={getAt(rulebook, editingHere)}
                        label={`${name} · ${cols.find((c) => `${rowPath}/${c.key}` === editingHere)?.label ?? ""}`}
                        onCancel={() => setEditing(null)}
                        onSave={async (v, n) => (await save(editingHere, v, n), setEditing(null))}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
