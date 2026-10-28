"use client";

import { settled, type ReviewItem, type RulebookVersionDto } from "@dct/shared";
import Link from "next/link";
import { labelFor } from "@/lib/format";
import { getAt } from "@/lib/pointer";

/**
 * Values the newest draft asks about again, blind, that the live version `shown` also holds: same place, same name,
 * since an amendment can move rows. Billing still works from the live version, so these are marked there, never
 * hidden. Path → its question.
 * ponytail: a question about a row's name itself isn't matched (the draft withholds the name its label is made of);
 * compare by row identity if such questions appear.
 */
export function rechecked(draft: RulebookVersionDto | undefined, shown: RulebookVersionDto | undefined): Map<string, ReviewItem> {
  const out = new Map<string, ReviewItem>();
  if (!draft?.rulebook || !shown?.rulebook || draft.status !== "draft" || shown.status !== "signed") return out;
  for (const i of draft.review)
    if (i.path && !settled(i) && getAt(shown.rulebook, i.path) !== undefined && labelFor(i.path, shown.rulebook) === labelFor(i.path, draft.rulebook)) out.set(i.path, i);
  return out;
}

export const questionHref = (studyId: string, version: number, item: ReviewItem) => `/studies/${studyId}/review?v=${version}&item=${encodeURIComponent(item.id)}`;

/** Above the master: which of its values the draft is re-checking, each a link to its question. */
export function RecheckNote({ studyId, draft, shown, items }: { studyId: string; draft: RulebookVersionDto; shown: RulebookVersionDto; items: Map<string, ReviewItem> }) {
  if (!items.size) return null;
  const list = [...items];
  return (
    <div role="note" className="flex flex-wrap items-center gap-2 rounded-[10px] bg-warn-soft px-4 py-2.5 text-small text-ink-2">
      <span className="font-medium text-warn">Being re-checked in version {draft.version}:</span>
      {list.slice(0, 12).map(([path, item]) => (
        <Link key={path} href={questionHref(studyId, draft.version, item)} className="inline-flex h-7 items-center rounded-full bg-surface px-3 ring-1 ring-warn/30 hover:ring-warn">
          {labelFor(path, shown.rulebook).split(" › ").slice(-2).join(" · ")}
        </Link>
      ))}
      {list.length > 12 && <span className="text-muted">and {list.length - 12} more</span>}
      <span className="text-muted">
        Version {shown.version} stays live until version {draft.version} is approved.
      </span>
    </div>
  );
}
