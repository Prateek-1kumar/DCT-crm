"use client";

import Link from "next/link";
import { Button, cx, ProgressBar } from "../ui";
import { ShortcutList } from "./ItemRail";
import type { LineFilter } from "./lines";

const FILTERS: { id: LineFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs checking" },
  { id: "flagged", label: "Flagged" },
  { id: "mine", label: "Checked by me" },
];

/** The slim bar over the screen: the way back, the title, how far the checking has got, which items to list, and the keys. */
export function TopBar({ studyHref, done, total, filter, counts, onFilter, missing, onNextMissing, narrow, onOpenItems, helpOpen, onToggleHelp }: {
  studyHref: string;
  done: number;
  total: number;
  filter: LineFilter;
  counts: Record<LineFilter, number>;
  onFilter: (f: LineFilter) => void;
  missing: number;
  onNextMissing: () => void;
  narrow: boolean;
  onOpenItems: () => void;
  helpOpen: boolean;
  onToggleHelp: () => void;
}) {
  return (
    <header className="relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
      <Link href={studyHref} className="text-small font-medium whitespace-nowrap text-accent hover:text-accent-hover">
        ← Back to contract
      </Link>
      <h2 className="text-title font-semibold tracking-tight">Proofread</h2>
      <div className="min-w-[150px] max-w-[260px] flex-1">
        <p className="num text-small text-ink-2">
          {done} of {total} checked by someone
        </p>
        <ProgressBar value={total ? (done / total) * 100 : 0} label="Items checked by someone" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Which items to show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
            className={cx("h-7 rounded-full border px-3 text-small font-medium", filter === f.id ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted hover:bg-sunken")}
          >
            {f.label} <span className="num">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {missing > 0 && (
          <Button size="sm" variant="danger" onClick={onNextMissing} title="Amounts printed in the contract that no item in the rulebook accounts for">
            Next missing amount ({missing})
          </Button>
        )}
        {narrow && (
          <Button size="sm" onClick={onOpenItems}>
            Items
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Keyboard shortcuts" aria-expanded={helpOpen} onClick={onToggleHelp}>
          ?
        </Button>
      </div>
      {helpOpen && (
        <div role="region" aria-label="Keyboard shortcuts help" className="absolute top-full right-3 z-30 mt-1 w-[340px] max-w-[92vw] rounded-tile bg-surface p-4 shadow-raised ring-1 ring-ink/[0.08]">
          <p className="mb-2 text-small font-semibold">Keyboard shortcuts</p>
          <ShortcutList />
        </div>
      )}
    </header>
  );
}
