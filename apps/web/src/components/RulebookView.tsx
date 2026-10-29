"use client";

import { gridChoice, type Rulebook } from "@dct/shared";
import { useState, type ReactNode } from "react";
import { DOC_KIND_LABEL, ENUM_OPTIONS, formatDate, formatValue } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { findProv, getAt } from "@/lib/pointer";
import { GridTable } from "./GridTable";
import { isHit, useRulebook, Val } from "./review-context";
import { Badge, cx, onTabKeys } from "./ui";

/** Which part of the invoicing master a contract page tab shows. */
export type MasterPart = "grid" | "fees" | "terms" | "details";

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

/** One part of the invoicing master. Read-only: values change only by answering questions. */
export function RulebookView({ part }: { part: MasterPart }) {
  const { rulebook: rb } = useRulebook();
  if (part === "grid")
    return (
      <Section id="grids" title={rb.budgetGrids.length > 1 ? `Budget grids (${rb.budgetGrids.length})` : "Budget grid"}>
        {rb.budgetGrids.length === 0 ? <p className="text-small text-muted">No budget grid in this invoicing master.</p> : <Grids />}
      </Section>
    );

  if (part === "fees")
    return (
      <div className="flex flex-col gap-5">
        <Section id="site-fees" title={`Site fees (${rb.siteFees.length})`}>
          <ItemTable
            at="/siteFees"
            cols={[
              { key: "name", label: "Fee" },
              { key: "amountCents", label: "Amount", num: true },
              { key: "trigger", label: "When" },
              { key: "dueDays", label: "Due (days)", num: true },
            ]}
          />
        </Section>
        <Section id="invoiceables" title={`Invoiceables (${rb.invoiceables.length})`}>
          <ItemTable
            at="/invoiceables"
            cols={[
              { key: "name", label: "Item" },
              { key: "amountCents", label: "Amount", num: true },
              { key: "amountWithOverheadCents", label: "With overhead", num: true },
              { key: "basis", label: "Basis" },
              { key: "frequency", label: "Frequency" },
              { key: "cap", label: "Cap", fmt: (o) => formatCap(o.cap as never) },
              { key: "requiresPreApproval", label: "Pre-approval" },
              { key: "requiredDocs", label: "Needs" },
            ]}
          />
        </Section>
        <Section id="bill-by-hand" title={`Bill by hand (${rb.unclassified.length})`}>
          <BillByHand />
        </Section>
        <Section id="screen-fail" title="Screen failures">
          {rb.screenFail ? (
            <dl>
              <Row label="Amount" path="/screenFail/amountCents" />
              <Row label="Basis" path="/screenFail/basis" />
              <Row label="Cap" path="/screenFail/cap" display={formatCap(rb.screenFail.cap)} />
              <Row label="Paid via" path="/screenFail/paidVia" />
              <Row label="Needs" path="/screenFail/requiredDocs" />
            </dl>
          ) : (
            <NotInContract />
          )}
        </Section>
      </div>
    );

  if (part === "terms")
    return (
      <div className="grid gap-5 xl:grid-cols-2">
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
        <div className="flex flex-col gap-5">
          <Section id="overhead" title="Overhead">
            <dl>
              <Sourced label="Overhead %" at="/overhead/pct" />
              <Sourced label="Applies to" at="/overhead/appliesTo" />
            </dl>
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
        </div>
        <Section id="deadlines" title={`Deadlines (${rb.deadlines.length})`}>
          <ItemTable
            at="/deadlines"
            cols={[
              { key: "kind", label: "Rule", fmt: (o) => ENUM_OPTIONS.kind?.[o.kind as string] ?? String(o.kind) },
              { key: "value", label: "N", num: true },
              { key: "consequence", label: "If missed" },
            ]}
          />
        </Section>
        <div className="flex flex-col gap-5">
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
              <Sourced label="New terms apply from" at="/appliesFrom" />
            </dl>
          </Section>
        </div>
      </div>
    );

  return (
    <Section id="study" title="Study details">
      <dl>
        <Sourced label="Sponsor" at="/study/sponsor" />
        <Sourced label="Paying agent / CRO" at="/study/payingAgent" />
        <Sourced label="Protocol" at="/study/protocol" />
        <Sourced label="Site" at="/study/siteName" />
        <Sourced label="Principal investigator" at="/study/investigator" />
        <Sourced label="Effective date" at="/study/effectiveDate" />
      </dl>
      <h4 className="eyebrow mt-5 mb-2">What this invoicing master is built from</h4>
      <ul className="flex flex-col gap-1.5 text-small">
        {rb.documents.map((d, i) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2">
            {/* an amendment's own date is withheld while the start date is typed blind (alsoWithheld) */}
            <Badge tone="accent">{DOC_KIND_LABEL[d.kind]}</Badge> {d.title} <span className="text-muted"><Val path={`/documents/${i}/date`}>{d.date ? formatDate(d.date) : ""}</Val></span>
          </li>
        ))}
        {rb.referencedDocuments.map((r, i) => (
          <li key={`r${i}`} className="flex flex-wrap items-center gap-2">
            {r.present ? <Badge tone="ok">Referred to · uploaded</Badge> : <Badge tone="warn">Referred to · not uploaded</Badge>}
            {r.description} <span className="text-muted">{formatDate(r.date)}</span>
            <ShowLink path={`/referencedDocuments/${i}`} label={r.description} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Grids() {
  const { rulebook: rb, focused } = useRulebook();
  // Opens on a grid billing uses; then a grid picked by hand, until a value in another grid is shown (search, ⌘K).
  const [picked, setPicked] = useState<{ i: number; at: string | null }>(() => ({ i: Math.max(0, rb.budgetGrids.findIndex((g) => gridChoice(rb, g)?.billed)), at: null }));
  if (rb.budgetGrids.length === 1) return <GridTable index={0} />;
  const m = /^\/budgetGrids\/(\d+)/.exec(focused ?? "");
  const i = Math.min(m && picked.at !== focused ? Number(m[1]) : picked.i, rb.budgetGrids.length - 1);
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Budget grids" onKeyDown={onTabKeys} className="flex flex-wrap gap-0.5 self-start rounded-full border border-line-strong p-0.5">
        {rb.budgetGrids.map((g, gi) => (
          <button
            key={g.id}
            id={`grid-tab-${gi}`}
            role="tab"
            type="button"
            aria-selected={gi === i}
            aria-controls="grid-panel"
            tabIndex={gi === i ? 0 : -1}
            onClick={() => setPicked({ i: gi, at: focused })}
            className={cx("rounded-full px-3 py-1.5 text-[13px]", gi === i ? "bg-ink text-surface" : "text-ink-2 hover:bg-sunken")}
          >
            {g.label}
            {g.arm && <span className="opacity-70"> · {g.arm}</span>}
            {gridChoice(rb, g)?.billed === true && " · billed from this one"}
            {gridChoice(rb, g)?.billed === false && <span className="opacity-70"> · not billed</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="grid-panel" aria-labelledby={`grid-tab-${i}`}>
        <GridTable key={i} index={i} />
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`rb-${id}`} aria-labelledby={`rb-${id}-h`} className="rounded-card bg-surface p-5 ring-1 ring-line">
      <h3 id={`rb-${id}-h`} className="mb-3 text-body font-semibold tracking-tight">
        {title}
      </h3>
      {children}
    </section>
  );
}

const NotInContract = () => <p className="text-small text-muted">Not in the contract.</p>;

/**
 * Money terms the invoicing master has no field for (ADR-001 §7): listed when someone answered "bill it by hand". They're
 * approved with the version and in its Excel export, but nothing bills them automatically: an accountant bills each from
 * the contract's own words.
 */
function BillByHand() {
  const { rulebook: rb, show } = useRulebook();
  if (!rb.unclassified.length) return <p className="text-small text-muted">Nothing is billed by hand: every money term the contract has is in the invoicing master.</p>;
  return (
    <>
      <p className="mb-3 text-small text-muted">These money terms have no place in the invoicing master, so nothing bills them for you. Bill each one by hand, from the contract&apos;s own words.</p>
      <ul className="flex flex-col divide-y divide-line">
        {rb.unclassified.map((u, i) => (
          <li key={i} className="flex flex-wrap items-start justify-between gap-3 py-2.5 text-small">
            <span className="min-w-0 flex-1">
              <span className="block text-ink">{u.quote ? `“${u.quote}”` : u.label}</span>
              {u.amounts.length > 0 && <span className="num block text-muted">{u.amounts.map((c) => formatCents(c)).join(", ")}</span>}
              {u.note && <span className="block text-muted">Note: {u.note}</span>}
            </span>
            <button type="button" onClick={() => show(`/unclassified/${i}`, u.prov, u.label)} className="text-caption whitespace-nowrap text-accent hover:underline">
              page {u.page} ↗
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ShowLink({ path, label }: { path: string; label: string }) {
  const { rulebook, show } = useRulebook();
  const prov = findProv(rulebook, path);
  if (!prov?.source) return null;
  return (
    <button type="button" onClick={() => show(path, prov, label)} className="text-caption whitespace-nowrap text-accent hover:underline">
      page {prov.source.page} ↗
    </button>
  );
}

function Sourced({ label, at }: { label: string; at: string }) {
  return <Row label={label} path={`${at}/value`} />;
}

/** A value made of others (a cap: kind, limit, ratio) is hidden while one of them is withheld for a blind answer. */
const holds = (masked: Set<string>, path: string) => [...masked].some((p) => p.startsWith(`${path}/`));

/** One labelled value: click to see it in the contract. */
function Row({ label, path, display }: { label: string; path: string; display?: string }) {
  const { rulebook, show, focused, hits, masked } = useRulebook();
  const value = getAt(rulebook, path);
  const prov = findProv(rulebook, path);
  return (
    <div
      className={cx(
        "grid grid-cols-[minmax(8rem,13rem)_1fr] items-start gap-x-3 border-b border-line py-2 last:border-0",
        focused === path ? "bg-highlight" : isHit(hits, path) && "bg-brand-soft",
      )}
    >
      <dt className="text-small text-muted">{label}</dt>
      <dd className="min-w-0">
        <button
          type="button"
          data-path={path}
          onClick={() => show(path, prov, label)}
          className={cx("-mx-1 rounded px-1 text-left text-small hover:bg-accent-soft", value === null && "text-faint italic")}
          title={prov?.source ? `Show page ${prov.source.page} of the contract` : "No page reference"}
        >
          {holds(masked, path) ? (
            <span className="text-warn">needs you</span>
          ) : (
            <Val path={path}>
              <span className={typeof value === "number" ? "num" : ""}>{display ?? formatValue(path, value)}</span>
            </Val>
          )}
        </button>
      </dd>
    </div>
  );
}

type Col = { key: string; label: string; num?: boolean; fmt?: (o: Record<string, unknown>) => string };

function ItemTable({ at, cols }: { at: string; cols: Col[] }) {
  const { rulebook, show, focused, hits, masked } = useRulebook();
  const items = (getAt(rulebook, at) as Record<string, unknown>[] | undefined) ?? [];
  if (!items.length) return <NotInContract />;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full text-small">
        <thead>
          <tr className="border-b border-line bg-sunken text-left">
            {cols.map((c) => (
              <th key={c.key} scope="col" className={cx("eyebrow px-2 py-2 first:pl-5 last:pr-5", c.num && "text-right")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((o, i) => {
            const rowPath = `${at}/${i}`;
            const prov = findProv(rulebook, rowPath);
            const name = String(o.name ?? o.kind ?? `#${i + 1}`);
            return (
              <tr key={i} className={cx("border-b border-line align-top last:border-0", focused?.startsWith(`${rowPath}/`) ? "bg-highlight" : isHit(hits, rowPath) && "bg-brand-soft")}>
                {cols.map((c) => {
                  const path = `${rowPath}/${c.key}`;
                  return (
                    <td key={c.key} className={cx("px-2 py-2 first:pl-5 last:pr-5", c.num && "num text-right")}>
                      <button type="button" data-path={path} className="-mx-1 rounded px-1 text-left hover:bg-accent-soft" onClick={() => show(path, prov, `${name} · ${c.label}`)}>
                        {holds(masked, path) ? <span className="text-warn">needs you</span> : <Val path={path}>{c.fmt ? c.fmt(o) : formatValue(path, o[c.key])}</Val>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
