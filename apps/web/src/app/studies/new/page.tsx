"use client";

import type { DocumentDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { DocList, Dropzone } from "@/components/UploadDocs";
import { Button, Card, ErrorNote, Field, PageTitle, pageCls, ProgressBar, Stepper, inputCls } from "@/components/ui";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { keys, useJob, useStudy } from "@/lib/queries";

export default function NewStudyPage() {
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const by = useActingAs();
  const router = useRouter();
  // The created study lives in the URL, so a refresh (or "Confirm details" from the study page) resumes here.
  const sp = useSearchParams();
  const created = sp.get("study") ? { studyId: sp.get("study")!, jobId: sp.get("job") } : null;

  const usable = docs.filter((d) => !d.duplicateOf);
  const create = useMutation({
    mutationFn: () => api.createStudy(usable.map((d) => d.id), by!),
    onSuccess: (r) => router.replace(`/studies/new?study=${encodeURIComponent(r.studyId)}&job=${encodeURIComponent(r.jobId)}`),
  });

  function add(uploaded: DocumentDto[]) {
    const known = new Set(docs.map((d) => d.id));
    const fresh = uploaded.filter((d) => !known.has(d.id));
    setNotice(fresh.length < uploaded.length ? "Some files were already in this list and were skipped." : null);
    setDocs((cur) => [...cur, ...fresh]);
  }

  return (
    <div className={`${pageCls} max-w-[860px]`}>
      <PageTitle
        eyebrow="Add contract"
        title="Add a contract"
        sub={created ? "We sorted the files and filled in the study details from the cover page. Check them, then start reading." : "Upload every file for the study. We sort them and fill in the study details for you to check."}
      />
      <Stepper state={{ stage: "Upload" }} className="mb-6" />

      {!created ? (
        <div className="flex flex-col gap-4">
          <Dropzone onUploaded={add} />
          {notice && <p className="text-sm text-muted">{notice}</p>}
          <DocList docs={docs} onChange={(d) => setDocs((cur) => cur.map((x) => (x.id === d.id && !x.duplicateOf ? d : x)))} onRemove={(id) => setDocs((cur) => cur.filter((d) => d.id !== id))} />
          {docs.some((d) => d.duplicateOf) && (
            <p className="text-sm text-warn">Files marked “Already uploaded” were added before and won&apos;t be added again.</p>
          )}
          <div className="flex items-center justify-end gap-3">
            {!by && <NeedsPerson />}
            <ErrorNote error={create.error} />
            <Button variant="primary" disabled={!usable.length || !by || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Starting…" : "Next: check the details →"}
            </Button>
          </div>
        </div>
      ) : (
        <Identify
          studyId={created.studyId}
          jobId={created.jobId}
          // Next keeps this page mounted (Activity); start fresh next time.
          onStarted={() => setDocs([])}
        />
      )}
    </div>
  );
}

/** `jobId` null: identification already ran (resumed from the study page), go straight to the details. */
function Identify({ studyId, jobId, onStarted }: { studyId: string; jobId: string | null; onStarted: () => void }) {
  const job = useJob(jobId);
  const done = !jobId || job.data?.state === "succeeded";
  const qc = useQueryClient();
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: keys.study(studyId) });
  }, [done, qc, studyId]);

  if (job.error) return <ErrorNote error={job.error} />;
  if (job.data?.state === "failed")
    return (
      <div className="flex flex-col gap-4">
        <ErrorNote>We couldn&apos;t read the cover pages: {job.data.error}. You can still type the details below.</ErrorNote>
        <Confirm studyId={studyId} onStarted={onStarted} />
      </div>
    );
  if (!done)
    return (
      <Card className="p-5">
        <p className="mb-3 text-[13px]" aria-live="polite">{job.data?.step ?? "Starting"}…</p>
        <ProgressBar value={job.data?.progress ?? 0} label="Sorting the files" />
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
  // Prefilled from the cover-page suggestion until the person edits a field.
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
      router.push(`/studies/${studyId}/reading?job=${encodeURIComponent(jobId)}&v=${version}`);
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
        <h2 className="mb-1 text-lg">Files</h2>
        <p className="mb-3 text-[13px] text-muted">Check what kind of file each one is. Fix any that are wrong.</p>
        <DocList docs={study.data.documents} onChange={() => qc.invalidateQueries({ queryKey: keys.study(studyId) })} />
        {!hasMaster && (
          <p className="mt-3 text-sm text-warn">
            There&apos;s no master agreement in these files. If the work order refers to one, you&apos;ll be asked about it.
          </p>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="mb-1 text-lg">Study details</h2>
        <p className="mb-4 text-[13px] text-muted">Filled in from the cover page. Correct anything that&apos;s wrong.</p>
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
          {start.isPending ? "Starting…" : "Start reading →"}
        </Button>
      </div>
    </form>
  );
}
