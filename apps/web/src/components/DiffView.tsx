"use client";

import type { DiffEntry } from "@dct/shared";
import { formatValue } from "@/lib/format";
import { Badge, Empty, type Tone } from "./ui";

const CHANGE: Record<DiffEntry["change"], { tone: Tone; label: string }> = {
  added: { tone: "ok", label: "Added" },
  changed: { tone: "warn", label: "Changed" },
  removed: { tone: "danger", label: "Removed" },
};

/** Section = first part of the label ("Budget grid › Exhibit A › …" → "Budget grid"). */
export const sectionOf = (e: DiffEntry) => e.label.split(" › ")[0] || "Other";

export function DiffView({ entries, onShow, title }: { entries: DiffEntry[]; onShow?: (e: DiffEntry) => void; title?: string }) {
  if (!entries.length) return <Empty title="No differences">The two versions have the same terms.</Empty>;
  const groups = new Map<string, DiffEntry[]>();
  for (const e of entries) groups.set(sectionOf(e), [...(groups.get(sectionOf(e)) ?? []), e]);
  const count = (c: DiffEntry["change"]) => entries.filter((e) => e.change === c).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {title && <span className="font-semibold">{title}</span>}
        {(["changed", "added", "removed"] as const).map((c) =>
          count(c) ? (
            <Badge key={c} tone={CHANGE[c].tone}>
              {count(c)} {CHANGE[c].label.toLowerCase()}
            </Badge>
          ) : null,
        )}
      </p>
      {[...groups].map(([section, items]) => (
        <section key={section} className="rounded-card border border-line bg-surface">
          <h3 className="border-b border-line px-4 py-2 text-sm font-semibold">
            {section} <span className="font-normal text-muted">· {items.length}</span>
          </h3>
          <ul className="divide-y divide-line">
            {items.map((e) => (
              <li key={e.path} className="grid grid-cols-[5.5rem_1fr] items-start gap-3 px-4 py-2 text-sm sm:grid-cols-[5.5rem_minmax(10rem,1fr)_minmax(12rem,1.2fr)_auto]">
                <span>
                  <Badge tone={CHANGE[e.change].tone}>{CHANGE[e.change].label}</Badge>
                </span>
                <span className="min-w-0">{e.label.split(" › ").slice(1).join(" › ") || e.label}</span>
                <span className="num col-span-2 sm:col-span-1">
                  {e.change !== "added" && <del className="text-muted"><span className="sr-only">was </span>{formatValue(e.path, e.before)}</del>}
                  {e.change === "changed" && <span aria-hidden className="px-1.5 text-faint">→</span>}
                  {e.change !== "removed" && <ins className="font-medium no-underline"><span className="sr-only">now </span>{formatValue(e.path, e.after)}</ins>}
                </span>
                {onShow && e.change !== "removed" ? (
                  <button type="button" onClick={() => onShow(e)} className="text-xs whitespace-nowrap text-accent hover:underline">
                    Show in contract ↗
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
