"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, keys } from "@/lib/queries";
import { LinePanel } from "../contract/LinePanel";
import { useProofread } from "../contract/useProofread";
import { Skeleton } from "../study/Skeleton";
import { btnCls, Card, Empty, ErrorNote, LoadError, PageTitle, pageCls, ProgressBar } from "../ui";
import { buildLines, defaultLine, filterLines, needsChecking, progress, type Line, type LineFilter } from "./lines";
import { LineList } from "./LineList";
import { buildProof, type Spot } from "./model";
import { TotalsBar } from "./TotalsBar";
import { useProofUrl } from "./useProofUrl";

function ProofSkeleton() {
  return (
    <div className={pageCls} aria-label="Loading the proofread screen">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <Skeleton className="mt-8 h-20 w-full rounded-card" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Skeleton className="h-96 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </div>
    </div>
  );
}

/**
 * The full proofread view: the rulebook's lines on the left, the contract page on the right, each selecting the other.
 * COMPONENT: resizable panes (a draggable divider). Until then it is two fixed columns that stack below 1024px.
 */
export function ProofScreen({ versionId }: { versionId: string }) {
  const version = useQuery({ queryKey: keys.version(versionId), queryFn: () => api.version(versionId) });
  const coverage = useQuery({ queryKey: keys.coverage(versionId), queryFn: () => api.coverage(versionId) });
  const { url, set } = useProofUrl();
  const proofread = useProofread(versionId);
  const [filter, setFilter] = useState<LineFilter>("all");

  const data = useMemo(() => (version.data && coverage.data ? buildProof(version.data, coverage.data) : null), [version.data, coverage.data]);
  const lines = useMemo(() => (version.data ? buildLines(version.data) : []), [version.data]);

  const error = version.error ?? coverage.error;
  if (error) return <LoadError error={error} what="the proofread screen" retry={() => void Promise.all([version.refetch(), coverage.refetch()])} />;
  if (!version.data || !coverage.data) return <ProofSkeleton />;
  if (!data) {
    return (
      <div className={pageCls}>
        <Empty title="Nothing to proofread yet">The contract is still being read. The rulebook appears here once it is drafted.</Empty>
      </div>
    );
  }

  const v = version.data;
  const me = proofread.me;
  const visible = filterLines(lines, v, me, filter);
  const counts: Record<LineFilter, number> = { all: lines.length, needs: lines.filter((l) => needsChecking(l, v)).length, mine: filterLines(lines, v, me, "mine").length };
  const { done, total } = progress(lines, v);
  const spot: Spot | null = url.doc && url.page ? { doc: url.doc, page: url.page, box: url.box } : null;

  // Derived, not written to the URL: a link that names nothing opens on the first line to check, and Back doesn't step through it.
  // A link that names only a page or an amount (a missing one has no line) is left as it is.
  const ref = url.ref ?? (spot ? null : (defaultLine(lines, v)?.ref ?? null));

  const pick = (l: Line) => set({ ref: l.ref, doc: null, page: null, box: null });
  const nextMissing = () => {
    const missing = data.pages.flatMap((p) => p.amounts.flatMap((a, i): Spot[] => (a.status === "missing" ? [{ doc: p.documentId, page: p.page, box: i }] : [])));
    const at = missing.findIndex((m) => m.doc === spot?.doc && m.page === spot.page && m.box === spot.box);
    const next = missing[(at + 1) % missing.length];
    if (next) set({ ref: null, ...next });
  };

  return (
    <div className={pageCls}>
      <PageTitle
        eyebrow={v.rulebook?.study.protocol ?? undefined}
        title="Proofread"
        sub="Check each line of the rulebook against the contract page. Your marks are a record of who looked; approval doesn't wait for them."
        actions={
          <Link href={`/studies/${v.studyId}`} className={btnCls("secondary")}>
            Back to the contract
          </Link>
        }
      />
      <div className="grid gap-6">
        <Card className="grid gap-3 p-5">
          <p className="text-title font-semibold tracking-tight">
            {done} of {total} checked by someone
          </p>
          <ProgressBar value={total ? (done / total) * 100 : 0} label="Lines checked by someone" />
        </Card>
        <TotalsBar totals={data.totals} scanned={data.pages.filter((p) => p.kind === "image").length} onNext={nextMissing} />
        <ErrorNote error={proofread.error} />
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card className="min-w-0 p-4 max-lg:max-h-[60vh] max-lg:overflow-y-auto lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto">
            <LineList lines={lines} visible={visible} counts={counts} filter={filter} onFilter={setFilter} selected={ref} onSelect={pick} version={v} me={me} busy={proofread.busy} onProofread={proofread.run} />
          </Card>
          <Card className="min-w-0 p-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <h2 className="mb-3 text-title font-semibold tracking-tight">In the contract</h2>
            <LinePanel
              data={data}
              line={ref}
              spot={spot}
              onSpot={(s, ref) => (ref === undefined ? set({ doc: s.doc, page: s.page, box: null }) : set({ ref, doc: s.doc, page: s.page, box: s.box }))}
              scrollCls="max-h-[60vh]"
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
