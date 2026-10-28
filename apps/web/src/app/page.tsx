"use client";

import type { StudySummaryDto } from "@dct/shared";
import { ArrowRight, ChevronDown, MapPin, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { btnCls, cx, Empty, ErrorNote, PageTitle, pageCls, Spinner, StepTrack } from "@/components/ui";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useStudies } from "@/lib/queries";
import { minutesFor, summaryStage, VIEWS, type StageState, type ViewId } from "@/lib/review";

const VIEW_HINT: Record<ViewId, string> = {
  "needs-you": "Contracts with questions only a person can answer. Start with the oldest.",
  approval: "Every question is answered. Someone checks the summary and approves.",
  live: "Approved invoicing masters that billing uses now.",
  failed: "These couldn't be read. Read them again, or type them in by hand.",
};

/** Most urgent first: questions, couldn't read, details to confirm, approval, reading, live. */
const rank = (s: StageState) => (s.failed ? 1 : { "Needs you": 0, Upload: 2, Approve: 3, Reading: 4, Checking: 4, Live: 5 }[s.stage]);

const COLS = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_7.5rem]";

function NextStep({ s, st }: { s: StudySummaryDto; st: StageState }) {
  const go = (href: string, label: string, variant: "primary" | "secondary" | "ghost" = "primary") => (
    // relative z-10: stays clickable above the link that covers the row.
    <Link href={href} className={cx(btnCls(variant, "sm"), "relative z-10 justify-self-start")}>
      {label}
      <ArrowRight className="size-4" strokeWidth={2} />
    </Link>
  );
  if (st.failed)
    return (
      <div className="flex flex-col items-start gap-1">
        {go(`/studies/${s.id}`, "Read it again", "secondary")}
        <span className="text-caption text-faint">or type it in by hand</span>
      </div>
    );
  switch (st.stage) {
    case "Needs you":
      return (
        <div className="flex flex-col items-start gap-1">
          {go(`/studies/${s.id}/review`, `Answer ${st.needs} ${st.needs === 1 ? "question" : "questions"}`)}
          <span className="text-caption text-faint">about {minutesFor(st.needs ?? 1)} min</span>
        </div>
      );
    case "Approve":
      return go(`/studies/${s.id}`, "Review and approve");
    case "Upload":
      return go(`/studies/new?study=${encodeURIComponent(s.id)}`, "Confirm the details");
    case "Live":
      return go(`/studies/${s.id}`, "Open", "ghost");
    default:
      return (
        <span className="inline-flex items-center gap-2 text-small text-muted">
          <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
          Reading · a few minutes
        </span>
      );
  }
}

function Row({ s }: { s: StudySummaryDto }) {
  const st = summaryStage(s);
  return (
    <li className={cx("group relative grid gap-4 px-6 py-5 transition-colors hover:bg-sunken/70 md:items-center md:gap-6", COLS)}>
      <div className="min-w-0">
        {/* The link covers the whole row; the next-step button sits above it. */}
        <Link href={`/studies/${s.id}`} className="text-body font-semibold tracking-tight after:absolute after:inset-0 group-hover:text-accent">
          {s.protocol ?? "New contract"}
        </Link>
        <p className="truncate text-small text-muted">{s.sponsor ?? "Sponsor not confirmed yet"}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
          {s.siteName && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" strokeWidth={1.75} />
              {s.siteName}
            </span>
          )}
          {s.investigator && <span>{s.investigator}</span>}
          {s.status === "amendment_in_review" && <span className="rounded-full bg-brand-soft px-2 py-0.5 font-medium text-accent">New version in progress</span>}
        </p>
      </div>
      <StepTrack state={st} />
      <NextStep s={s} st={st} />
      <span className="text-small text-faint md:text-right" title={formatDateTime(s.updatedAt)}>
        <span className="md:hidden">Updated </span>
        {relativeTime(s.updatedAt)}
      </span>
    </li>
  );
}

export default function ContractsPage() {
  const { data, error, isPending } = useStudies();
  const router = useRouter();
  const params = useSearchParams();
  const view = VIEWS.find((v) => v.id === params.get("view"));
  const site = params.get("site");

  const href = (v: ViewId | null, s: string | null) => {
    const q = new URLSearchParams();
    if (v) q.set("view", v);
    if (s) q.set("site", s);
    return q.size ? `/?${q}` : "/";
  };

  const all = data ?? [];
  const sites = [...new Set(all.map((s) => s.siteName).filter((x): x is string => !!x))].sort();
  const atSite = all.filter((s) => !site || s.siteName === site);
  const count = (id: ViewId) => atSite.filter((s) => VIEWS.find((v) => v.id === id)!.test(summaryStage(s))).length;
  const rows = atSite
    .filter((s) => !view || view.test(summaryStage(s)))
    .map((s) => ({ s, st: summaryStage(s) }))
    .sort((a, b) => rank(a.st) - rank(b.st) || (a.st.stage === "Needs you" ? a.s.updatedAt.localeCompare(b.s.updatedAt) : b.s.updatedAt.localeCompare(a.s.updatedAt)))
    .map((r) => r.s);

  const tabs: { id: ViewId | null; label: string; n: number }[] = [{ id: null, label: "All", n: atSite.length }, ...VIEWS.map((v) => ({ id: v.id, label: v.label, n: count(v.id) }))];

  return (
    <div className={pageCls}>
      <PageTitle
        title="Contracts"
        sub="Every signed sponsor contract becomes an invoicing master. Nothing is billed from it until it's approved."
        actions={
          <Link href="/studies/new" className={btnCls("primary")}>
            <Plus className="size-[18px]" strokeWidth={2} /> Add contract
          </Link>
        }
      />

      {isPending && <Spinner />}
      <ErrorNote error={error} />

      {data && all.length === 0 && (
        <Empty title="No contracts yet" action={<Link href="/studies/new" className={btnCls("primary")}>Add your first contract</Link>}>
          Upload a signed sponsor contract. It&apos;s read and checked against the PDF, and you only answer what needs a person.
        </Empty>
      )}

      {all.length > 0 && (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            {/* One line; scrolls sideways on narrow screens instead of wrapping. */}
            <nav aria-label="Filter contracts" className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-sunken p-1 ring-1 ring-line [scrollbar-width:none]">
              {tabs.map((t) => {
                const active = (view?.id ?? null) === t.id;
                return (
                  <Link
                    key={t.label}
                    href={href(t.id, site)}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-small font-medium whitespace-nowrap transition-[background-color,color,box-shadow]",
                      active ? "bg-surface text-ink shadow-button ring-1 ring-ink/[0.06]" : "text-muted hover:text-ink",
                    )}
                  >
                    {t.label}
                    <span className={cx("num text-caption", active ? "text-muted" : "text-faint")}>{t.n}</span>
                  </Link>
                );
              })}
            </nav>

            {sites.length > 1 && (
              <label className="relative">
                <span className="sr-only">Site</span>
                <MapPin aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
                <select
                  value={site ?? ""}
                  onChange={(e) => router.replace(href(view?.id ?? null, e.target.value || null))}
                  className="h-11 cursor-pointer appearance-none rounded-full bg-surface pr-10 pl-9 text-small font-medium text-ink shadow-button ring-1 ring-line-strong transition hover:ring-ink/20 focus:ring-4 focus:ring-brand/20 focus:outline-none"
                >
                  <option value="">All sites</option>
                  {sites.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted" strokeWidth={2} />
              </label>
            )}
          </div>

          {view && <p className="mb-4 text-body text-muted">{VIEW_HINT[view.id]}</p>}

          {rows.length === 0 ? (
            <Empty title={`Nothing in “${view?.label ?? "this site"}”`} action={<Link href={href(null, null)} className={btnCls()}>See all contracts</Link>}>
              No contract is here right now.
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-card ring-1 ring-line">
              <div aria-hidden className={cx("hidden gap-6 bg-sunken px-6 py-3 text-small font-medium text-muted md:grid", COLS)}>
                <span>Contract</span>
                <span>Where it is</span>
                <span>Next step</span>
                <span className="text-right">Updated</span>
              </div>
              <ul aria-label="Contracts" className="divide-y divide-line">
                {rows.map((s) => (
                  <Row key={s.id} s={s} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
