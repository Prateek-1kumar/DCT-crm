"use client";

import Link from "next/link";
import type { Phase, StepInfo } from "@/lib/steps";
import type { StudyRow } from "@/lib/types";
import { Button, btnCls, cx } from "../ui";
import { StartReading } from "../study/StartReading";

const TONE: Record<Phase, string> = {
  add: "bg-brand-soft",
  ready: "bg-brand-soft",
  reading: "bg-brand-soft",
  failed: "bg-danger-soft",
  decisions: "bg-warn-soft",
  approve: "bg-warn-soft",
  live: "bg-ok-soft",
};

function words(row: StudyRow, info: StepInfo): { title: string; text: string } {
  switch (info.phase) {
    case "add":
      return { title: "Add the signed contract", text: "Add the contract and any amendments as PDFs, then we can read them." };
    case "ready":
      return { title: "Ready to read", text: "We read every page and build the rulebook, then ask you about anything we can't settle ourselves." };
    case "reading":
      return { title: "Reading the contract", text: "Every page is being read now. Progress is below." };
    case "failed":
      return { title: "We couldn't read this contract", text: "What happened is below. You can start again." };
    case "decisions":
      return { title: `${row.openDecisions === 1 ? "1 decision needs" : `${row.openDecisions} decisions need`} you`, text: "Go through them one at a time. When none are left, the rulebook can be approved." };
    case "approve":
      return { title: "Ready to review and approve", text: "Nothing is blocking. Look over the key terms, then approve." };
    case "live":
      return { title: `Version ${row.liveVersion ?? row.latestVersion?.number} is live`, text: "This rulebook is approved and can't change. A change is made as a new version." };
  }
}

/** The one thing to do next, said in a sentence with its button. Reading and failed reads act in the panel below instead. */
export function StatusBanner({ row, info, onAddFiles }: { row: StudyRow; info: StepInfo; onAddFiles: () => void }) {
  const { title, text } = words(row, info);
  const { next } = info;
  return (
    <section aria-label="What to do next" className={cx("flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-card px-6 py-5", TONE[info.phase])}>
      <div className="min-w-0 flex-1 basis-[280px]">
        <h2 className="text-title font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-body text-ink-2">{text}</p>
        {next.disabled && next.reason && <p className="mt-2 text-small font-medium text-warn">{next.reason}</p>}
      </div>
      <div className="shrink-0">
        {info.phase === "add" && (
          <Button variant="primary" size="lg" onClick={onAddFiles}>
            Add files
          </Button>
        )}
        {info.phase === "ready" && <StartReading studyId={row.id} label="Start reading" />}
        {(info.phase === "decisions" || info.phase === "approve" || info.phase === "live") &&
          (next.disabled ? (
            <Button size="lg" disabled title={next.reason ?? undefined}>
              {next.label}
            </Button>
          ) : (
            <Link href={next.href} className={btnCls("primary", "lg")}>
              {next.label}
            </Link>
          ))}
      </div>
    </section>
  );
}
