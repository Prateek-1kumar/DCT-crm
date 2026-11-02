"use client";

import { FileQuestion } from "lucide-react";
import Link from "next/link";
import { btnCls, pageCls } from "@/components/ui";

/** Any address the app doesn't have. */
export default function NotFound() {
  return (
    <div className={pageCls}>
      <div className="mx-auto flex max-w-[560px] flex-col items-center gap-3 py-16 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-brand-soft text-accent">
          <FileQuestion aria-hidden className="size-5" strokeWidth={1.75} />
        </span>
        <h1 className="text-title font-semibold tracking-tight">There&apos;s no page here</h1>
        <p className="text-body text-muted">The link may be wrong or out of date. Your contracts are all on the contracts list.</p>
        <Link href="/" className={`${btnCls("primary")} mt-3`}>
          Back to contracts
        </Link>
      </div>
    </div>
  );
}
