"use client";

import type { Question, Region } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { APPROX_NOTE, approxLabel, ContractViewer, type ViewerBox } from "@/components/viewer";
import { api, keys } from "@/lib/queries";
import type { Version } from "@/lib/types";

const union = (boxes: Region[]): Region | null =>
  boxes.length === 0 ? null : [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];

/**
 * The contract, opened at the passage a question is about: a one-line strip with the quote above the viewer, which fills the
 * height its parent gives it. The person can turn to other pages; "Back to the passage" returns to the question's own page.
 */
export function ContractPane({ version, question }: { version: Version; question: Question }) {
  const { doc: name, page, quote, region } = question.source;
  const doc = version.documents.find((d) => d.name === name);
  // The page the person turned to, remembered per question so moving to the next question starts on its own page again.
  const [turned, setTurned] = useState<{ id: string; page: number } | null>(null);
  const shown = turned?.id === question.id ? turned.page : page;
  const onPassagePage = shown === page;

  // The quoted words, searched on the page, are the exact spot. `question.source.region` is four numbers an AI model typed (a guess),
  // so it is only the fallback when the words can't be found, and is then drawn as approximate.
  const found = useQuery({ queryKey: keys.find(doc?.id ?? "", page, quote), queryFn: () => api.find(doc!.id, page, quote), enabled: !!doc && quote !== "" });
  // Until the search has answered nothing is drawn, so a guess never shows first and then jumps to the real words.
  const searching = quote !== "" && found.isLoading;
  const data = found.data;
  const { spots, approx, ofWords } = useMemo<{ spots: Region[]; approx: boolean; ofWords: boolean }>(() => {
    if (searching) return { spots: [], approx: false, ofWords: false };
    if (data && data.boxes.length > 0) return { spots: data.boxes, approx: !!data.approx, ofWords: true };
    return region ? { spots: [region], approx: true, ofWords: false } : { spots: [], approx: false, ofWords: false };
  }, [searching, data, region]);
  const missed = quote !== "" && !searching && spots.length === 0;
  const focus = useMemo(() => union(spots), [spots]);
  const boxes = useMemo<ViewerBox[]>(
    () =>
      spots.map((box, i) => ({
        id: `focus-${i}`,
        box,
        tone: "focus",
        label: approxLabel(ofWords ? "The words this question is about" : "The part of the page this question is about", approx),
        ...(approx && { approx: true }),
      })),
    [spots, ofWords, approx],
  );

  const unavailable = !doc || page > doc.pageCount;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-small text-ink-2">
        {quote ? (
          <>
            <span className="shrink-0 font-medium">The contract says:</span>
            <blockquote title={quote} className="min-w-0 truncate text-ink">
              &ldquo;{quote}&rdquo;
            </blockquote>
          </>
        ) : (
          <span className="shrink-0 font-medium">The contract</span>
        )}
        <span title={name} className="shrink-0 whitespace-nowrap text-muted">
          · page {page} · <span className="inline-block max-w-[16ch] truncate align-bottom">{name}</span>
        </span>
        {!onPassagePage && (
          <button type="button" onClick={() => setTurned(null)} className="ml-auto shrink-0 font-medium whitespace-nowrap text-accent hover:text-accent-hover">
            Back to the passage
          </button>
        )}
      </div>
      {approx && onPassagePage && <p className="text-small text-muted">{APPROX_NOTE}</p>}
      {missed && <p className="rounded-field bg-warn-soft px-3 py-1.5 text-small text-warn">We couldn&apos;t highlight the exact words on this page.</p>}
      {unavailable ? (
        <p role="alert" className="grid flex-1 place-items-center rounded-tile bg-sunken px-6 py-10 text-center text-body text-muted">
          We couldn&apos;t show this page. The question is still answerable from what it says on the left.
        </p>
      ) : (
        <ContractViewer
          documentId={doc.id}
          page={shown}
          pageCount={doc.pageCount}
          onPageChange={(p) => setTurned({ id: question.id, page: p })}
          boxes={onPassagePage ? boxes : []}
          focus={onPassagePage ? focus : null}
          startIn="passage"
          ariaLabel="Contract page"
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
