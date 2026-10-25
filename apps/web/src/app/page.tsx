"use client";

import type { StudyStatus, StudySummaryDto } from "@dct/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Card, btnCls, Empty, ErrorNote, PageTitle, Spinner, StatusBadge, cx, inputCls } from "@/components/ui";
import { STATUS_LABEL, formatDateTime, relativeTime } from "@/lib/format";
import { useStudies } from "@/lib/queries";

const IN_REVIEW: StudyStatus[] = ["needs_review", "amendment_in_review"];

/** Drafts open straight into review; everything else the study page. */
const studyHref = (s: Pick<StudySummaryDto, "id" | "status">) => `/studies/${s.id}${IN_REVIEW.includes(s.status) ? "/review" : ""}`;

export default function StudiesPage() {
  const { data, error, isPending } = useStudies();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StudyStatus | "all">("all");

  const queue = useMemo(
    () => (data ?? []).filter((s) => IN_REVIEW.includes(s.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [data],
  );
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((s) => status === "all" || s.status === status)
      .filter((s) => !needle || [s.sponsor, s.protocol, s.siteName, s.investigator].some((f) => f?.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data, q, status]);
  const counts = useMemo(() => {
    const c: Partial<Record<StudyStatus, number>> = {};
    for (const s of data ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-6">
      <PageTitle
        title="Studies"
        sub="Every sponsor contract, its rulebook and where it stands."
        actions={
          <Link href="/studies/new" className={btnCls("primary")}>
            + New study
          </Link>
        }
      />
      {isPending && <Spinner />}
      <ErrorNote error={error} />
      {data && data.length === 0 && (
        <Empty
          title="No studies yet"
          action={
            <Link href="/studies/new" className="font-medium text-accent underline-offset-2 hover:underline">
              Bring a study on board →
            </Link>
          }
        >
          Drop the signed contract PDFs and the AI will draft the rulebook for you to review.
        </Empty>
      )}

      {queue.length > 0 && (
        <section aria-labelledby="queue-h" className="mb-8">
          <h2 id="queue-h" className="mb-2 flex items-center gap-2 text-sm font-semibold">
            Needs review <Badge tone="warn">{queue.length}</Badge>
            <span className="font-normal text-muted">· oldest first</span>
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {queue.map((s) => (
              <li key={s.id}>
                <Link href={studyHref(s)} className="group block rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium group-hover:text-accent">{s.sponsor ?? "Unnamed study"}</p>
                      <p className="num truncate text-sm text-muted">{s.protocol ?? "—"}</p>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span className={cx("font-medium", s.openAnomalies ? "text-danger" : "text-ok")}>
                      {s.openAnomalies ? `${s.openAnomalies} open ${s.openAnomalies === 1 ? "anomaly" : "anomalies"}` : "Ready to sign off"}
                    </span>
                    <span className="text-muted" title={formatDateTime(s.updatedAt)}>
                      waiting {relativeTime(s.updatedAt).replace(" ago", "")}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && data.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
            <input
              type="search"
              aria-label="Search studies"
              placeholder="Search sponsor, protocol, site, PI…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className={cx(inputCls, "max-w-xs")}
            />
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
              {(["all", ...Object.keys(STATUS_LABEL)] as (StudyStatus | "all")[]).map((k) => {
                const n = k === "all" ? data.length : (counts[k] ?? 0);
                if (k !== "all" && !n) return null;
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={status === k}
                    onClick={() => setStatus(k)}
                    className={cx("rounded-full border px-2.5 py-1 text-xs", status === k ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-ink")}
                  >
                    {k === "all" ? "All" : STATUS_LABEL[k]} <span className="num">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  {["Sponsor", "Protocol", "Site · PI", "Status", "Live version", "Open anomalies", "Updated"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-t border-line hover:bg-sunken/60">
                    <td className="px-3 py-2.5">
                      <Link href={studyHref(s)} className="font-medium hover:text-accent hover:underline">
                        {s.sponsor ?? "Unnamed study"}
                      </Link>
                    </td>
                    <td className="num px-3 py-2.5">{s.protocol ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {s.siteName ?? "—"} <span className="text-muted">· {s.investigator ?? "—"}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="num px-3 py-2.5">{s.liveVersion ? `v${s.liveVersion}` : <span className="text-faint">—</span>}</td>
                    <td className="num px-3 py-2.5">{s.openAnomalies ? <span className="font-medium text-danger">{s.openAnomalies}</span> : <span className="text-faint">0</span>}</td>
                    <td className="px-3 py-2.5 text-muted" title={formatDateTime(s.updatedAt)}>
                      {relativeTime(s.updatedAt)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted">
                      No studies match.{" "}
                      <button type="button" className="text-accent underline" onClick={() => (setQ(""), setStatus("all"))}>
                        Clear filters
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
