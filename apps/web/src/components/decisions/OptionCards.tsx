"use client";

import type { Question } from "@dct/shared";
import { Badge, cx } from "@/components/ui";

/**
 * The answers as big cards. Each is a real radio (hidden, but focusable and announced) so a screen reader and the arrow
 * keys work as usual; the number is the key that picks it.
 */
export function OptionCards({ question, choice, locked, onChoose }: { question: Question; choice: number | null; locked: boolean; onChoose: (i: number) => void }) {
  return (
    <div role="radiogroup" aria-label={locked ? "The answer" : "Your answer"} className="flex flex-col gap-3">
      {question.options.map((o, i) => {
        const picked = choice === i;
        const suggested = question.suggestion?.option === i;
        return (
          <label
            key={i}
            className={cx(
              // relative: the hidden radio stays inside its card, so it can't stretch the page or pull focus off-screen
              "relative flex items-start gap-4 rounded-tile border-2 p-4 transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/25",
              locked ? "cursor-default" : "cursor-pointer",
              picked ? "border-brand bg-brand-soft" : locked ? "border-line bg-surface opacity-70" : "border-line-strong bg-surface hover:bg-sunken",
            )}
          >
            <input type="radio" name="option" className="sr-only" checked={picked} disabled={locked} onChange={() => onChoose(i)} />
            <span aria-hidden className={cx("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-small font-semibold", picked ? "bg-primary text-on-primary" : "bg-ink/[0.06] text-ink-2")}>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lead font-medium break-words">{o.label}</span>
              {suggested && !locked && (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone="accent">Suggested</Badge>
                  {question.suggestion!.reason && <span className="text-small break-words text-muted">Why: {question.suggestion!.reason}</span>}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
