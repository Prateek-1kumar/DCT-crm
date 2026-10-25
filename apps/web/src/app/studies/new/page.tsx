"use client";

import type { DocumentDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { DocList, Dropzone } from "@/components/UploadDocs";
import { Button, Card, ErrorNote, Field, PageTitle, ProgressBar, cx, inputCls } from "@/components/ui";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { keys, useJob, useStudy } from "@/lib/queries";

const STEPS = ["Upload", "Confirm details", "Extract"];

export default function NewStudyPage() {
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<{ studyId: string; jobId: string } | null>(null);
  const by = useActingAs();

  const usable = docs.filter((d) => !d.duplicateOf);
  const create = useMutation({ mutationFn: () => api.createStudy(usable.map((d) => d.id), by!), onSuccess: setCreated });

  function add(uploaded: DocumentDto[]) {
    const known = new Set(docs.map((d) => d.id));
    const fresh = uploaded.filter((d) => !known.has(d.id));
    setNotice(fresh.length < uploaded.length ? "Some files were already in this list and were skipped." : null);
    setDocs((cur) => [...cur, ...fresh]);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6">
      <PageTitle title="Bring a study on board" sub="Upload every document for the study. The AI sorts them and suggests the study details." />
      <ol className="mb-6 flex gap-2 text-sm" aria-label="Progress">
        {STEPS.map((s, i) => {
          const at = created ? 1 : 0;
          return (
            <li key={s} aria-current={i === at ? "step" : undefined} className={cx("flex items-center gap-2", i === at ? "font-medium text-ink" : "text-faint")}>
              <span className={cx("grid size-6 place-items-center rounded-full border text-xs", i < at ? "border-ok bg-ok-soft text-ok" : i === at ? "border-accent text-accent" : "border-line")}>
                {i < at ? "✓" : i + 1}
              </span>
              {s}
              {i < STEPS.length - 1 && <span aria-hidden className="mx-1 text-faint">—</span>}
            </li>
          );
        })}
      </ol>

      {!created ? (
        <div className="flex flex-col gap-4">
          <Dropzone onUploaded={add} />
          {notice && <p className="text-sm text-muted">{notice}</p>}
          <DocList docs={docs} onChange={(d) => setDocs((cur) => cur.map((x) => (x.id === d.id && !x.duplicateOf ? d : x)))} onRemove={(id) => setDocs((cur) => cur.filter((d) => d.id !== id))} />
          {docs.some((d) => d.duplicateOf) && (
            <p className="text-sm text-warn">Duplicates are already stored (matched by sha256) and won&apos;t be added to this study.</p>
          )}
          <div className="flex items-center justify-end gap-3">
            {!by && <NeedsPerson />}
            <ErrorNote error={create.error} />
            <Button variant="primary" disabled={!usable.length || !by || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Starting…" : `Identify ${usable.length || ""} document${usable.length === 1 ? "" : "s"} →`}
            </Button>
          </div>
        </div>
      ) : (
        <Identify
          studyId={created.studyId}
          jobId={created.jobId}
          // Next keeps this page mounted (Activity); start fresh next time.
          onStarted={() => (setDocs([]), setCreated(null))}
        />
      )}
    </div>
  );
}

function Identify({ studyId, jobId, onStarted }: { studyId: string; jobId: string; onStarted: () => void }) {
  const job = useJob(jobId);
  const done = job.data?.state === "succeeded";
  const qc = useQueryClient();
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: keys.study(studyId) });
  }, [done, qc, studyId]);

  if (job.error) return <ErrorNote error={job.error} />;
  if (job.data?.state === "failed")
    return <ErrorNote>Couldn&apos;t identify the documents: {job.data.error}. You can still enter the details below.</ErrorNote>;
  if (!done)
    return (
      <Card className="p-5">
        <p className="mb-3 text-sm font-medium">{job.data?.step ?? "Starting"}…</p>
        <ProgressBar value={job.data?.progress ?? 0} label="Identifying documents" />
      </Card>
    );
  return <Confirm studyId={studyId} onStarted={onStarted} />;
}

function Confirm({ studyId, onStarted }: { studyId: string; onStarted: () => void }) {
  const study = useStudy(studyId);
  const by = useActingAs();
  const router = useRouter();
  const qc = useQueryClient();
  const [edited, setForm] = useState<{ sponsor: string; protocol: string; siteName: string; investigator: string } | null>(null);
  // Prefilled from the AI's suggestion until the person edits a field.
  const form =
    edited ??
    (study.data && { sponsor: study.data.sponsor ?? "", protocol: study.data.protocol ?? "", siteName: study.data.siteName ?? "", investigator: study.data.investigator ?? "" });

  const start = useMutation({
    mutationFn: async () => {
      await api.confirmStudy(studyId, { ...form!, by: by! });
      return api.extract(studyId, by!);
    },
    onSuccess: ({ jobId, version }) => {
      void qc.invalidateQueries({ queryKey: keys.studies });
      router.push(`/studies/${studyId}/extracting?job=${encodeURIComponent(jobId)}&v=${version}`);
      onStarted();
    },
  });

  if (!study.data || !form) return <ErrorNote error={study.error} />;
  const fields: [keyof typeof form, string][] = [
    ["sponsor", "Sponsor"],
    ["protocol", "Protocol number"],
    ["siteName", "Site"],
    ["investigator", "Principal investigator"],
  ];
  const missing = fields.filter(([k]) => !form[k].trim());
  const hasMaster = study.data.documents.some((d) => d.kind === "master_agreement");

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Documents</h2>
        <p className="mb-3 text-sm text-muted">Check each detected kind. Fix any that are wrong.</p>
        <DocList docs={study.data.documents} onChange={() => qc.invalidateQueries({ queryKey: keys.study(studyId) })} />
        {!hasMaster && (
          <p className="mt-3 text-sm text-warn">
            No master agreement in this upload. If the work order refers to one, terms that depend on it will be marked unverified.
          </p>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Study details</h2>
        <p className="mb-4 text-sm text-muted">Suggested from the cover pages. Confirm or correct.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(([k, label]) => (
            <Field key={k} label={label} htmlFor={`f-${k}`}>
              <input id={`f-${k}`} required className={inputCls} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      </Card>
      <div className="flex items-center justify-end gap-3">
        {!by && <NeedsPerson />}
        <ErrorNote error={start.error} />
        <Button type="submit" variant="primary" disabled={!by || missing.length > 0 || start.isPending}>
          {start.isPending ? "Starting…" : "Confirm and start extraction →"}
        </Button>
      </div>
    </form>
  );
}
