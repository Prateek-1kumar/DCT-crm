"use client";

import type { VersionStatus, VersionSummary } from "@/lib/types";
import { useVersion } from "../version/useVersion";
import { day, plainDate } from "../study/format";
import { inputBase } from "../ui";

const LABEL: Record<VersionStatus, string> = { reading: "Reading", failed: "Couldn't read", draft: "Draft", approved: "Live", superseded: "Replaced" };

/** Which version the tabs show, and who approved it and from when it applies. */
export function VersionPicker({ versions, value, onChange }: { versions: VersionSummary[]; value: string; onChange: (id: string) => void }) {
  const chosen = versions.find((v) => v.id === value);
  // The same query the tab panels use, so this costs no extra request.
  const detail = useVersion(value);
  const effective = detail.data?.rulebook?.study.effectiveDate;
  const info = !chosen
    ? ""
    : chosen.approvedAt
      ? [`Approved by ${chosen.approvedBy ?? "someone"}`, day(chosen.approvedAt), effective ? `applies from ${plainDate(effective)}` : null].filter(Boolean).join(" · ")
      : "Not approved yet";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex items-center gap-2.5 text-small font-medium text-ink-2">
        Version
        <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputBase} pr-8`}>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              Version {v.number} · {LABEL[v.status]}
            </option>
          ))}
        </select>
      </label>
      <p className="min-w-0 text-small text-muted">{info}</p>
    </div>
  );
}
