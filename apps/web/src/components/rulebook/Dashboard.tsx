"use client";

import type { DocumentRole, Grid, Term } from "@dct/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, cx, Empty } from "@/components/ui";
import { formatCents } from "@/lib/money";
import type { Version } from "@/lib/types";
import { GridTable } from "./GridTable";
import { BILLING_LABEL, termAmount } from "./terms";

const PAYABLE = new Set<Term["category"]>(["site_fee", "recurring_fee", "invoiceable", "conditional_procedure", "screen_failure", "unscheduled_visit", "stipend_travel", "bonus"]);

const INVOICE_GROUPS: { title: string; categories: Term["category"][] }[] = [
  { title: "Extra visits and procedures", categories: ["conditional_procedure", "unscheduled_visit"] },
  { title: "Screen failures", categories: ["screen_failure"] },
  { title: "Stipends, travel and bonuses", categories: ["stipend_travel", "bonus"] },
];
const OTHER_GROUP = "Other items you invoice";
const SCHEDULE_GROUP = "Billed from the visit schedule";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatDate(s: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: dateOnly ? "UTC" : undefined });
}

const proofHref = (versionId: string, ref?: string) => `/versions/${versionId}/proof${ref ? `?tab=rulebook&ref=${ref}` : ""}`;
const gridTitle = (g: Grid) => g.arm ?? g.name;
const richest = (a: Term, b: Term) => (b.amountCents ?? -1) - (a.amountCents ?? -1);

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <Card className="p-6 sm:p-8">
      <h2 className="text-title font-semibold tracking-tight">{title}</h2>
      {sub && <p className="mt-1 text-body text-muted">{sub}</p>}
      <div className="mt-6">{children}</div>
    </Card>
  );
}

function Banner({ version, openQuestions }: { version: Version; openQuestions: number }) {
  const base = `/versions/${version.id}`;
  if (version.status === "draft") {
    return (
      <div className={cx("flex flex-wrap items-center justify-between gap-3 rounded-tile px-5 py-3.5 text-body", openQuestions ? "bg-warn-soft text-warn" : "bg-brand-soft text-accent")}>
        <p>{openQuestions ? `Draft: not live yet. ${plural(openQuestions, "question")} still ${openQuestions === 1 ? "needs" : "need"} an answer.` : "Draft: not live yet. Every question is answered."}</p>
        <Link href={openQuestions ? `${base}/questions` : `${base}/approve`} className="font-medium underline underline-offset-2">
          {openQuestions ? "Answer them" : "Review and approve"}
        </Link>
      </div>
    );
  }
  if (version.status === "approved" && version.approvedAt) {
    return <div className="rounded-tile bg-sunken px-5 py-3.5 text-body text-ink-2">{`Live since ${formatDate(version.approvedAt)}${version.approvedBy ? `, approved by ${version.approvedBy}` : ""}`}</div>;
  }
  if (version.status === "superseded") return <div className="rounded-tile bg-sunken px-5 py-3.5 text-body text-ink-2">A newer version has replaced this one.</div>;
  return null;
}

interface Line {
  text: string;
  detail?: string;
  href: string;
}

function KeyRules({ version, terms, grids, amendments }: { version: Version; terms: Term[]; grids: Grid[]; amendments: DocumentRole[] }) {
  const lines = (...categories: Term["category"][]): Line[] =>
    terms
      .filter((t) => categories.includes(t.category))
      .map((t) => ({ text: termAmount(t) || t.deadline || t.conditions || t.name, detail: t.name, href: proofHref(version.id, `term:${t.id}`) }));

  const overheadTerms = lines("overhead");
  const overheadFromGrids = [...new Map(grids.filter((g) => g.overheadPct !== null).map((g) => [g.overheadPct, g])).values()].map((g) => ({
    text: `${g.overheadPct}% overhead, included in the visit totals`,
    href: proofHref(version.id, `grid:${g.id}`),
  }));

  const tiles: { title: string; lines: Line[] }[] = [
    { title: "How fast the sponsor pays", lines: lines("payment_terms") },
    { title: "Holdback", lines: lines("holdback") },
    { title: "Overhead", lines: overheadTerms.length ? overheadTerms : overheadFromGrids },
    { title: "Invoice deadlines", lines: lines("invoicing", "deadline") },
    { title: "Screen failures", lines: lines("screen_failure") },
    {
      title: "Amendments in force",
      lines: amendments.map((d) => ({ text: d.doc, detail: d.effectiveFrom ? `From ${formatDate(d.effectiveFrom)}` : "Start date not stated", href: proofHref(version.id) })),
    },
  ].filter((t) => t.lines.length);

  if (!tiles.length) return null;
  return (
    <section aria-labelledby="key-rules">
      <h2 id="key-rules" className="eyebrow mb-3">
        Key rules
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.title} className="flex flex-col gap-3 rounded-tile bg-surface p-5 shadow-card ring-1 ring-ink/[0.05]">
            <h3 className="text-small font-medium text-muted">{tile.title}</h3>
            <ul className="flex flex-col gap-3">
              {tile.lines.map((l, i) => (
                <li key={i}>
                  <p className="text-body font-medium">{l.text}</p>
                  {l.detail && <p className="text-small text-muted">{l.detail}</p>}
                  <Link href={l.href} aria-label={`See where this came from: ${l.text}`} className="text-small text-accent hover:text-accent-hover hover:underline">
                    See where this came from
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function PaymentCards({ title, terms, versionId }: { title: string; terms: Term[]; versionId: string }) {
  if (!terms.length) return null;
  return (
    <Section title={title}>
      <ul className="grid gap-4 md:grid-cols-2">
        {[...terms].sort(richest).map((t) => (
          <li key={t.id} className="flex flex-col gap-2 rounded-tile bg-sunken p-5">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-body font-medium">{t.name}</h3>
              <Badge tone={t.billing === "unknown" ? "warn" : "neutral"}>{BILLING_LABEL[t.billing]}</Badge>
            </div>
            <p className="num text-heading font-semibold tracking-tight">{termAmount(t) || "No set amount"}</p>
            {t.trigger && <p className="text-body text-ink-2">{sentence(t.trigger)}</p>}
            {t.conditions && <p className="text-small text-muted">{t.conditions}</p>}
            <Link href={proofHref(versionId, `term:${t.id}`)} aria-label={`See where this came from: ${t.name}`} className="text-small text-accent hover:text-accent-hover hover:underline">
              See where this came from
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function VisitSchedule({ grids }: { grids: Grid[] }) {
  if (!grids.length) return null;
  return (
    <Section title="Visit schedule">
      <div className="flex flex-col gap-8">
        {grids.map((g) => (
          <div key={g.id}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4">
              <h3 className="text-body font-semibold">{gridTitle(g)}</h3>
              {g.grandTotalCents !== null && <p className="num text-body font-semibold">{formatCents(g.grandTotalCents)} per patient</p>}
            </div>
            <p className="mb-3 text-small text-muted">
              {[plural(g.visits.length, "visit"), g.grandTotalCents !== null && `${formatCents(g.grandTotalCents)} per patient`, g.overheadPct !== null && `${g.overheadPct}% overhead included`].filter(Boolean).join(" · ")}
            </p>
            <div className="overflow-hidden rounded-tile ring-1 ring-line">
              <GridTable grid={g} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

interface Item {
  name: string;
  amount: string;
  details: string[];
  unsettled?: boolean;
}

function invoiceGroups(terms: Term[], grids: Grid[]) {
  const groups = new Map<string, Item[]>();
  const add = (group: string, item: Item) => groups.set(group, [...(groups.get(group) ?? []), item]);

  for (const t of terms) {
    if (t.billing !== "invoice" && !(t.billing === "unknown" && PAYABLE.has(t.category))) continue;
    const group = INVOICE_GROUPS.find((g) => g.categories.includes(t.category))?.title ?? OTHER_GROUP;
    add(group, {
      name: t.name,
      amount: termAmount(t) || "No set amount",
      details: [t.conditions, t.deadline && `Deadline: ${t.deadline}`].filter((d): d is string => !!d),
      unsettled: t.billing === "unknown",
    });
  }

  for (const g of grids) {
    for (const row of g.rows) {
      const visits = g.visits.filter((_, i) => String(row.cells[i]).trim().toLowerCase() === "invoice");
      if (visits.length) add(SCHEDULE_GROUP, { name: grids.length > 1 ? `${row.name} (${gridTitle(g)})` : row.name, amount: row.unitCostCents === null ? "Price not printed" : formatCents(row.unitCostCents), details: [`Invoice at ${visits.join(", ")}`] });
    }
  }

  const order = [...INVOICE_GROUPS.map((g) => g.title), OTHER_GROUP, SCHEDULE_GROUP];
  return order.flatMap((title) => (groups.has(title) ? [{ title, items: groups.get(title)! }] : []));
}

function InvoiceChecklist({ terms, grids }: { terms: Term[]; grids: Grid[] }) {
  const groups = invoiceGroups(terms, grids);
  if (!groups.length) return null;
  return (
    <Section title="What you need to invoice" sub="These are not paid on their own. The site has to bill each one.">
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-2 text-small font-medium text-muted">{g.title}</h3>
            <ul className="divide-y divide-line rounded-tile ring-1 ring-line">
              {g.items.map((item, i) => (
                <li key={i} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 px-5 py-3.5">
                  <div className="min-w-0">
                    <p className="text-body font-medium">{item.name}</p>
                    {item.details.map((d) => (
                      <p key={d} className="text-small text-muted">
                        {d}
                      </p>
                    ))}
                    {item.unsettled && (
                      <Badge tone="warn" className="mt-1.5">
                        How this is paid isn&apos;t settled yet
                      </Badge>
                    )}
                  </div>
                  <p className="num text-body font-medium">{item.amount}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function Dashboard({ version }: { version: Version }) {
  const rulebook = version.rulebook;
  if (!rulebook) return <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>;
  const { terms, grids, study, questions } = rulebook;
  const openQuestions = questions.filter((q) => q.state === "open" && q.blocking).length;

  return (
    <div className="grid gap-6">
      <Banner version={version} openQuestions={openQuestions} />
      <KeyRules version={version} terms={terms} grids={grids} amendments={study.documents.filter((d) => d.role === "amendment")} />
      <PaymentCards title="One-time fees" terms={terms.filter((t) => t.category === "site_fee")} versionId={version.id} />
      <PaymentCards title="Recurring fees" terms={terms.filter((t) => t.category === "recurring_fee")} versionId={version.id} />
      <VisitSchedule grids={grids} />
      <InvoiceChecklist terms={terms} grids={grids} />
    </div>
  );
}
