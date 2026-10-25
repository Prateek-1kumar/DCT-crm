"use client";

import type { StudyDetailDto } from "@dct/shared";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { DiffView } from "@/components/DiffView";
import { RulebookView } from "@/components/RulebookView";
import { DocList } from "@/components/UploadDocs";
import { Badge, Button, ErrorNote, Spinner, StatusBadge, btnCls, cx, inputBase } from "@/components/ui";
import { Workspace } from "@/components/Workspace";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { formatDate, formatDateTime } from "@/lib/format";
import { useDiff, useInvalidateStudy, useStudy, useVersion } from "@/lib/queries";

type Tab = "rulebook" | "versions" | "documents";

export default function StudyPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const study = useStudy(id);
  const [tab, setTab] = useState<Tab>("rulebook");
  const invalidate = useInvalidateStudy();

  if (study.error) return <div className="p-6"><ErrorNote error={study.error} /></div>;
  if (!study.data) return <div className="p-6"><Spinner /></div>;
  const s = study.data;
  const draft = [...s.versions].reverse().find((v) => v.status === "draft");
  const signed = sp.get("signed");

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-line bg-surface px-5 pt-5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-start gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted">
              <Link href="/" className="hover:underline">
                Studies
              </Link>{" "}
              /
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              {s.sponsor ?? "Unnamed study"} <span className="num font-normal text-muted">{s.protocol}</span>
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <StatusBadge status={s.status} />
              {s.siteName} · {s.investigator}
              {s.liveVersion && <Badge tone="ok">Live: v{s.liveVersion}</Badge>}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {draft && (
              <Link href={`/studies/${s.id}/review?v=${draft.version}`} className={btnCls("primary")}>
                {s.openAnomalies ? `Review v${draft.version} · ${s.openAnomalies} open` : `Review v${draft.version}`}
              </Link>
            )}
            {s.status === "live" && !draft && (
              <Link href={`/studies/${s.id}/amend`} className={btnCls()}>
                Upload amendment
              </Link>
            )}
            <Link href={`/audit?studyId=${s.id}`} className={btnCls("ghost")}>
              Audit log
            </Link>
          </div>
        </div>
        {signed && (
          <p role="status" className="mx-auto mt-3 max-w-[1600px] rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
            ✓ Version {signed} signed off and live.
          </p>
        )}
        {s.status === "extracting" && (
          <p className="mx-auto mt-3 max-w-[1600px]">
            <Spinner label="Extraction is running. This page updates when it's done" />
          </p>
        )}
        {/* also a failed amendment extraction, which leaves the study amendment_in_review */}
        {[...s.versions].sort((a, b) => b.version - a.version)[0]?.status === "failed" && <FailedBox study={s} />}
        <div role="tablist" aria-label="Study" className="mx-auto mt-4 flex max-w-[1600px] gap-1">
          {(
            [
              ["rulebook", "Rulebook"],
              ["versions", `Versions & changes (${s.versions.length})`],
              ["documents", `Documents (${s.documents.length})`],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx("-mb-px border-b-2 px-3 py-2 text-sm", tab === k ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {tab === "rulebook" && <RulebookTab study={s} />}
      {tab === "versions" && <VersionsTab study={s} />}
      {tab === "documents" && (
        <div className="mx-auto w-full max-w-3xl p-5">
          <DocList docs={s.documents} onChange={() => void invalidate(s.id)} />
          <p className="mt-2 text-xs text-muted">Changing a kind affects the next extraction, not signed versions.</p>
        </div>
      )}
    </div>
  );
}

function FailedBox({ study }: { study: StudyDetailDto }) {
  const by = useActingAs();
  const router = useRouter();
  const invalidate = useInvalidateStudy();
  const retry = useMutation({
    mutationFn: () => api.extract(study.id, by!),
    onSuccess: (r) => router.push(`/studies/${study.id}/extracting?job=${encodeURIComponent(r.jobId)}&v=${r.version}`),
  });
  const manual = useMutation({
    mutationFn: () => api.createManualVersion(study.id, by!),
    onSuccess: async (r) => (await invalidate(study.id), router.push(`/studies/${study.id}/review?v=${r.version}`)),
  });
  return (
    <div className="mx-auto mt-3 flex max-w-[1600px] flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
      <span className="text-danger">The last extraction failed.</span>
      <Button size="sm" variant="primary" disabled={!by || retry.isPending} onClick={() => retry.mutate()}>
        Retry extraction
      </Button>
      <Button size="sm" disabled={!by || manual.isPending} onClick={() => manual.mutate()}>
        Enter manually
      </Button>
      {!by && <NeedsPerson />}
      <ErrorNote error={retry.error ?? manual.error} />
    </div>
  );
}

function RulebookTab({ study }: { study: StudyDetailDto }) {
  const withBook = [...study.versions].filter((v) => v.status !== "failed" && v.status !== "extracting").sort((a, b) => b.version - a.version);
  const [picked, setPicked] = useState<number | null>(null);
  const v = picked ?? study.liveVersion ?? withBook[0]?.version ?? null;
  const version = useVersion(study.id, v);
  if (v === null) return <p className="p-6 text-sm text-muted">No rulebook yet.</p>;
  if (!version.data) return <div className="p-6">{version.error ? <ErrorNote error={version.error} /> : <Spinner />}</div>;
  const meta = study.versions.find((x) => x.version === v);
  return (
    <Workspace study={study} version={version.data} editable={false}>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">Version</span>
          <select className={cx(inputBase, "w-auto")} value={v} onChange={(e) => setPicked(Number(e.target.value))}>
            {withBook.map((x) => (
              <option key={x.version} value={x.version}>
                v{x.version} · {x.status}
                {x.version === study.liveVersion ? " (live)" : ""}
              </option>
            ))}
          </select>
        </label>
        {meta?.signedBy && (
          <span className="text-muted">
            Signed by {meta.signedBy} · {formatDateTime(meta.signedAt)}
          </span>
        )}
        {meta?.appliesFrom && <span className="text-muted">Applies from {formatDate(meta.appliesFrom)}</span>}
        <span className="text-muted">Read-only. Click any value to see it in the contract.</span>
      </div>
      <RulebookView />
    </Workspace>
  );
}

function VersionsTab({ study }: { study: StudyDetailDto }) {
  const vs = [...study.versions].sort((a, b) => b.version - a.version);
  const comparable = vs.filter((v) => v.status !== "failed" && v.status !== "extracting");
  const [to, setTo] = useState<number | null>(comparable[0]?.version ?? null);
  const [from, setFrom] = useState<number | null>(comparable[1]?.version ?? null);
  const diff = useDiff(study.id, to, from);
  return (
    <div className="mx-auto w-full max-w-5xl p-5">
      <table className="mb-8 w-full rounded-card border border-line bg-surface text-sm">
        <thead className="bg-sunken text-left text-xs text-muted">
          <tr>
            {["Version", "Status", "Created", "Signed", "Applies from", ""].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vs.map((v, i) => (
            <tr key={v.version} className="border-t border-line">
              <td className="num px-3 py-2 font-medium">v{v.version}</td>
              <td className="px-3 py-2">
                <Badge tone={v.status === "signed" ? "ok" : v.status === "draft" ? "warn" : v.status === "failed" ? "danger" : "neutral"}>{v.status}</Badge>
              </td>
              <td className="px-3 py-2 text-muted">{formatDateTime(v.createdAt)}</td>
              <td className="px-3 py-2">{v.signedBy ? `${v.signedBy} · ${formatDate(v.signedAt)}` : <span className="text-faint">—</span>}</td>
              <td className="px-3 py-2">{formatDate(v.appliesFrom)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {v.status === "draft" && (
                  <Link href={`/studies/${study.id}/review?v=${v.version}`} className="text-accent hover:underline">
                    Review
                  </Link>
                )}
                {vs[i + 1] && comparable.some((c) => c.version === v.version) && (
                  <button type="button" className="ml-3 text-accent hover:underline" onClick={() => (setTo(v.version), setFrom(comparable.find((c) => c.version < v.version)?.version ?? null))}>
                    Changes vs previous
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mb-3 font-semibold">Compare versions</h2>
      {comparable.length < 2 ? (
        <p className="text-sm text-muted">There is only one version so far. Changes appear here once an amendment is extracted.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <VersionSelect label="From" value={from} onChange={setFrom} options={comparable} />
            <span className="text-faint">→</span>
            <VersionSelect label="To" value={to} onChange={setTo} options={comparable} />
          </div>
          {from === to ? (
            <p className="text-sm text-muted">Pick two different versions.</p>
          ) : diff.data ? (
            <DiffView entries={diff.data} title={`v${from} → v${to}`} />
          ) : diff.error ? (
            <ErrorNote error={diff.error} />
          ) : (
            <Spinner />
          )}
        </>
      )}
    </div>
  );
}

function VersionSelect({ label, value, onChange, options }: { label: string; value: number | null; onChange: (n: number) => void; options: { version: number; status: string }[] }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <select className={cx(inputBase, "w-auto")} value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o) => (
          <option key={o.version} value={o.version}>
            v{o.version} · {o.status}
          </option>
        ))}
      </select>
    </label>
  );
}
