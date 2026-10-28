"use client";

import type { DocumentDto } from "@dct/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Info } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { DocList, Dropzone } from "@/components/UploadDocs";
import { Button, cx, ErrorNote, Field, inputCls, PageTitle, pageCls, ProgressBar, Spinner, Stepper } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { keys, useJob, useStudy } from "@/lib/queries";

/** One numbered part of the page; parts that aren't reached yet are dimmed. */
function Part({ n, title, sub, state, children }: { n: number; title: string; sub?: ReactNode; state: "now" | "done" | "later"; children: ReactNode }) {
  return (
    <li className={cx("rounded-card bg-surface p-7 ring-1 transition-opacity", state === "now" ? "shadow-card ring-ink/[0.06]" : "ring-line", state === "later" && "opacity-60")}>
      <div className="mb-5 flex items-start gap-4">
        <span
          className={cx(
            "grid size-9 shrink-0 place-items-center rounded-full text-small font-semibold",
            state === "done" ? "bg-ok-soft text-ok" : state === "now" ? "bg-primary text-on-primary" : "bg-ink/[0.06] text-faint",
          )}
        >
          {state === "done" ? <Check className="size-4" strokeWidth={2.5} /> : n}
        </span>
        <div className="pt-0.5">
          <h2 className="text-title font-semibold tracking-tight">{title}</h2>
          {sub && <p className="mt-0.5 text-body text-muted">{sub}</p>}
        </div>
      </div>
      {children}
    </li>
  );
}

export default function NewStudyPage() {
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const by = useActingAs();
  const router = useRouter();
  // The created study lives in the URL, so a refresh (or "Confirm the details" from the list) resumes here.
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
    <div className={`${pageCls} max-w-[920px]`}>
      <PageTitle title="Add a contract" sub="Upload the signed contract and its budget. We read every page, check every number against the PDF, and only ask you about what needs a person." />
      <Stepper state={{ stage: "Upload" }} now={created ? "Check the details" : "Add the files"} className="mb-10" />

      <ol className="flex flex-col gap-5">
        <Part n={1} title="Add the files" sub={created ? undefined : "Everything for this study: the contract, its budget, and any master agreement or amendment."} state={created ? "done" : "now"}>
          {created ? (
            <StudyFiles studyId={created.studyId} />
          ) : (
            <div className="flex flex-col gap-4">
              <Dropzone onUploaded={add} />
              {notice && <p className="text-small text-muted">{notice}</p>}
              <DocList docs={docs} onChange={(d) => setDocs((cur) => cur.map((x) => (x.id === d.id && !x.duplicateOf ? d : x)))} onRemove={(id) => setDocs((cur) => cur.filter((d) => d.id !== id))} />
              <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
                {!by && <NeedsPerson />}
                <ErrorNote error={create.error} />
                <Button variant="primary" size="lg" disabled={!usable.length || !by || create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? "Saving…" : usable.length ? `Continue with ${usable.length} ${usable.length === 1 ? "file" : "files"}` : "Continue"}
                  <ArrowRight className="size-[18px]" strokeWidth={2} />
                </Button>
              </div>
            </div>
          )}
        </Part>

        <Part n={2} title="Check the study details" sub={created ? "We filled these in from the cover pages. Correct anything that's wrong." : "Once the files are in, we fill in the sponsor, protocol, site and investigator for you to check."} state={created ? "now" : "later"}>
          {created && <Identify studyId={created.studyId} jobId={created.jobId} onStarted={() => setDocs([])} />}
        </Part>
      </ol>
    </div>
  );
}

/** Part 1 once the study exists: its files, kinds still editable. */
function StudyFiles({ studyId }: { studyId: string }) {
  const study = useStudy(studyId);
  const qc = useQueryClient();
  if (!study.data) return study.error ? <ErrorNote error={study.error} retry={() => void study.refetch()} /> : <Spinner label="Loading the files" />;
  const hasMaster = study.data.documents.some((d) => d.kind === "master_agreement");
  return (
    <div className="flex flex-col gap-3">
      <DocList docs={study.data.documents} onChange={() => qc.invalidateQueries({ queryKey: keys.study(studyId) })} />
      {!hasMaster && (
        <p className="flex items-start gap-2.5 rounded-tile bg-sunken px-4 py-3 text-small text-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" strokeWidth={2} />
          There&apos;s no master agreement among these files. If the contract refers to one, we&apos;ll ask you about it after reading.
        </p>
      )}
    </div>
  );
}

/** `jobId` null: the cover pages were already read (resumed from the list), go straight to the details. */
function Identify({ studyId, jobId, onStarted }: { studyId: string; jobId: string | null; onStarted: () => void }) {
  const job = useJob(jobId);
  const done = !jobId || job.data?.state === "succeeded";
  const qc = useQueryClient();
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: keys.study(studyId) });
  }, [done, qc, studyId]);

  if (job.error) return <ErrorNote error={job.error} retry={() => void job.refetch()} />;
  if (job.data?.state === "failed")
    return (
      <div className="flex flex-col gap-4">
        <ErrorNote>We couldn&apos;t read the cover pages. You can still type the details below.</ErrorNote>
        <Confirm studyId={studyId} onStarted={onStarted} />
      </div>
    );
  if (!done)
    return (
      <div className="flex flex-col gap-3 rounded-tile bg-sunken p-5" aria-live="polite">
        <Spinner label="Looking at the cover pages to fill in the details" />
        <ProgressBar value={job.data?.progress ?? 0} label="Reading the cover pages" />
      </div>
    );
  return <Confirm studyId={studyId} onStarted={onStarted} />;
}

const FIELDS = [
  ["sponsor", "Sponsor", "the company that owns the study"],
  ["protocol", "Protocol number", "as printed on the contract"],
  ["siteName", "Site", "the DCT site doing the study"],
  ["investigator", "Principal investigator", "the doctor named in the contract"],
] as const;
type Form = Record<(typeof FIELDS)[number][0], string>;

function Confirm({ studyId, onStarted }: { studyId: string; onStarted: () => void }) {
  const study = useStudy(studyId);
  const by = useActingAs();
  const router = useRouter();
  const qc = useQueryClient();
  const [edited, setForm] = useState<Form | null>(null);
  const suggested: Form | undefined = study.data && { sponsor: study.data.sponsor ?? "", protocol: study.data.protocol ?? "", siteName: study.data.siteName ?? "", investigator: study.data.investigator ?? "" };
  // Prefilled from the cover-page suggestion until the person edits a field.
  const form = edited ?? suggested;

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

  if (!form || !suggested) return study.error ? <ErrorNote error={study.error} retry={() => void study.refetch()} /> : <Spinner label="Loading the details" />;
  const missing = FIELDS.filter(([k]) => !form[k].trim());

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {FIELDS.map(([k, label, hint]) => (
          <Field
            key={k}
            label={label}
            htmlFor={`f-${k}`}
            hint={suggested[k] ? (form[k] === suggested[k] ? `Filled in from the cover page · ${hint}` : hint[0]!.toUpperCase() + hint.slice(1)) : <span className="text-warn">Not found on the cover page. Type it in.</span>}
          >
            <input id={`f-${k}`} required className={inputCls} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
        <p className="max-w-[44ch] text-small text-muted">Reading takes a few minutes. You can leave this page; we&apos;ll let you know when it&apos;s ready.</p>
        <div className="flex flex-wrap items-center gap-3">
          {!by && <NeedsPerson />}
          <ErrorNote error={start.error} />
          <Button type="submit" variant="primary" size="lg" disabled={!by || missing.length > 0 || start.isPending}>
            {start.isPending ? "Starting…" : "Start reading"}
            <ArrowRight className="size-[18px]" strokeWidth={2} />
          </Button>
        </div>
      </div>
    </form>
  );
}
