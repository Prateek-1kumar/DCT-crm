"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { proofState, proofStatus } from "../contract/proofreads";
import { ProofreadMark } from "../contract/ProofreadMark";
import { ProofBadge } from "../rulebook/parts";
import type { Version } from "@/lib/types";
import { Badge, Button, cx, Empty } from "../ui";
import { isLine, sectionsOf, type Line, type LineFilter } from "./lines";
import type { CoverageRef } from "@/lib/types";

const FILTERS: { id: LineFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs checking" },
  { id: "mine", label: "Proofread by me" },
];

/** The rulebook's lines, grouped, read-only apart from the proofread marks. Arrow keys move between lines. */
export function LineList({ lines, visible, counts, filter, onFilter, selected, onSelect, version, me, busy, onProofread }: {
  lines: Line[];
  visible: Line[];
  counts: Record<LineFilter, number>;
  filter: LineFilter;
  onFilter: (f: LineFilter) => void;
  selected: CoverageRef | null;
  onSelect: (line: Line) => void;
  version: Version;
  me: string | null;
  busy: boolean;
  onProofread: (items: string[], mark: boolean) => void;
}) {
  const here = useRef<HTMLButtonElement>(null);
  // A pick made on the page scrolls its line into view in the list.
  useEffect(() => {
    // braces: an effect must return nothing or a cleanup, never the call's own result
    here.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const todo = visible.flatMap((l) => proofState(version, l.items, me).todo);
  const move = (e: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-line]")];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (!step || at < 0) return;
    e.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, at + step))]?.focus();
  };

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which lines to show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
            className={cx("h-8 rounded-full border px-3.5 text-small font-medium", filter === f.id ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted hover:bg-sunken")}
          >
            {f.label} <span className="num">{counts[f.id]}</span>
          </button>
        ))}
        <Button size="sm" className="ml-auto" disabled={busy || visible.length === 0 || (me !== null && todo.length === 0)} title={`${todo.length} not marked by you yet`} onClick={() => onProofread(todo, true)}>
          Mark all visible as proofread
        </Button>
      </div>

      {lines.length === 0 ? (
        <Empty title="No lines yet">The rulebook has nothing to proofread.</Empty>
      ) : visible.length === 0 ? (
        <Empty title={filter === "mine" ? (me ? "You haven't proofread anything yet" : "Choose your name to see your own marks") : "Nothing left to check"}>
          {filter === "mine" ? "Lines you mark as proofread appear here." : "Every line has been checked. Switch to All to see them."}
        </Empty>
      ) : (
        <div onKeyDown={move} className="grid gap-5">
          {sectionsOf(visible).map((s) => (
            <section key={s.title} aria-label={s.title}>
              <h2 className="mb-2 flex items-baseline gap-2 text-body font-semibold">
                {s.title}
                <span className="font-normal text-muted">{s.lines.length}</span>
              </h2>
              <ul className="grid gap-1.5">
                {s.lines.map((l) => {
                  const on = isLine(l, selected);
                  return (
                    <li key={l.key} className={cx("flex items-start gap-2 rounded-field p-1.5 ring-1", on ? "bg-brand-soft ring-brand" : "bg-surface ring-line")}>
                      <button ref={on ? here : undefined} type="button" data-line aria-current={on ? "true" : undefined} onClick={() => onSelect(l)} className="grid min-w-0 flex-1 gap-1 rounded-[10px] px-2.5 py-1.5 text-left">
                        <span className="text-body font-medium break-words">{l.name}</span>
                        <span className="num text-small break-words text-muted">{l.value}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-small text-muted">
                          <ProofBadge evidence={l.evidence} />
                          {l.openQuestion && <Badge tone="warn">Open question</Badge>}
                          <span>{proofStatus(version, l.items)}</span>
                        </span>
                      </button>
                      <div className="shrink-0 py-1.5 pr-2">
                        <ProofreadMark compact items={l.items} name={l.name} version={version} me={me} busy={busy} onProofread={onProofread} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
