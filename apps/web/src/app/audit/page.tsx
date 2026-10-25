"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Card, Empty, ErrorNote, PageTitle, Spinner, cx, inputCls } from "@/components/ui";
import { api } from "@/lib/api";
import { formatDateTime, formatValue } from "@/lib/format";
import { keys, useStudies } from "@/lib/queries";

const humanAction = (a: string) => a.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

export default function AuditPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const studyId = sp.get("studyId") ?? undefined;
  const studies = useStudies();
  const audit = useQuery({ queryKey: keys.audit(studyId), queryFn: () => api.audit(studyId) });
  const [q, setQ] = useState("");
  const name = useMemo(() => new Map((studies.data ?? []).map((s) => [s.id, `${s.sponsor ?? "Study"} ${s.protocol ?? ""}`])), [studies.data]);
  const rows = (audit.data ?? []).filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-6">
      <PageTitle title="Audit log" sub="Every correction, choice, note and sign-off. Append-only." />
      <div className="mb-3 flex flex-wrap gap-3">
        <select aria-label="Study" className={cx(inputCls, "w-auto")} value={studyId ?? ""} onChange={(e) => router.replace(e.target.value ? `/audit?studyId=${e.target.value}` : "/audit")}>
          <option value="">All studies</option>
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
        <Card>
          <table className="w-full text-sm">
            <thead className="bg-sunken text-left text-xs text-muted">
              <tr>
                {["When", "Who", "Study", "Action", "Details"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{formatDateTime(e.at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{e.by}</td>
                  <td className="px-3 py-2">
                    {e.studyId ? (
                      <Link href={`/studies/${e.studyId}`} className="hover:text-accent hover:underline">
                        {name.get(e.studyId) ?? e.studyId}
                      </Link>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{humanAction(e.action)}</td>
                  <td className="px-3 py-2">
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
