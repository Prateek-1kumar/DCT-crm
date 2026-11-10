"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { inTab, LIST_TABS, matchesQuery, stepInfo, tabCounts, type ListTab } from "@/lib/steps";
import type { StudyRow } from "@/lib/types";
import { useMounted } from "@/lib/use-mounted";
import { Badge, btnCls, cx, Empty, ErrorNote, inputBase, PageTitle, pageCls } from "../ui";
import { relativeTime, studySub, studyTitle } from "./format";
import { Skeleton } from "./Skeleton";
import { StepDots } from "./StepDots";

const parse = (v: string | null): ListTab => (LIST_TABS.some((t) => t.id === v) ? (v as ListTab) : "all");

const EMPTY_TAB: Record<Exclude<ListTab, "all">, string> = {
  "needs-you": "Nothing needs you right now. Contracts with decisions to make show up here.",
  waiting: "No contract is waiting for approval.",
  live: "No contract is live yet. A contract goes live once its rulebook is approved.",
  failed: "No contract failed to read.",
};

function Row({ study, me }: { study: StudyRow; me: string | null }) {
  const info = stepInfo(study, me);
  const parties = [study.sponsor, study.payer].filter(Boolean).join(" · ");
  const where = [study.site, study.pi].filter(Boolean).join(" · ");
  const title = studyTitle(study.protocol, study.firstDocument);
  return (
    <tr className="border-t border-line align-top transition-colors hover:bg-sunken/60">
      <td className="max-w-[360px] min-w-[240px] px-5 py-4">
        <div className="flex items-center gap-2">
          <Link href={`/studies/${study.id}`} title={title} className="min-w-0 truncate text-body font-semibold text-ink hover:text-accent">
            {title}
          </Link>
          {info.newVersion && <Badge tone="accent" className="shrink-0">New version in progress</Badge>}
        </div>
        <p title={parties} className="truncate text-small text-muted">
          {parties || studySub(study.protocol, [])}
        </p>
        {where && (
          <p title={where} className="truncate text-small text-faint">
            {where}
          </p>
        )}
      </td>
      <td className="min-w-[190px] px-5 py-4">
        <StepDots info={info} />
        <p className={cx("mt-2 text-small font-medium", info.failed ? "text-danger" : "text-ink-2")}>{info.status}</p>
      </td>
      <td className="px-5 py-4">
        {info.next.disabled ? (
          <span title={info.next.reason ?? undefined}>
            <button type="button" disabled aria-label={`${info.next.label}. ${info.next.reason ?? ""}`} className={btnCls("secondary", "sm")}>
              {info.next.label}
            </button>
          </span>
        ) : (
          <Link href={info.next.href} className={btnCls(info.phase === "decisions" || info.phase === "approve" ? "primary" : "secondary", "sm")}>
            {info.next.label}
          </Link>
        )}
      </td>
      <td className="px-5 py-4 text-small whitespace-nowrap text-muted">
        <time dateTime={study.updatedAt} title={new Date(study.updatedAt).toLocaleString("en-US")}>
          {relativeTime(study.updatedAt)}
        </time>
      </td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <tbody aria-label="Loading your contracts">
      {[0, 1, 2, 3].map((i) => (
        <tr key={i} className="border-t border-line">
          <td className="px-5 py-4">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="mt-2 h-3 w-60" />
          </td>
          <td className="px-5 py-4">
            <Skeleton className="h-2 w-24" />
            <Skeleton className="mt-3 h-3 w-20" />
          </td>
          <td className="px-5 py-4">
            <Skeleton className="h-8 w-28" />
          </td>
          <td className="px-5 py-4">
            <Skeleton className="h-3 w-16" />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export function StudyList() {
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies });
  const me = useActingAs();
  const tab = parse(useSearchParams().get("filter"));
  const [search, setSearch] = useState("");

  const mounted = useMounted();
  // the sidebar may have filled the cache before this hydrates: drawing it then would not match the server's HTML
  const all = mounted ? studies.data : undefined;
  const pending = studies.isPending || !mounted;
  const counts = useMemo(() => (all ? tabCounts(all, me) : null), [all, me]);
  const shown = useMemo(
    () =>
      (all ?? [])
        .filter((s) => inTab(stepInfo(s, me), tab) && matchesQuery(s, search))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [all, me, tab, search],
  );

  const add = (
    <Link href="/studies/new" className={btnCls("primary")}>
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      Add contract
    </Link>
  );

  return (
    <div className={pageCls}>
      <PageTitle title="Contracts" sub="Every site contract, where it is, and what to do next." actions={add} />

      {all?.length === 0 ? (
        <Empty title="No contracts yet" action={add}>
          Add a signed contract and we&apos;ll read it and build its rulebook.
        </Empty>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Filter contracts" className="flex flex-wrap gap-2">
              {LIST_TABS.map((t) => (
                <Link
                  key={t.id}
                  href={t.id === "all" ? "/" : `/?filter=${t.id}`}
                  replace
                  aria-current={t.id === tab ? "page" : undefined}
                  className={cx(
                    "inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-small font-medium whitespace-nowrap transition-colors",
                    t.id === tab ? "border-ink bg-ink text-on-primary" : "border-line-strong bg-surface text-ink-2 hover:bg-sunken",
                  )}
                >
                  {t.label}
                  {counts && <span className={cx("num", t.id === tab ? "text-on-primary/70" : "text-faint")}>{counts[t.id]}</span>}
                </Link>
              ))}
            </nav>
            <label className="relative block w-full sm:w-[300px]">
              <span className="sr-only">Search contracts</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Protocol, sponsor, site or doctor" className={cx(inputBase, "w-full pl-10")} />
            </label>
          </div>

          {studies.isError && mounted ? (
            <ErrorNote error={studies.error} retry={() => void studies.refetch()} />
          ) : (
            <div className="overflow-x-auto rounded-card ring-1 ring-line">
              <table className="w-full min-w-[760px] text-left">
                <thead className="bg-sunken text-small text-muted">
                  <tr>
                    {["Contract", "Where it is", "Next step", "Updated"].map((h) => (
                      <th key={h} scope="col" className="px-5 py-3 font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                {pending ? (
                  <TableSkeleton />
                ) : (
                  <tbody>
                    {shown.map((s) => (
                      <Row key={s.id} study={s} me={me} />
                    ))}
                  </tbody>
                )}
              </table>
              {!pending && shown.length === 0 && (
                <p className="border-t border-line px-5 py-10 text-center text-body text-muted">
                  {search.trim() ? `No contract matches “${search.trim()}”. Try a protocol number, a sponsor, a site or a doctor.` : tab === "all" ? "No contracts to show." : EMPTY_TAB[tab]}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
