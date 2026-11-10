"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { BookOpen, CircleCheck, CircleDot, Download, Files, ListChecks, SpellCheck, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { downloadCsv } from "@/lib/csv";
import { allActivity, api, keys } from "@/lib/queries";
import type { ActivityItem, ActivityKind } from "@/lib/types";
import { useMounted } from "@/lib/use-mounted";
import { activityRows } from "../rulebook/export";
import { Button, Empty, ErrorNote, errorText, inputBase } from "../ui";
import { relativeTime, studyTitle, when } from "../study/format";
import { Skeleton } from "../study/Skeleton";
import { groupByDay } from "./days";

const PAGE = 30;

const ICON: Record<ActivityKind, LucideIcon> = {
  files: Files,
  reading: BookOpen,
  decision: ListChecks,
  approval: CircleCheck,
  proofread: SpellCheck,
  parties: Users,
  other: CircleDot,
};

function Row({ item, now, showContract }: { item: ActivityItem; now: number; showContract: boolean }) {
  const Icon = ICON[item.kind] ?? ICON.other;
  return (
    <li className="flex items-start gap-3.5 border-t border-line px-5 py-3.5 first:border-t-0">
      <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-accent">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">{item.summary}</p>
        {showContract && item.studyId && (
          <Link href={`/studies/${item.studyId}`} title={item.studyTitle ?? undefined} className="mt-0.5 block max-w-full truncate text-small font-medium text-accent hover:underline">
            {item.studyTitle ?? studyTitle(null)}
          </Link>
        )}
      </div>
      <time dateTime={item.at} title={when(item.at)} className="shrink-0 pt-0.5 text-small whitespace-nowrap text-muted">
        {relativeTime(item.at, now)}
      </time>
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div role="status" aria-label="Loading activity" className="overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-ink/[0.05]">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3.5 border-t border-line px-5 py-4 first:border-t-0">
          <Skeleton className="size-8" />
          <Skeleton className="h-4 w-2/3 max-w-[420px]" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

/** What has been done, newest first, by day. `studyId` limits it to one contract (and then each row skips the contract link). */
export function ActivityFeed({ studyId }: { studyId?: string }) {
  const mounted = useMounted();
  // Opening the tab or page should show what just happened, so the cache is trusted for seconds only.
  const feed = useInfiniteQuery({
    queryKey: keys.activity(studyId),
    queryFn: ({ pageParam }) => api.activity({ study: studyId, before: pageParam, limit: PAGE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 5_000,
  });
  const [now] = useState(() => Date.now());

  // The cache may already hold pages another screen fetched; drawing them on the hydrating render would not match the server's HTML.
  if (!mounted || (feed.isPending && !feed.isError)) return <FeedSkeleton />;
  if (!feed.data) return <ErrorNote error={feed.error} retry={() => void feed.refetch()} />;

  const items = feed.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <Empty title="Nothing has happened here yet.">Adding files, reading, answering decisions and approving will show up here.</Empty>;

  return (
    <div className="flex flex-col gap-6">
      {groupByDay(items, now).map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h2 className="mb-2 px-1 text-small font-semibold text-ink-2">{g.label}</h2>
          <ul className="overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-ink/[0.05]">
            {g.items.map((item) => (
              <Row key={item.id} item={item} now={now} showContract={!studyId} />
            ))}
          </ul>
        </section>
      ))}
      {feed.isFetchNextPageError && <ErrorNote error={feed.error} retry={() => void feed.fetchNextPage()} />}
      {feed.hasNextPage && !feed.isFetchNextPageError && (
        <div className="flex justify-center">
          <Button onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
            {feed.isFetchingNextPage ? "Loading…" : "Show earlier activity"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The feed for one contract, as the workspace's History tab. */
export function HistoryTab({ studyId }: { studyId: string }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-body text-muted">Who did what on this contract, newest first. It can&apos;t be edited.</p>
      <ActivityFeed studyId={studyId} />
    </div>
  );
}

// a date field's "2026-11-10" as the start of that day where the person is, not in UTC
const localDay = (value: string) => new Date(`${value}T00:00:00`).getTime();

/** The activity trail as a spreadsheet, for the dates chosen (both ends included); with no dates, everything. */
export function ActivityExport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; problem: boolean } | null>(null);
  const backwards = !!from && !!to && from > to;

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const until = to ? localDay(to) + 86_400_000 : Infinity;
      const items = (await allActivity({ since: from ? localDay(from) : undefined })).filter((i) => Date.parse(i.at) < until);
      if (items.length === 0) setNote({ text: "Nothing happened between those dates, so there is nothing to export.", problem: false });
      else downloadCsv(["activity", from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(" "), activityRows(items, true));
    } catch (e) {
      setNote({ text: errorText(e), problem: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
      <label className="flex flex-col gap-1 text-small font-medium text-ink-2">
        From
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputBase} />
      </label>
      <label className="flex flex-col gap-1 text-small font-medium text-ink-2">
        To
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputBase} />
      </label>
      <Button disabled={busy || backwards} onClick={() => void run()}>
        <Download aria-hidden className="size-4" strokeWidth={1.75} />
        {busy ? "Preparing…" : "Export activity (CSV)"}
      </Button>
      {backwards && <p className="text-small text-danger">“From” is after “To”. Swap the dates to export.</p>}
      {note && <p role={note.problem ? "alert" : "status"} className={`text-small ${note.problem ? "text-danger" : "text-muted"}`}>{note.text}</p>}
    </div>
  );
}
