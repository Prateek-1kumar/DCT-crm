"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { NeedsPerson } from "@/components/AppHeader";
import { Button, Card, ErrorNote, PageTitle, ProgressBar, btnCls } from "@/components/ui";
import { api } from "@/lib/api";
import { useActingAs } from "@/lib/acting-as";
import { useInvalidateStudy, useJob, useStudy } from "@/lib/queries";

export default function ExtractingPage() {
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
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);

  const state = job.data?.state;
  useEffect(() => {
    if (state === "succeeded" || state === "failed") {
      void invalidate(id);
      return;
    }
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [state, id, started]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state === "succeeded") {
      const t = setTimeout(() => router.replace(`/studies/${id}/review?v=${v}`), 900);
      return () => clearTimeout(t);
    }
  }, [state, id, v, router]);

  const retry = useMutation({
    mutationFn: () => api.extract(id, by!),
    onSuccess: (r) => {
      qc.removeQueries({ queryKey: ["job"] });
      router.replace(`/studies/${id}/extracting?job=${encodeURIComponent(r.jobId)}&v=${r.version}`);
    },
  });
  const manual = useMutation({
    mutationFn: () => api.createManualVersion(id, by!),
    onSuccess: async (r) => {
      await invalidate(id);
      router.push(`/studies/${id}/review?v=${r.version}`);
    },
  });

  const name = study.data ? `${study.data.sponsor ?? "Study"} · ${study.data.protocol ?? ""}` : "Study";
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10">
      <PageTitle title="Extracting the rulebook" sub={name} />
      {!jobId && <ErrorNote>No extraction job in the link. Open the study to see its status.</ErrorNote>}
      <ErrorNote error={job.error} />
      {job.data && state !== "failed" && (
        <Card className="p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="font-medium" aria-live="polite">
              {state === "succeeded" ? "Done. Opening the review…" : `${job.data.step}…`}
            </p>
            <span className="num text-sm text-muted">{Math.round(job.data.progress)}%</span>
          </div>
          <ProgressBar value={job.data.progress} label="Extraction progress" />
          <p className="mt-3 text-sm text-muted">
            {state === "succeeded" ? "" : `Running for ${elapsed}s. You can leave this page; the study will show “Needs review” when it's done.`}
          </p>
        </Card>
      )}
      {state === "failed" && (
        <Card className="border-danger/40 p-6">
          <h2 className="mb-1 font-semibold text-danger">Extraction failed</h2>
          <p className="mb-4 text-sm">{job.data?.error ?? "Unknown error."}</p>
          <p className="mb-4 text-sm text-muted">
            Nothing was saved from this attempt. Retry (the job is safe to run again), or enter the terms yourself. Manually entered values are tagged
            “manual” and still go through every check.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!by || retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? "Retrying…" : "Retry extraction"}
            </Button>
            <Button disabled={!by || manual.isPending} onClick={() => manual.mutate()}>
              Enter manually
            </Button>
            <Link href={`/studies/${id}`} className={btnCls("ghost")}>
              Back to study
            </Link>
            {!by && <NeedsPerson />}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <ErrorNote error={retry.error} />
            <ErrorNote error={manual.error} />
          </div>
        </Card>
      )}
    </div>
  );
}
