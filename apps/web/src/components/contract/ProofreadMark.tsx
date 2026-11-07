"use client";

import type { Version } from "@/lib/types";
import { proofState, proofStatus } from "./proofreads";

/** Who proofread these items and the signed-in person's own mark toggle. A name is asked for when they press it without one. */
export function ProofreadMark({ items, name, version, me, busy, onProofread, compact }: { items: string[]; name: string; version: Version; me: string | null; busy?: boolean; onProofread: (items: string[], mark: boolean) => void; compact?: boolean }) {
  if (items.length === 0) return compact ? null : <p className="text-small text-muted">There is nothing here to proofread.</p>;
  const s = proofState(version, items, me);
  const many = items.length > 1;
  const status = proofStatus(version, items);
  const mine = s.mine.length > 0;
  return (
    <span className={compact ? "flex flex-col items-start gap-1 text-small text-muted" : "flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-ink-2"}>
      {!compact && <span>{status}</span>}
      <button
        type="button"
        disabled={busy}
        aria-label={`${mine ? "Remove my proofread mark from" : "Mark as proofread:"} ${name}`}
        onClick={() => onProofread(mine ? s.mine : s.todo, !mine)}
        className={
          compact
            ? "font-medium text-accent hover:text-accent-hover hover:underline disabled:opacity-40"
            : "inline-flex h-8 items-center rounded-full border border-line-strong bg-surface px-3.5 text-small font-medium text-ink shadow-button hover:bg-sunken disabled:opacity-40"
        }
      >
        {mine ? (many ? "Remove my marks" : "Remove my mark") : many ? "Mark all proofread" : "Mark proofread"}
      </button>
    </span>
  );
}
