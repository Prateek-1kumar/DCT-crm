"use client";

import { Flag as FlagIcon } from "lucide-react";
import { useState } from "react";
import { useMounted } from "@/lib/use-mounted";
import type { Version } from "@/lib/types";
import { when } from "../study/format";
import { Button, cx } from "../ui";
import { flagsFor, markState, markSummary, noteProblem } from "./reviewState";
import { useReviewActions } from "./useReviewActions";

const MAX_NOTE = 500;

/**
 * What a reviewer clicks on one or more items: "Matches the contract" (or taking that mark back) and "Something looks wrong"
 * with a short note. It shows who has proofread the items and any flags. Records only: nothing here changes the rulebook or
 * holds up approval. With several items, "Matches" marks all of them; "Something looks wrong" is recorded on the first.
 */
export function ReviewActions({ version, items, me, compact, onChange }: { version: Version; items: string[]; me: string | null; compact?: boolean; onChange?: (updated: Version) => void }) {
  const actions = useReviewActions(version, me, onChange);
  const mounted = useMounted();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState("");

  if (items.length === 0) return compact ? null : <p className="text-small text-muted">There is nothing here to proofread.</p>;

  const s = markState(version, items, me);
  const flags = flagsFor(version, items);
  const mine = me !== null && s.mine.length > 0;
  const allMine = mine && s.todo.length === 0;
  const size = compact ? "sm" : "md";

  const match = async () => {
    setResult("");
    if (allMine) {
      if (await actions.unmatch(items)) setResult("Your mark is removed.");
    } else if (await actions.match(items)) setResult("Marked as matching the contract.");
  };

  const openNote = () => {
    if (!me) return actions.match([]); // asks who is working, without sending anything
    setResult("");
    setProblem(null);
    // Flagging again replaces my note, so start from it.
    setNote(flags.find((f) => f.by === me && f.item === items[0])?.note ?? "");
    setNoteOpen(true);
  };

  const saveNote = async () => {
    const p = noteProblem(note);
    setProblem(p);
    if (p) return;
    if (await actions.flag(items[0]!, note)) {
      setNoteOpen(false);
      setResult("Your note is saved.");
    }
  };

  return (
    <div className={cx("flex flex-col", compact ? "gap-2" : "gap-3")}>
      <p className={compact ? "text-small text-muted" : "text-body text-ink-2"}>{markSummary(s.names, s.done, items.length)}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size={size} disabled={actions.busy} onClick={match}>
          {allMine ? (items.length > 1 ? "Remove my marks" : "Remove my mark") : "Matches the contract"}
        </Button>
        {mine && !allMine && (
          <Button variant="ghost" size={size} disabled={actions.busy} onClick={async () => (setResult(""), (await actions.unmatch(items)) && setResult("Your marks are removed."))}>
            Remove my marks
          </Button>
        )}
        {!noteOpen && (
          <Button variant="secondary" size={size} disabled={actions.busy} onClick={openNote}>
            <FlagIcon aria-hidden className="size-3.5" />
            Something looks wrong
          </Button>
        )}
      </div>

      {noteOpen && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveNote();
          }}
        >
          <label className="text-small font-medium text-ink-2" htmlFor={`note-${items[0]}`}>
            What looks wrong?
          </label>
          <textarea
            id={`note-${items[0]}`}
            autoFocus
            rows={3}
            value={note}
            aria-invalid={!!problem}
            aria-describedby={problem ? `note-problem-${items[0]}` : undefined}
            onChange={(e) => {
              setNote(e.target.value);
              if (problem) setProblem(noteProblem(e.target.value));
            }}
            className="w-full resize-y rounded-field border border-line-strong bg-surface px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-focus"
          />
          <div className="flex items-center justify-between gap-3 text-small text-muted">
            <span id={`note-problem-${items[0]}`} role={problem ? "alert" : undefined} className="text-danger">
              {problem}
            </span>
            <span className={note.trim().length > MAX_NOTE ? "text-danger" : undefined}>
              {note.trim().length}/{MAX_NOTE}
            </span>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={actions.busy}>
              Save
            </Button>
            <Button variant="ghost" size="sm" disabled={actions.busy} onClick={() => (setNoteOpen(false), setProblem(null))}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {flags.length > 0 && (
        <ul className="flex flex-col gap-2">
          {flags.map((f) => (
            <li key={`${f.item}:${f.by}`} className="rounded-field bg-warn-soft px-3 py-2 text-small text-ink-2">
              <p className="font-medium text-warn">
                {f.by} says something looks wrong{mounted ? ` · ${when(f.at)}` : ""}
              </p>
              <p className="mt-0.5 break-words whitespace-pre-wrap">{f.note}</p>
              {f.by === me && (
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={async () => (setResult(""), (await actions.unflag(f.item)) && setResult("Your flag is removed."))}
                  className="mt-1 font-medium text-accent hover:text-accent-hover hover:underline disabled:opacity-40"
                >
                  Remove my flag
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Always present so a screen reader hears the result when it appears. */}
      <p role="status" aria-live="polite" className={cx("text-small", result ? "text-ok" : "sr-only")}>
        {result}
      </p>
      {actions.error && (
        <p role="alert" className="rounded-field bg-danger-soft px-3 py-2 text-small text-danger">
          {actions.error}
        </p>
      )}
    </div>
  );
}
