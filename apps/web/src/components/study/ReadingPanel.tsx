"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, keys } from "@/lib/queries";
import type { Read, ReadStatus, VersionSummary } from "@/lib/types";
import { btnCls, Spinner } from "../ui";
import { elapsed, usd } from "./format";
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
  return (
    <p className="num text-small text-muted">
      {running ? "Reading for" : "Took"} {elapsed(end - start)} · {usd(read.spentUsd)} of {usd(read.budgetUsd)}
    </p>
  );
}

/** The reader's feed under the next-step card, for a version that is being read, has just been read, or failed. */
export function ReadingPanel({ studyId, version, canStart }: { studyId: string; version: VersionSummary; canStart: { ok: boolean; reason: string } }) {
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
  const questions = detail.data?.rulebook?.questions;
  const open = questions?.filter((q) => q.state === "open" && q.blocking).length;
  const feed = data && (version.status === "reading" ? <ReadingFeed read={data} /> : <FeedHistory read={data} />);

  if (version.status === "failed")
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-heading font-semibold tracking-tight">The reading didn&apos;t finish</h3>
          <p className="mt-1 text-body text-muted">{data?.error ?? "The reading stopped before it was done."}</p>
        </div>
        {data && <Meter read={data} />}
        <StartReading studyId={studyId} label="Start reading again" canStart={canStart} />
        {feed}
      </div>
    );

  if (version.status === "draft")
    return (
      <div className="flex flex-col gap-4">
        <h3 className="text-heading font-semibold tracking-tight">
          {open === undefined ? "Reading finished" : open === 0 ? "Reading finished: no questions need you" : `Reading finished: ${open} ${open === 1 ? "question needs" : "questions need"} you`}
        </h3>
        {data && <Meter read={data} />}
        <div>
          <Link href={`/versions/${version.id}/${open === 0 ? "approve" : "questions"}`} className={btnCls("primary", "lg")}>
            {open === 0 ? "Review and approve" : "Answer questions"}
          </Link>
        </div>
        {feed}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-heading font-semibold tracking-tight">Reading the contract</h3>
        <p className="mt-1 text-body text-muted">This takes a few minutes. You can leave this page; the reading carries on.</p>
      </div>
      {data ? (
        <>
          <Meter read={data} />
          {feed}
        </>
      ) : read.isError || detail.isError ? (
        <p className="text-body text-muted">We can&apos;t see the progress right now. It will show here when the connection is back.</p>
      ) : (
        <Spinner label="Getting ready to read" />
      )}
    </div>
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
