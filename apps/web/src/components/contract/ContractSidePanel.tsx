"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, keys } from "@/lib/queries";
import type { CoverageRef, Version } from "@/lib/types";
import { buildProof, encodeRef, type Spot } from "../proof/model";
import type { ShowRef } from "../rulebook";
import { Skeleton } from "../study/Skeleton";
import { Button, Empty, LoadError } from "../ui";
import { LinePanel } from "./LinePanel";

// COMPONENT: a proper right-hand drawer (focus trap optional, drag to resize). This is a plain fixed panel: a full-width bottom sheet on phones, a 560px column from 640px up.
function Panel({ version, target, onClose, onOpenFull }: { version: Version; target: ShowRef; onClose: () => void; onOpenFull: () => void }) {
  const coverage = useQuery({ queryKey: keys.coverage(version.id), queryFn: () => api.coverage(version.id), enabled: !!version.rulebook });
  // The page the person has moved to inside the panel; null = the line's own page. Reset by the parent's key when the target changes.
  const [spot, setSpot] = useState<Spot | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const data = coverage.data ? buildProof(version, coverage.data) : null;
  const line: CoverageRef = target;

  return (
    <aside
      aria-labelledby="contract-panel-title"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[85vh] flex-col rounded-t-card bg-surface shadow-raised ring-1 ring-ink/[0.08] sm:inset-y-0 sm:right-0 sm:left-auto sm:h-auto sm:w-[min(560px,100vw)] sm:rounded-none"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h2 id="contract-panel-title" ref={heading} tabIndex={-1} className="mr-auto text-title font-semibold tracking-tight outline-none">
          In the contract
        </h2>
        <Button size="sm" variant="primary" onClick={onOpenFull}>
          Open full view
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close the contract panel" onClick={onClose}>
          <X aria-hidden className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {coverage.isError ? (
          <LoadError error={coverage.error} what="the contract pages" retry={() => void coverage.refetch()} back={{ href: "/", label: "Back to contracts" }} />
        ) : !version.rulebook ? (
          <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>
        ) : coverage.isPending ? (
          <div aria-label="Loading the contract page" className="grid gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-64 w-full rounded-tile" />
          </div>
        ) : data ? (
          <LinePanel data={data} line={line} spot={spot} onSpot={(s) => setSpot(s)} scrollCls="max-h-[50vh]" />
        ) : null}
      </div>
    </aside>
  );
}

/** "Show in the contract": the PDF page beside a card with the spot highlighted. Mount once; pass the card's ref as `target`, or null to close. */
export function ContractSidePanel(props: { version: Version; target: ShowRef | null; onClose: () => void; onOpenFull: () => void }) {
  return props.target ? <Panel key={encodeRef(props.target)} {...props} target={props.target} /> : null;
}
