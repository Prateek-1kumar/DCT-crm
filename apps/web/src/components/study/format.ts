import type { VersionStatus } from "@/lib/types";
import type { Tone } from "../ui";

export const VERSION_PILL: Record<VersionStatus, { label: string; tone: Tone }> = {
  reading: { label: "Reading", tone: "accent" },
  draft: { label: "Questions to answer", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  approved: { label: "Live", tone: "ok" },
  superseded: { label: "Superseded", tone: "neutral" },
};

/** "Pages 3–5, 8": the pages in order, consecutive ones as a range. */
export function pageList(pages: number[]): string {
  const runs: number[][] = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && p === last[1]! + 1) last[1] = p;
    else runs.push([p, p]);
  }
  const parts = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return `${pages.length === 1 ? "Page" : "Pages"} ${parts.join(", ")}`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export const usd = (amount: number) => `$${amount.toFixed(2)}`;

export const studyTitle = (protocol: string | null, firstDocument?: string | null) => protocol ?? firstDocument ?? "New contract";

export const studySub = (protocol: string | null, parties: (string | null | undefined)[]) =>
  protocol === null ? "Study details are filled in when the contract is read" : parties.filter(Boolean).join(" · ");
