"use client";

import type { RulebookVersionDto } from "@dct/shared";
import { AlertTriangle, ArrowRight, CheckCircle2, MessageCircleQuestion, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { minutesFor, needsYou } from "@/lib/review";
import { btnCls, cx } from "./ui";

function Stat({ icon, value, label, sub, tone }: { icon: ReactNode; value: ReactNode; label: string; sub?: string; tone: "ok" | "warn" }) {
  return (
    <div className="flex items-start gap-4 rounded-tile bg-sunken p-5">
      <span className={cx("grid size-10 shrink-0 place-items-center rounded-[12px]", tone === "ok" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn")}>{icon}</span>
      <div>
        <p className="num text-heading font-semibold tracking-tight">{value}</p>
        <p className="text-body text-ink-2">{label}</p>
        {sub && <p className="text-small text-faint">{sub}</p>}
      </div>
    </div>
  );
}

/** Step 3's result: how much matched the PDF, how much needs a person, and the way forward. */
export function CheckResult({ studyId, draft }: { studyId: string; draft: RulebookVersionDto }) {
  const open = needsYou(draft.review).length;
  const pdf = draft.pdfCheck;
  const n = new Intl.NumberFormat("en-US");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-tile bg-ok-soft text-ok">
          <CheckCircle2 className="size-6" strokeWidth={1.75} />
        </span>
        <div>
          <h2 className="text-heading font-semibold tracking-tight">Read and checked</h2>
          <p className="text-body text-muted">{!open ? "Everything checked out. It's ready for approval." : open <= 10 ? "Almost there. A few things need a person." : "These need a person before it can be approved."}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {pdf ? (
          <Stat icon={<ShieldCheck className="size-5" strokeWidth={1.75} />} tone="ok" value={`${n.format(pdf.matched)} of ${n.format(pdf.values)}`} label="numbers match the contract PDF" sub="Each one matched to the spot where it's printed" />
        ) : (
          <Stat icon={<AlertTriangle className="size-5" strokeWidth={1.75} />} tone="warn" value="Scan" label="numbers can't be checked against its text" sub="So more of them come to you" />
        )}
        <Stat icon={<MessageCircleQuestion className="size-5" strokeWidth={1.75} />} tone="warn" value={open} label={open === 1 ? "thing needs you" : "things need you"} sub={open ? `About ${minutesFor(open)} min, one at a time` : "Nothing to answer"} />
      </div>

      {!pdf && (
        <p className="flex items-start gap-2.5 rounded-tile bg-warn-soft/70 px-4 py-3 text-small text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={2} />
          This PDF is a scan. If you can, ask the sponsor for the signed DocuSign copy: its numbers are checked automatically, so far fewer come to you.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
        <p className="text-small text-muted">Nothing is billed from this contract until someone approves it.</p>
        <div className="flex flex-wrap gap-2.5">
          <Link href={`/studies/${studyId}`} className={btnCls()}>
            See what was checked
          </Link>
          <Link href={open ? `/studies/${studyId}/review` : `/studies/${studyId}`} className={btnCls("primary", "lg")}>
            {open ? "Start answering" : "Go to approval"}
            <ArrowRight className="size-[18px]" strokeWidth={2} />
          </Link>
        </div>
      </div>
    </div>
  );
}
