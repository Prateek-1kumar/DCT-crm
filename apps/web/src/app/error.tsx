"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Button, btnCls, pageCls } from "@/components/ui";

/** A page that crashed while showing. The sidebar stays; the error itself is never shown, only a reference for the team. */
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const ref = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <div className={pageCls}>
      <div role="alert" className="mx-auto flex max-w-[560px] flex-col items-center gap-3 py-16 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle aria-hidden className="size-5" strokeWidth={2} />
        </span>
        <h1 className="text-title font-semibold tracking-tight">This page ran into a problem</h1>
        <p className="text-body text-muted">Nothing you saved is lost. Try again, or go back to your contracts. If it keeps happening, tell the team.</p>
        {ref && <p className="num text-small text-faint">Reference {ref}</p>}
        <div className="mt-3 flex flex-wrap justify-center gap-2.5">
          <Link href="/" className={btnCls()}>
            Back to contracts
          </Link>
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
