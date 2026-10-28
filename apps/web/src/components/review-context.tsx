"use client";

import type { ProofreadMark, Provenance, Rulebook, ValueEvidence } from "@dct/shared";
import { Check } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { cx } from "./ui";

/** Shared by everything that shows an invoicing master. */
export type RulebookCtx = {
  rulebook: Rulebook;
  /** Pointer of the value last shown in the contract. */
  focused: string | null;
  show: (path: string, prov: Provenance | null | undefined, label: string) => void;
  /** What backs each number. */
  evidence: Map<string, ValueEvidence["status"]>;
  /** Values with an open question on a draft: hidden until a person answers (blind entry). */
  masked: Set<string>;
  /** Values someone proofread and found right. */
  proofread: Map<string, ProofreadMark>;
  /** Items matching the search on this contract (pointers of rows or terms). */
  hits: Set<string>;
};

/** Whether `path` is a search hit or inside one. */
export const isHit = (hits: Set<string>, path: string) => hits.has(path) || [...hits].some((h) => path.startsWith(`${h}/`));

export const RulebookContext = createContext<RulebookCtx | null>(null);

export function useRulebook(): RulebookCtx {
  const c = useContext(RulebookContext);
  if (!c) throw new Error("useRulebook outside RulebookContext");
  return c;
}

export const EVIDENCE: Record<ValueEvidence["status"], { label: string; cls: string }> = {
  confirmed: { label: "Matches the PDF", cls: "bg-ok" },
  attested: { label: "Confirmed by a person", cls: "bg-info" },
  conflict: { label: "Needs you", cls: "bg-warn" },
  ungrounded: { label: "Needs you", cls: "bg-warn" },
};

export function Dot({ status }: { status: ValueEvidence["status"] }) {
  const e = EVIDENCE[status];
  return (
    <span title={e.label} className={cx("inline-block size-1.5 flex-none rounded-full", e.cls)}>
      <span className="sr-only">{e.label}</span>
    </span>
  );
}

/** A value with its evidence dot (and a tick once proofread), or "needs you" while its question is open. */
export function Val({ path, children }: { path: string; children: ReactNode }) {
  const { evidence, masked, proofread } = useRulebook();
  if (masked.has(path)) return <span className="text-warn">needs you</span>;
  const status = evidence.get(path);
  const mark = proofread.get(path);
  return (
    <span className="inline-flex items-center gap-1.5">
      {status && <Dot status={status} />}
      {children}
      {mark && (
        <span title={`Proofread by ${mark.by}`} className="text-ok">
          <Check aria-hidden className="size-3" strokeWidth={3} />
          <span className="sr-only">Proofread by {mark.by}</span>
        </span>
      )}
    </span>
  );
}

export function DotLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {(["confirmed", "attested", "conflict"] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <Dot status={s} /> {EVIDENCE[s].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <Check aria-hidden className="size-3 text-ok" strokeWidth={3} /> Proofread
      </span>
    </p>
  );
}
