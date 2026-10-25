import type { Provenance } from "@dct/shared";
import { pct } from "@/lib/format";
import { Badge, type Tone } from "./ui";

export const confidenceTone = (c: number): Tone => (c >= 0.9 ? "ok" : c >= 0.75 ? "warn" : "danger");

/** Confidence, cross-check, manual/unverified tags for one value. */
export function ProvChips({ prov, compact }: { prov: Provenance | null | undefined; compact?: boolean }) {
  if (!prov) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {prov.method === "manual" ? (
        <Badge tone="info" title="Entered or corrected by a person">
          Manual
        </Badge>
      ) : (
        <Badge tone={confidenceTone(prov.confidence)} title="AI extraction confidence">
          <span className="num">{pct(prov.confidence)}</span>
          {!compact && <span className="sr-only"> confidence</span>}
        </Badge>
      )}
      {prov.method === "derived" && <Badge title="Calculated from other values">Derived</Badge>}
      {prov.crossCheck === "agree" && (
        <Badge tone="ok" title="Second, independent AI read agrees">
          ✓{!compact && " Agree"}
        </Badge>
      )}
      {prov.crossCheck === "disagree" && (
        <Badge tone="danger" title="Second, independent AI read disagrees">
          ≠{!compact && " Disagree"}
        </Badge>
      )}
      {prov.unverified && (
        <Badge tone="warn" title="Depends on a document that wasn't uploaded">
          Unverified
        </Badge>
      )}
      {!prov.source && prov.method !== "manual" && <Badge title="No page reference">No source</Badge>}
    </span>
  );
}
