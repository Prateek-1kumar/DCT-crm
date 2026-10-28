"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Card, Empty, ErrorNote, PageTitle, pageCls, Spinner, cx, inputBase, inputCls } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatValue } from "@/lib/format";
import { keys } from "@/lib/queries";

const ACTION: Record<string, string> = {
  "study.created": "Contract added",
  "study.confirmed": "Details confirmed",
  "document.uploaded": "File uploaded",
  "document.kind_changed": "File kind changed",
  "amendment.uploaded": "Amendment uploaded",
  "extraction.queued": "Reading started",
  "extraction.succeeded": "Read and checked",
  "extraction.failed": "Couldn't read",
  "review.answered": "Question answered",
  "value.corrected": "Value corrected",
  "anomaly.resolved": "Problem settled",
  "grid.chosen": "Budget grid chosen",
  "version.manual_created": "Started typing by hand",
  "value.typed": "Typed by hand",
  "byhand.done": "Done typing",
  "number.reported": "Reported a number",
  "value.reported": "Reported a value",
  "version.signed": "Approved",
  "settings.updated": "Settings changed",
};
const humanAction = (a: string) => ACTION[a] ?? a.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

export default function AuditPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const studyId = sp.get("studyId") ?? undefined;
  // ponytail: the picker lists the first 100 contracts; make it a search box once there are more.
  const studies = useQuery({ queryKey: [...keys.studies, "top", 100], queryFn: () => api.listStudies({ limit: 100 }), select: (p) => p.items });
  const audit = useQuery({ queryKey: keys.audit(studyId), queryFn: () => api.audit(studyId) });
  const [q, setQ] = useState("");
  const name = useMemo(() => new Map((studies.data ?? []).map((s) => [s.id, `${s.sponsor ?? "Study"} ${s.protocol ?? ""}`])), [studies.data]);
  const rows = (audit.data ?? []).filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()));

  return (
    <div className={pageCls}>
      <PageTitle eyebrow="Audit trail" title="Activity" sub="Everything anyone did: uploads, answers, notes and approvals. Nothing is ever removed." />
      <div className="mb-3 flex flex-wrap gap-3">
        <select aria-label="Contract" className={cx(inputBase, "w-auto")} value={studyId ?? ""} onChange={(e) => router.replace(e.target.value ? `/audit?studyId=${e.target.value}` : "/audit")}>
          <option value="">All contracts</option>
          {studies.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {name.get(s.id)}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Search the log" placeholder="Search person, action, note…" className={cx(inputCls, "max-w-xs")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {audit.isPending && <Spinner />}
      <ErrorNote error={audit.error} />
      {audit.data && rows.length === 0 && <Empty title="Nothing logged yet" />}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-sunken text-left">
              <tr>
                {["When", "Who", "Contract", "What", "Details"].map((h) => (
                  <th key={h} scope="col" className="eyebrow px-4 py-2.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{formatDateTime(e.at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{e.by}</td>
                  <td className="px-4 py-2.5">
                    {e.studyId ? (
                      <Link href={`/studies/${e.studyId}`} className="hover:text-accent hover:underline">
                        {name.get(e.studyId) ?? e.studyId}
                      </Link>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{humanAction(e.action)}</td>
                  <td className="px-4 py-2.5">
                    <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      {Object.entries(e.detail).map(([k, v]) => (
                        <div key={k} className="flex gap-1">
                          <dt className="text-muted">{k}:</dt>
                          <dd className={k === "note" ? "italic" : "num"}>{formatValue(k === "before" || k === "after" ? String(e.detail.path ?? "") : k, v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
