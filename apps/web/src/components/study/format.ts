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

/** A contract date as typed ("2026-01-15" becomes "Jan 15, 2026"); anything that isn't a plain date is shown as written. */
export function plainDate(text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { dateStyle: "medium" }) : text.trim();
}

export const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });

/** "5 min ago", "Yesterday", "Nov 3": for the Updated column, where the exact time is in the tooltip. */
export function relativeTime(iso: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export const studyTitle = (protocol: string | null, firstDocument?: string | null) => protocol ?? firstDocument ?? "New contract";

export const studySub = (protocol: string | null, parties: (string | null | undefined)[]) =>
  protocol === null ? "Study details are filled in when the contract is read" : parties.filter(Boolean).join(" · ");
