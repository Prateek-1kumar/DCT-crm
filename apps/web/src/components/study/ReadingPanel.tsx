"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, keys } from "@/lib/queries";
import type { Read, ReadStatus, VersionSummary } from "@/lib/types";
import { Card, ProgressBar, Spinner } from "../ui";
import { elapsed } from "./format";
import { StartReading } from "./StartReading";

const POLL_MS = 1500;
const live = (status: ReadStatus | undefined) => status === "queued" || status === "running";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ReadingFeed({ read }: { read: Read }) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [read.progress.length]);

  return (
    <div
      ref={box}
      role="log"
      aria-label="What the reader is doing"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-64 overflow-y-auto rounded-field bg-sunken px-4 py-3"
    >
      {read.progress.length === 0 ? (
        <p className="text-body text-muted">Getting ready to read…</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {read.progress.map((line, i) => (
            <li key={i} className="text-body text-ink-2">
              {line}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Meter({ read }: { read: Read }) {
  const running = live(read.status);
  const now = useNow(running);
  const start = Date.parse(read.startedAt ?? read.createdAt);
  const end = running ? now : Date.parse(read.finishedAt ?? read.createdAt);
  // Accountants never see money: the allowance is only a bar.
  const used = read.budgetUsd > 0 ? (read.spentUsd / read.budgetUsd) * 100 : 0;
  return (
    <div className="flex flex-col gap-2">
      <p className="num text-small text-muted">
        {running ? "Reading for" : "Ran for"} {elapsed(end - start)}
      </p>
      <div className="max-w-[320px]">
        <ProgressBar value={used} label="How much of the reading allowance is used" />
      </div>
    </div>
  );
}

/** The reader's live feed (or why it stopped) for a version that is being read or whose read failed. */
export function ReadingPanel({ studyId, version }: { studyId: string; version: VersionSummary }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: keys.version(version.id), queryFn: () => api.version(version.id) });
  const readId = detail.data?.read?.id;
  const read = useQuery({
    queryKey: keys.read(readId ?? ""),
    queryFn: () => api.read(readId!),
    enabled: !!readId,
    refetchInterval: (q) => (live(q.state.data?.status) ? POLL_MS : false),
  });
  const status = read.data?.status;

  useEffect(() => {
    if (status !== "done" && status !== "failed") return;
    void queryClient.invalidateQueries({ queryKey: keys.study(studyId) });
    void queryClient.invalidateQueries({ queryKey: keys.studies });
    void queryClient.invalidateQueries({ queryKey: keys.version(version.id) });
  }, [status, studyId, version.id, queryClient]);

  const data = read.data;

  if (version.status === "failed")
    return (
      <Card className="flex flex-col gap-4 p-6">
        <div>
          <h2 className="text-title font-semibold tracking-tight">The reading didn&apos;t finish</h2>
          <p className="mt-1 text-body text-muted">{data?.error ?? "The reading stopped before it was done."}</p>
          <p className="mt-1 text-body text-muted">Scanned pages that were already transcribed are kept, so starting again won&apos;t redo them.</p>
        </div>
        {data && <Meter read={data} />}
        <StartReading studyId={studyId} label="Start again" />
        {data && <FeedHistory read={data} />}
      </Card>
    );

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-title font-semibold tracking-tight">Reading the contract</h2>
        <p className="mt-1 text-body text-muted">This takes a few minutes. You can leave this page; we&apos;ll keep reading and the contract will be ready when you come back.</p>
      </div>
      {data ? (
        <>
          <Meter read={data} />
          <ReadingFeed read={data} />
        </>
      ) : read.isError || detail.isError ? (
        <p className="text-body text-muted">We can&apos;t see the progress right now. It will show here when the connection is back.</p>
      ) : (
        <Spinner label="Getting ready to read" />
      )}
    </Card>
  );
}

function FeedHistory({ read }: { read: Read }) {
  return (
    <details>
      <summary className="cursor-pointer text-small font-medium text-accent">What the reader did</summary>
      <div className="mt-2">
        <ReadingFeed read={read} />
      </div>
    </details>
  );
}
