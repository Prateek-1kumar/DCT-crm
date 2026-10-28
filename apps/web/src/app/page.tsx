"use client";

import type { StudySummaryDto } from "@dct/shared";
import Link from "next/link";
import { btnCls, Empty, ErrorNote, PageTitle, pageCls, Spinner, StagePill } from "@/components/ui";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useStudies } from "@/lib/queries";
import { minutesFor, summaryStage } from "@/lib/review";

const UploadIcon = () => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="size-[15px]">
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </svg>
);

function NeedsSomeone({ s }: { s: StudySummaryDto }) {
  const st = summaryStage(s);
  if (st.failed) return <span className="text-danger">Read it again</span>;
  if (st.stage === "Needs you") return <span>{st.needs} {st.needs === 1 ? "question" : "questions"} <span className="text-muted">· about {minutesFor(st.needs!)} min</span></span>;
  if (st.stage === "Approve") return <span className="text-accent">Ready to approve</span>;
  if (st.stage === "Upload") return <span>Check the details</span>;
  return <span className="text-faint">—</span>;
}

export default function ContractsPage() {
  const { data, error, isPending } = useStudies();
  const sites = new Map<string, StudySummaryDto[]>();
  for (const s of [...(data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const k = s.siteName ?? "No site yet";
    sites.set(k, [...(sites.get(k) ?? []), s]);
  }

  return (
    <div className={pageCls}>
      <PageTitle
        eyebrow="Contract setup"
        title="Contracts"
        sub="Each signed sponsor contract becomes an invoicing master. Nothing is billed from it until someone approves it."
        actions={
          <Link href="/studies/new" className={btnCls("primary")}>
            <UploadIcon /> Add contract
          </Link>
        }
      />
      {isPending && <Spinner />}
      <ErrorNote error={error} />
      {data?.length === 0 && (
        <Empty title="No contracts yet" action={<Link href="/studies/new" className={btnCls("primary")}>Add contract</Link>}>
          Upload a signed sponsor contract. It&apos;s read and checked against the PDF, and you answer only what needs a person.
        </Empty>
      )}
      <div className="flex flex-col gap-5">
        {[...sites].map(([site, rows]) => (
          <section key={site} aria-labelledby={`site-${site}`} className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
            <header className="flex items-center gap-2 border-b border-line px-5 py-3.5">
              <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="size-4 text-ink-2">
                <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
                <circle cx="12" cy="9.5" r="2.5" />
              </svg>
              <h2 id={`site-${site}`} className="text-lg">
                {site}
              </h2>
              <span className="text-[13px] text-muted">
                {rows.length} {rows.length === 1 ? "contract" : "contracts"}
              </span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-sunken text-left">
                  <tr>
                    {["Study", "Stage", "Needs someone", "Updated"].map((h) => (
                      <th key={h} scope="col" className="eyebrow px-5 py-2.5">
                        {h}
                      </th>
                    ))}
                    <th aria-hidden className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="relative border-t border-line hover:bg-accent-soft">
                      <td className="px-5 py-3">
                        {/* The link covers the whole row. */}
                        <Link href={`/studies/${s.id}`} className="after:absolute after:inset-0">
                          <span className="font-medium">{s.protocol ?? "New contract"}</span>{" "}
                          <span className="text-muted">
                            {s.sponsor ?? "Sponsor not confirmed yet"}
                            {s.status === "amendment_in_review" && " · new version in progress"}
                          </span>
                        </Link>
                      </td>
                      <td className="px-5 py-3">
                        <StagePill state={summaryStage(s)} />
                      </td>
                      <td className="px-5 py-3">
                        <NeedsSomeone s={s} />
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap text-muted" title={formatDateTime(s.updatedAt)}>
                        {relativeTime(s.updatedAt)}
                      </td>
                      <td aria-hidden className="pr-5 text-right text-muted">
                        →
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
