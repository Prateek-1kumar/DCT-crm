"use client";

import Link from "next/link";
import type { RefObject } from "react";
import type { Study, VersionSummary } from "@/lib/types";
import { Button, btnCls, Card } from "../ui";
import { isPreparing } from "./format";
import { ReadingPanel } from "./ReadingPanel";
import { StartReading } from "./StartReading";

export type Step = { kind: "upload" | "start" } | { kind: "reading" | "questions" | "failed" | "live"; version: VersionSummary };

export function nextStep(study: Study): Step {
  if (study.documents.length === 0) return { kind: "upload" };
  const latest = study.versions.reduce<VersionSummary | undefined>((a, v) => (!a || v.number > a.number ? v : a), undefined);
  if (!latest || latest.status === "superseded") return { kind: "start" };
  const kind = { reading: "reading", draft: "questions", failed: "failed", approved: "live" } as const;
  return { kind: kind[latest.status], version: latest };
}

export function NextStep({ study, pickFiles }: { study: Study; pickFiles: RefObject<HTMLInputElement | null> }) {
  const step = nextStep(study);
  const failed = study.documents.filter((d) => d.ocr.status === "failed");
  const canStart = study.documents.some(isPreparing)
    ? { ok: false, reason: "Scanned pages are still being prepared. Reading can start when they're done." }
    : failed.length
      ? { ok: false, reason: `${failed.map((d) => d.name).join(", ")} couldn't be prepared. Upload ${failed.length === 1 ? "it" : "them"} again to try once more, or remove ${failed.length === 1 ? "it" : "them"} to go on.` }
      : { ok: true, reason: "" };

  return (
    <Card className="p-6">
      <p className="eyebrow mb-3">Next step</p>
      {step.kind === "upload" && (
        <div className="flex flex-col items-start gap-4">
          <div>
            <h2 className="text-heading font-semibold tracking-tight">Add the contract</h2>
            <p className="mt-1 text-body text-muted">Upload the signed contract and any amendments as PDFs.</p>
          </div>
          <Button variant="primary" size="lg" onClick={() => pickFiles.current?.click()}>
            Upload contract
          </Button>
        </div>
      )}
      {step.kind === "start" && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-heading font-semibold tracking-tight">Ready to read</h2>
            <p className="mt-1 text-body text-muted">We read every page and build the rulebook. Then we ask you about anything we can&apos;t settle ourselves.</p>
          </div>
          <StartReading studyId={study.id} label="Start reading" canStart={canStart} />
        </div>
      )}
      {(step.kind === "reading" || step.kind === "questions" || step.kind === "failed") && <ReadingPanel studyId={study.id} version={step.version} canStart={canStart} />}
      {step.kind === "live" && (
        <div className="flex flex-col items-start gap-4">
          <div>
            <h2 className="text-heading font-semibold tracking-tight">The rulebook is live</h2>
            <p className="mt-1 text-body text-muted">Version {step.version.number} was approved{step.version.approvedBy ? ` by ${step.version.approvedBy}` : ""}.</p>
          </div>
          <Link href={`/versions/${step.version.id}`} className={btnCls("primary", "lg")}>
            Open live rulebook
          </Link>
        </div>
      )}
    </Card>
  );
}
