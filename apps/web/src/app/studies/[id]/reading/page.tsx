"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, BellRing, Check, FileWarning, Keyboard, RotateCcw, ScanText } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { CheckResult } from "@/components/CheckResult";
import { NeedsPerson } from "@/components/Sidebar";
import { Button, cx, ErrorNote, PageTitle, pageCls, ProgressBar, Stepper } from "@/components/ui";
import { useActingAs } from "@/lib/acting-as";
import { api } from "@/lib/api";
import { notify, useNotifyPermission } from "@/lib/notify";
import { useInvalidateStudy, useJob, useStudy, useVersion } from "@/lib/queries";
import { minutesFor, needsYou, versionStage, type StageState } from "@/lib/review";

/**
 * Plain steps, ticked off by job progress. From "Checking…" on, the stage is Checking.
 * ponytail: thresholds stand in for a job phase the API doesn't report yet (JobDto.phase, ADR-001 step 5).
 */
const PHASES: [at: number, label: string, what: string][] = [
  [0, "Opening the files", "Sorting contract pages from budget tables"],
  [15, "Reading the contract terms", "Payment terms, fees, holdback and deadlines"],
  [40, "Reading the budget table", "Every visit and every procedure"],
  [62, "Checking every number against the PDF", "Each number is matched to the spot where it's printed"],
  [84, "Listing what needs you", "Only what a person has to confirm"],
];
const CHECKING_AT = 62;

function Heading({ icon, tone, title, sub }: { icon: ReactNode; tone: string; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className={cx("relative grid size-12 shrink-0 place-items-center rounded-tile", tone)}>{icon}</span>
      <div>
        <h2 className="text-heading font-semibold tracking-tight">{title}</h2>
        <p className="text-body text-muted">{sub}</p>
      </div>
    </div>
  );
}

function NotifyMe() {
  const { permission, ask } = useNotifyPermission();
  if (permission === "unsupported" || permission === "denied") return null;
  if (permission === "granted")
    return (
      <p className="flex items-center gap-2 text-small text-muted">
        <BellRing className="size-4 text-accent" strokeWidth={1.75} /> We&apos;ll send a desktop alert when it&apos;s ready, even if you switch tabs.
      </p>
    );
  return (
    <Button size="sm" onClick={() => void ask()} className="self-start">
      <Bell className="size-4" strokeWidth={1.75} /> Alert me when it&apos;s ready
    </Button>
  );
}

export default function ReadingPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const jobId = sp.get("job");
  const v = Number(sp.get("v"));
  const router = useRouter();
  const by = useActingAs();
  const study = useStudy(id);
  const job = useJob(jobId);
  const invalidate = useInvalidateStudy();
  const qc = useQueryClient();
  const state = job.data?.state;
  const done = state === "succeeded";
  const version = useVersion(id, done ? v : null);
  const s = study.data;

  useEffect(() => {
    if (state === "succeeded" || state === "failed") void invalidate(id);
  }, [state, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // One desktop alert per reading, once the result is known.
  const alerted = useRef(false);
  useEffect(() => {
    if (alerted.current || !s) return;
    const name = s.protocol ?? "Your contract";
    if (state === "failed") {
      alerted.current = true;
      notify(`${name} couldn't be read`, "Open it to read it again or type it in by hand.", `/studies/${id}/reading?job=${jobId}&v=${v}`);
    } else if (done && version.data) {
      alerted.current = true;
      const n = needsYou(version.data.review).length;
      notify(`${name} is read and checked`, n ? `${n} ${n === 1 ? "thing needs" : "things need"} you · about ${minutesFor(n)} min` : "Nothing needs you. Ready for approval.", `/studies/${id}`);
    }
  }, [state, done, version.data, s, id, jobId, v]);

  const retry = useMutation({
    mutationFn: () => api.extract(id, by!),
    onSuccess: (r) => {
      qc.removeQueries({ queryKey: ["job"] });
      alerted.current = false;
      router.replace(`/studies/${id}/reading?job=${encodeURIComponent(r.jobId)}&v=${r.version}`);
    },
  });
  const byHand = useMutation({
    mutationFn: () => api.startByHand(id, by!),
    onSuccess: async () => {
      await invalidate(id);
      router.push(`/studies/${id}`);
    },
  });

  const progress = done ? 100 : (job.data?.progress ?? 0);
  const stage: StageState =
    state === "failed" ? { stage: "Reading", failed: true } : done && version.data ? versionStage(version.data, version.data) : { stage: progress >= CHECKING_AT ? "Checking" : "Reading" };
  const now = PHASES.findLast(([t]) => progress >= t);

  return (
    <div className={`${pageCls} max-w-[880px]`}>
      <Link href={`/studies/${id}`} className="mb-5 inline-flex items-center gap-1.5 text-small text-muted hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={2} /> {s?.protocol ?? "Contract"}
      </Link>
      <PageTitle eyebrow={s ? [s.sponsor, s.siteName].filter(Boolean).join(" · ") : undefined} title={s?.protocol ?? "Contract"} />
      <Stepper state={stage} className="mb-8" />

      {!jobId && <ErrorNote>This link has no reading in progress. Open the contract to see where it stands.</ErrorNote>}
      <ErrorNote error={job.error} />

      <section className="rounded-card bg-surface p-8 shadow-card ring-1 ring-ink/[0.05]">
        {state === "failed" ? (
          <div className="flex flex-col gap-6">
            <Heading
              icon={<FileWarning className="size-6" strokeWidth={1.75} />}
              tone="bg-danger-soft text-danger"
              title="We couldn't read this contract"
              sub="Nothing was saved, so nothing is lost. Choose how to carry on."
            />
            {job.data?.error && (
              <p className="rounded-tile bg-sunken px-4 py-3 text-small text-ink-2">
                <span className="font-medium">What happened: </span>
                {job.data.error}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-3 rounded-tile p-5 ring-1 ring-line">
                <RotateCcw className="size-5 text-accent" strokeWidth={1.75} />
                <div>
                  <p className="text-body font-medium">Read it again</p>
                  <p className="text-small text-muted">Often works if the problem was a one-off.</p>
                </div>
                <Button variant="primary" className="mt-auto self-start" disabled={!by || retry.isPending} onClick={() => retry.mutate()}>
                  {retry.isPending ? "Starting…" : "Read it again"}
                </Button>
              </div>
              <div className="flex flex-col gap-3 rounded-tile p-5 ring-1 ring-line">
                <Keyboard className="size-5 text-accent" strokeWidth={1.75} />
                <div>
                  <p className="text-body font-medium">Type it in by hand</p>
                  <p className="text-small text-muted">You type the values; someone else re-types 10 of them without seeing yours, to catch typos.</p>
                </div>
                <Button className="mt-auto self-start" disabled={!by || byHand.isPending} onClick={() => byHand.mutate()}>
                  Type it in by hand
                </Button>
              </div>
            </div>
            {!by && <NeedsPerson />}
            <ErrorNote error={retry.error ?? byHand.error} />
            <p className="text-small text-faint">If it keeps failing, ask the sponsor for the signed DocuSign copy and add it as a new contract. It reads far more reliably than a scan.</p>
          </div>
        ) : done && version.data ? (
          <CheckResult studyId={id} draft={version.data} />
        ) : (
          job.data && (
            <div className="flex flex-col gap-7">
              <Heading
                icon={
                  <>
                    <ScanText className="size-6" strokeWidth={1.75} />
                    <span aria-hidden className="absolute inset-0 animate-ping rounded-tile ring-2 ring-brand/30 [animation-duration:2.2s] motion-reduce:hidden" />
                  </>
                }
                tone="bg-brand-soft text-accent"
                title={progress >= CHECKING_AT ? "Checking every number" : "Reading your contract"}
                sub="This takes a few minutes. You can leave this page; it keeps going without you."
              />
              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3 text-small">
                  <span className="text-ink-2">{now?.[1]}…</span>
                  <span className="num text-muted">{Math.round(progress)}%</span>
                </div>
                <ProgressBar value={progress} label="Reading the contract" />
              </div>
              <ol className="flex flex-col" aria-live="polite">
                {PHASES.map(([t, label, what], i) => {
                  const next = PHASES[i + 1]?.[0] ?? 100;
                  const isDone = progress >= next;
                  const current = !isDone && progress >= t;
                  return (
                    <li key={label} className={cx("flex items-start gap-3.5 rounded-[12px] px-3 py-2.5", current && "bg-brand-soft/60")}>
                      <span
                        className={cx(
                          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
                          isDone ? "bg-ok-soft text-ok" : current ? "bg-surface text-accent ring-1 ring-brand/30" : "ring-1 ring-line-strong",
                        )}
                      >
                        {isDone ? (
                          <Check className="size-3.5" strokeWidth={3} />
                        ) : current ? (
                          <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-brand/25 border-t-brand" />
                        ) : null}
                      </span>
                      <span>
                        <span className={cx("block text-body", isDone ? "text-ink-2" : current ? "font-medium text-ink" : "text-faint")}>{label}</span>
                        <span className={cx("block text-small", current ? "text-muted" : "text-faint")}>{what}</span>
                      </span>
                      <span className="sr-only">{isDone ? " (done)" : current ? " (now)" : ""}</span>
                    </li>
                  );
                })}
              </ol>
              <NotifyMe />
            </div>
          )
        )}
      </section>
    </div>
  );
}
