"use client";

import type { Evidence } from "@dct/shared";
import { Badge } from "@/components/ui";
import type { Version } from "@/lib/types";
import { proofreaders } from "./model";
import { EVIDENCE_LABEL, EVIDENCE_TITLE, EVIDENCE_TONE } from "./terms";

export function ProofBadge({ evidence }: { evidence: Evidence }) {
  return (
    <Badge tone={EVIDENCE_TONE[evidence]} title={EVIDENCE_TITLE[evidence]}>
      {EVIDENCE_LABEL[evidence]}
    </Badge>
  );
}

export function DecisionPill() {
  return (
    <Badge tone="warn" dot title="A question about this is waiting for your answer.">
      Needs your decision
    </Badge>
  );
}

/** Who proofread a term, plus the signed-in person's own mark toggle (hidden until they have chosen a name). */
export function ProofreadControl({ item, name, version, me, onProofread }: { item: string; name: string; version: Version; me: string | null; onProofread: (items: string[], mark: boolean) => void }) {
  const names = proofreaders(version, item);
  const mine = me !== null && names.includes(me);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-muted">
      {names.length > 0 ? <span>Proofread by {names.join(", ")}</span> : <span>Not proofread yet</span>}
      {me !== null && (
        <button type="button" aria-label={`${mine ? "Remove my proofread mark from" : "Mark as proofread:"} ${name}`} onClick={() => onProofread([item], !mine)} className="font-medium text-accent hover:text-accent-hover hover:underline">
          {mine ? "Remove my mark" : "Mark proofread"}
        </button>
      )}
    </span>
  );
}

export function ShowLink({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={`Show in the contract: ${name}`} onClick={onClick} className="text-left text-small font-medium text-accent hover:text-accent-hover hover:underline">
      Show in the contract
    </button>
  );
}
