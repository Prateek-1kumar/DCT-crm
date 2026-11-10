"use client";

import type { Region } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { api, keys } from "@/lib/queries";
import type { CoverageRef } from "@/lib/types";
import { MARK_LOOK, PageView, type Box, type Mark } from "../PageView";
import { docName, findTerm, pageAt, STATUS, sourceOf, type ProofData, type Spot } from "../proof/model";
import { Button, cx, Empty } from "../ui";
import { amountsOf, isProblem, visibleAmounts } from "./highlights";

const GLYPH = { captured: "✓", decided: "✎", set_aside: "–", missing: "!" } as const;
const DOUBT_GLYPH = "?";
const ZOOMS = [0.75, 1, 1.5, 2, 3];

/** Where the words a term quotes sit on its page: found by searching a text page, else the boxes the checker saved. */
function useQuoteBoxes(data: ProofData, line: CoverageRef | null, spot: Spot) {
  const term = line?.target === "term" ? findTerm(data, line.id) : undefined;
  const home = term && line ? sourceOf(data, line) : null;
  const homePage = pageAt(data, home);
  const quote = term?.source.quote ?? "";
  const search = useQuery({
    queryKey: keys.find(home?.doc ?? "", home?.page ?? 0, quote),
    queryFn: () => api.find(home!.doc, home!.page, quote),
    enabled: !!home && homePage?.kind === "text" && quote !== "",
  });
  const here = !!home && home.doc === spot.doc && home.page === spot.page;
  const saved = homePage?.clauses.filter((c) => c.termId === term?.id).flatMap((c) => c.boxes) ?? [];
  const boxes: Region[] = !here ? [] : search.data?.boxes.length ? search.data.boxes : saved;
  return { boxes, pending: here && search.isLoading, expected: here };
}

const LEGEND: { mark: Mark; text: string }[] = [
  { mark: "captured", text: "Matches the rulebook" },
  { mark: "decided", text: "Decided by a person" },
  { mark: "set_aside", text: "Set aside on purpose" },
  { mark: "missing", text: "Not in the rulebook" },
];

/**
 * One contract page with the spot a line came from highlighted strongly. Other amounts are light, and by default only
 * the problems (missing or doubtful) are drawn; "Show every amount" draws them all. The page, the zoom and the toggle
 * are the viewer's own; the page is the parent's (`spot`) so a link or a click can move it.
 */
export function LineViewer({ data, line, spot, onSpot, scrollCls = "max-h-[70vh]" }: { data: ProofData; line: CoverageRef | null; spot: Spot; onSpot: (spot: Spot, amountRef?: CoverageRef | null) => void; scrollCls?: string }) {
  const [showAll, setShowAll] = useState(false);
  const [zoomAt, setZoomAt] = useState(1);
  const quote = useQuoteBoxes(data, line, spot);
  const page = pageAt(data, spot);
  const at = data.pages.findIndex((p) => p.documentId === spot.doc && p.page === spot.page);

  if (!page) return <Empty title="This spot isn't on the page we have">The contract has no page like that, or it can&apos;t be shown. Pick another line, or move to a page with the buttons.</Empty>;

  const strong = line ? amountsOf(page, line) : [];
  const drawn = visibleAmounts(page, { showAll, selected: spot.box, strong });
  const problems = page.amounts.filter(isProblem).length;
  const name = (a: { ref: CoverageRef | null }) => {
    const r = a.ref;
    return r && (r.target === "term" ? findTerm(data, r.id)?.name : data.rulebook.grids.find((g) => g.id === r.id)?.name);
  };

  const quoted: Box[] = quote.boxes.map((box) => ({ box, mark: "highlight", label: "The words quoted in the rulebook" }));
  const amounts: Box[] = drawn.map((i) => {
    const a = page.amounts[i]!;
    const on = i === spot.box || strong.includes(i);
    const named = name(a);
    return {
      box: a.box,
      mark: on ? "highlight" : a.status,
      selected: i === spot.box,
      glyph: a.doubt ? DOUBT_GLYPH : GLYPH[a.status],
      label: `${a.text} · ${STATUS[a.status].chip}${named ? ` as ${named}` : ""}${a.doubt ? ` · read with a doubt: ${a.doubt.replace("_", " ")}` : ""}`,
      onClick: () => onSpot({ doc: page.documentId, page: page.page, box: i }, a.ref),
    };
  });
  const focus = quote.boxes[0] ?? (spot.box !== null ? page.amounts[spot.box]?.box : undefined) ?? page.amounts[strong[0] ?? -1]?.box;
  const step = (by: number) => {
    const to = data.pages[at + by];
    if (to) onSpot({ doc: to.documentId, page: to.page, box: null });
  };
  const zoom = (by: number) => setZoomAt(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoomAt) + by))]!);
  const lost = quote.expected && !quote.pending && quote.boxes.length === 0 && page.kind !== "image";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5" role="group" aria-label="Pages">
          <Button size="icon-sm" aria-label="Previous page" disabled={at <= 0} onClick={() => step(-1)}>
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <p className="min-w-0 text-small text-ink-2" aria-live="polite">
            <span className="font-medium">
              Page {page.page} of {data.version.documents.find((d) => d.id === page.documentId)?.pageCount ?? "?"}
            </span>
            {data.version.documents.length > 1 && <span className="block max-w-[26ch] truncate text-muted" title={docName(data, page.documentId)}>{docName(data, page.documentId)}</span>}
          </p>
          <Button size="icon-sm" aria-label="Next page" disabled={at < 0 || at >= data.pages.length - 1} onClick={() => step(1)}>
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Zoom">
          <Button size="icon-sm" aria-label="Zoom out" disabled={zoomAt === ZOOMS[0]} onClick={() => zoom(-1)}>
            <Minus aria-hidden className="size-4" />
          </Button>
          <span className="num w-10 text-center text-small text-muted">{Math.round(zoomAt * 100)}%</span>
          <Button size="icon-sm" aria-label="Zoom in" disabled={zoomAt === ZOOMS.at(-1)} onClick={() => zoom(1)}>
            <Plus aria-hidden className="size-4" />
          </Button>
        </div>
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => setShowAll(!showAll)}
          className={cx("ml-auto h-8 rounded-full border px-3.5 text-small font-medium", showAll ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted")}
        >
          Show every amount
        </button>
      </div>

      <p className="text-small text-muted">
        {problems === 0 ? "Nothing on this page needs a look." : `${problems} ${problems === 1 ? "amount" : "amounts"} on this page ${problems === 1 ? "needs" : "need"} a look.`}
        {!showAll && page.amounts.length > problems && ` ${page.amounts.length - problems} more ${page.amounts.length - problems === 1 ? "is" : "are"} hidden.`}
      </p>
      {showAll && (
        <ul aria-label="What the outlines mean" className="flex flex-wrap gap-x-4 gap-y-1 text-small text-ink-2">
          {LEGEND.map((l) => (
            <li key={l.mark} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cx("inline-grid size-4 place-items-center rounded-[3px] text-[10px] font-bold", MARK_LOOK[l.mark])}>
                {GLYPH[l.mark as keyof typeof GLYPH]}
              </span>
              {l.text}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-grid size-4 place-items-center rounded-[3px] border border-line-strong bg-surface text-[10px] font-bold">
              {DOUBT_GLYPH}
            </span>
            Read with a doubt
          </li>
        </ul>
      )}
      {page.kind === "image" && <p className="rounded-field bg-warn-soft px-4 py-2 text-small text-warn">Scanned page: the words on it can&apos;t be searched or checked. Read it on the page below.</p>}
      {page.kind === "scan" && <p className="rounded-field bg-sunken px-4 py-2 text-small text-muted">Scanned page, read from the image.</p>}
      {lost && <p className="rounded-field bg-warn-soft px-4 py-2 text-small text-warn">We couldn&apos;t find the exact words on this page. The page is shown so you can look.</p>}

      <div data-page-scroller className={cx("min-h-0 overflow-auto rounded-tile bg-sunken", scrollCls)}>
        <PageView key={`${spot.doc}-${spot.page}`} documentId={spot.doc} page={spot.page} alt={`${docName(data, spot.doc)}, page ${spot.page}`} boxes={[...quoted, ...amounts]} focus={focus} zoom={zoomAt} />
      </div>
    </div>
  );
}
