"use client";

import { ChevronDown, ChevronRight, CircleCheck, Circle, Flag, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Version } from "@/lib/types";
import { cx, Empty } from "../ui";
import { lineStatus, sectionsOf, type Line, type LineFilter, type LineStatus } from "./lines";

/** Each status differs in shape as well as colour, and says its name to a screen reader. */
const DOT: Record<LineStatus, { icon: ReactNode; cls: string; word: string }> = {
  unchecked: { icon: <Circle aria-hidden className="size-4" />, cls: "text-faint", word: "not checked yet" },
  checked: { icon: <CircleCheck aria-hidden className="size-4" />, cls: "text-ok", word: "checked" },
  flagged: { icon: <Flag aria-hidden className="size-4 fill-current" />, cls: "text-danger", word: "flagged as looking wrong" },
  look: { icon: <TriangleAlert aria-hidden className="size-4" />, cls: "text-warn", word: "needs a look" },
};

// COMPONENT: Kbd chip. A plain keycap until the owner's design system has one.
export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-line-strong bg-surface px-1 text-caption font-medium text-ink-2 shadow-button">{children}</kbd>
);

const HINTS: { keys: string[]; text: string }[] = [
  { keys: ["Space"], text: "matches, then next" },
  { keys: ["J", "K"], text: "next / previous" },
  { keys: ["F"], text: "something looks wrong" },
  { keys: ["?"], text: "all keys" },
];

export const ShortcutList = () => (
  <ul className="grid gap-1.5 text-small text-ink-2">
    {[
      ["Space or Enter", "Matches the contract, then the next item to check"],
      ["J or ↓", "Next item"],
      ["K or ↑", "Previous item"],
      ["F", "Something looks wrong (opens the note)"],
      ["Esc", "Close the note"],
      ["?", "Show or hide these keys"],
    ].map(([k, t]) => (
      <li key={k} className="flex items-baseline gap-2">
        <span className="w-28 shrink-0">
          <Kbd>{k}</Kbd>
        </span>
        {t}
      </li>
    ))}
  </ul>
);

/**
 * Every item of the rulebook as one compact row, under the Overview's group headings (collapsible, all open to begin
 * with). Rows are buttons; the screen owns the keys that move between them, and focus follows the selection when it was in the rail.
 */
export function ItemRail({ lines, visible, filter, version, selected, onSelect }: { lines: Line[]; visible: Line[]; filter: LineFilter; version: Version; selected: string | null; onSelect: (l: Line) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const rail = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const group = lines.find((l) => l.key === selected)?.group;
  const groupClosed = !!group && closed.has(group);

  // A pick made by key or on the page can land in a closed group: open it so the row is there to see.
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    if (group && closed.has(group)) setClosed(new Set([...closed].filter((g) => g !== group)));
  }
  useEffect(() => {
    const had = rail.current?.contains(document.activeElement);
    active.current?.scrollIntoView?.({ block: "nearest" });
    if (had) active.current?.focus({ preventScroll: true });
  }, [selected, groupClosed]);

  const toggle = (g: string) => setClosed((c) => new Set(c.has(g) ? [...c].filter((x) => x !== g) : [...c, g]));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* relative: the rows' screen-reader-only text is absolutely placed; without a positioned scroller it escapes the list and makes the whole page scroll into blank space */}
      <div ref={rail} className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {lines.length === 0 ? (
          <Empty title="No items yet">The rulebook has nothing to proofread.</Empty>
        ) : visible.length === 0 ? (
          <Empty title={filter === "mine" ? "You haven't checked anything yet" : filter === "flagged" ? "Nothing is flagged" : "Nothing left to check"}>
            {filter === "mine" ? "Items you mark as matching appear here. Choose your name first if you haven't." : filter === "flagged" ? "Items someone says look wrong appear here." : "Every item has been checked. Switch to All to see them."}
          </Empty>
        ) : (
          sectionsOf(visible).map((s) => {
            const open = !closed.has(s.title);
            return (
              <section key={s.title} aria-label={s.title} className="mb-2">
                <button type="button" aria-expanded={open} onClick={() => toggle(s.title)} className="flex w-full items-center gap-1.5 rounded-field px-1.5 py-1 text-left text-small font-semibold text-ink-2 hover:bg-sunken">
                  {open ? <ChevronDown aria-hidden className="size-3.5 shrink-0" /> : <ChevronRight aria-hidden className="size-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate" title={s.title}>
                    {s.title}
                  </span>
                  <span className="num font-normal text-muted">{s.lines.length}</span>
                </button>
                {open && (
                  <ul>
                    {s.lines.map((l) => {
                      const on = l.key === selected;
                      const dot = DOT[lineStatus(l, version)];
                      return (
                        <li key={l.key}>
                          <button
                            ref={on ? active : undefined}
                            type="button"
                            data-line
                            data-active-row={on ? "" : undefined}
                            aria-current={on ? "true" : undefined}
                            onClick={() => onSelect(l)}
                            className={cx("flex w-full items-start gap-2 rounded-field px-2 py-1.5 text-left", on ? "bg-brand-soft ring-1 ring-brand" : "hover:bg-sunken")}
                          >
                            <span className={cx("mt-0.5 shrink-0", dot.cls)}>{dot.icon}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body font-medium" title={l.name}>
                                {l.name}
                              </span>
                              <span className="num block truncate text-small text-muted" title={l.value}>
                                {l.value}
                              </span>
                            </span>
                            <span className="sr-only">, {dot.word}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-caption text-muted" aria-label="Keyboard shortcuts" role="group">
        {HINTS.map((h) => (
          <span key={h.text} className="inline-flex items-center gap-1">
            {h.keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            {h.text}
          </span>
        ))}
      </div>
    </div>
  );
}
