"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { NeedsPerson } from "@/components/Sidebar";
import { Button, Card, ErrorNote, PageTitle, pageCls, Stepper, btnCls, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { useInvalidateStudy, useJob, useStudy, useVersion } from "@/lib/queries";
import { minutesFor, needsYou, pdfCheckLine, versionStage, type StageState } from "@/lib/review";

/** Plain steps, ticked off by job progress. From "Checking…" on, the stage is Checking. */
const PHASES: [number, string][] = [
  [0, "Opening the PDFs"],
  [15, "Reading the contract terms"],
  [40, "Reading the budget grid"],
  [62, "Checking every number against the PDF"],
  [84, "Listing what needs you"],
];
const CHECKING_AT = 62;

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

  useEffect(() => {
    if (state === "succeeded" || state === "failed") void invalidate(id);
  }, [state, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useMutation({
    mutationFn: () => api.extract(id, by!),
    onSuccess: (r) => {
      qc.removeQueries({ queryKey: ["job"] });
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
  const s = study.data;
  const n = version.data ? needsYou(version.data.review).length : 0;

  return (
    <div className={`${pageCls} max-w-[860px]`}>
      <p className="mb-3 text-[13px]">
        <Link href={`/studies/${id}`} className="text-muted hover:text-ink">
          ← {s?.protocol ?? "Contract"}
        </Link>
      </p>
      <PageTitle eyebrow={s ? `${s.sponsor ?? ""} · ${s.siteName ?? ""}` : undefined} title={done ? "Read and checked" : state === "failed" ? "We couldn't read this contract" : "Reading the contract"} />
      <Stepper state={stage} className="mb-6" />
      {!jobId && <ErrorNote>This link has no reading in progress. Open the contract to see where it stands.</ErrorNote>}
      <ErrorNote error={job.error} />

      {job.data && state !== "failed" && (
        <Card className="max-w-[620px] rounded-[18px] p-6">
          <p className="mb-4 text-[13px] text-muted">
            We read every page, then check each number against the PDF&apos;s own text. You only answer what needs a person. This takes a minute; you can leave
            this page.
          </p>
          <ul className="flex flex-col gap-2.5" aria-live="polite">
            {PHASES.map(([t, label], i) => {
              const next = PHASES[i + 1]?.[0] ?? 100;
              const isDone = progress >= next;
              const now = !isDone && progress >= t;
              return (
                <li key={label} className={cx("flex items-center gap-2.5 text-[13px]", !isDone && !now && "text-faint")}>
                  {isDone ? (
                    <span aria-hidden className="w-4 text-ok">
                      ✓
                    </span>
                  ) : now ? (
                    <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-focus" />
                  ) : (
                    <span aria-hidden className="w-4" />
                  )}
                  {label}
                  <span className="sr-only">{isDone ? " (done)" : now ? " (now)" : ""}</span>
                </li>
              );
            })}
          </ul>
          {done && version.data && (
            <div className="mt-5 flex flex-col gap-4">
              <div className={cx("rounded-[14px] px-4 py-3.5", version.data.pdfCheck ? "bg-ok-soft" : "bg-warn-soft")}>
                <p>{pdfCheckLine(version.data.pdfCheck)}.</p>
                <p className="mt-1 text-[13px] text-ink-2">
                  {n ? `${n} ${n === 1 ? "question needs" : "questions need"} you · about ${minutesFor(n)} min. Nothing is billed until someone approves.` : "Nothing needs you. It's ready to approve."}
                </p>
              </div>
              <div className="flex justify-end">
                <Link href={n ? `/studies/${id}/review` : `/studies/${id}`} className={btnCls("primary")}>
                  {n ? "Start answering →" : "Go to approval →"}
                </Link>
              </div>
            </div>
          )}
        </Card>
      )}

      {state === "failed" && (
        <Card className="max-w-[620px] rounded-[18px] p-6">
          <p className="mb-2">{job.data?.error ?? "Something went wrong."}</p>
          <p className="mb-5 text-[13px] text-muted">
            Nothing was saved. Try again, and if it keeps failing, ask the sponsor for the signed DocuSign copy: it reads far more reliably than a scan.
            Or type the contract in by hand; someone else then re-types some of the values to catch typos.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!by || retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? "Starting…" : "Read it again"}
            </Button>
            <Button disabled={!by || byHand.isPending} onClick={() => byHand.mutate()}>
              Type it in by hand
            </Button>
            <Link href={`/studies/${id}`} className={btnCls("ghost")}>
              Back to the contract
            </Link>
            {!by && <NeedsPerson />}
          </div>
          <div className="mt-3">
            <ErrorNote error={retry.error ?? byHand.error} />
          </div>
        </Card>
      )}
    </div>
  );
}
