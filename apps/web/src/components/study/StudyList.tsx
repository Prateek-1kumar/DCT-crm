"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api, keys } from "@/lib/queries";
import type { StudyRow } from "@/lib/types";
import { Badge, btnCls, Card, Empty, ErrorNote, PageTitle, pageCls, Spinner } from "../ui";
import { studySub, studyTitle, VERSION_PILL } from "./format";

function StudyItem({ study }: { study: StudyRow }) {
  const pill = study.latestVersion ? VERSION_PILL[study.latestVersion.status] : { label: "Not started", tone: "neutral" as const };
  return (
    <li>
      <Link href={`/studies/${study.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-card px-6 py-5 transition-colors hover:bg-sunken">
        <span className="min-w-0">
          <span className="block text-title font-semibold tracking-tight">{studyTitle(study.protocol, study.firstDocument)}</span>
          <span className="block text-body text-muted">{studySub(study.protocol, [study.sponsor, study.payer, study.site])}</span>
        </span>
        <span className="flex items-center gap-3">
          {study.latestVersion && <span className="text-small text-faint">Version {study.latestVersion.number}</span>}
          <Badge tone={pill.tone}>{pill.label}</Badge>
        </span>
      </Link>
    </li>
  );
}

export function StudyList() {
  const studies = useQuery({ queryKey: keys.studies, queryFn: api.studies });
  const newContract = (
    <Link href="/studies/new" className={btnCls("primary")}>
      New contract
    </Link>
  );
  return (
    <div className={pageCls}>
      <PageTitle title="Contracts" actions={studies.data?.length ? newContract : undefined} />
      {studies.isPending ? (
        <Spinner label="Loading your contracts" />
      ) : studies.isError ? (
        <ErrorNote error={studies.error} retry={() => void studies.refetch()} />
      ) : studies.data.length === 0 ? (
        <Empty title="No contracts yet" action={newContract}>
          Add a contract to get started. You upload the PDF, answer the questions we can&apos;t settle ourselves, and approve the rulebook.
        </Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {studies.data.map((s) => (
              <StudyItem key={s.id} study={s} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
