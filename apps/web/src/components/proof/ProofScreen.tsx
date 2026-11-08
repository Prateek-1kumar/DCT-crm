"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import { useMounted } from "@/lib/use-mounted";
import type { Coverage, Version } from "@/lib/types";
import { Skeleton } from "../study/Skeleton";
import { btnCls, Button, cx, Empty, LoadError, Sheet } from "../ui";
import { ContractViewer, useReviewActions } from "../viewer";
import { markState } from "../viewer/reviewState";
import { AmountStrip, ClaimStrip, NoClaim } from "./ClaimStrip";
import { claimOf } from "./claim";
import { ItemRail } from "./ItemRail";
import { buildLines, defaultLine, filterLines, isLine, needsChecking, nextUnchecked, progress, stepLine, type Line, type LineFilter } from "./lines";
import { buildProof, docName, pageAt, spotFor, type ProofData, type Spot } from "./model";
import { shortcutOf } from "./keys";
import { TopBar } from "./TopBar";
import { useFillHeight, useIsNarrow } from "./useScreenSize";
import { useProofUrl } from "./useProofUrl";
import { useQuoteBoxes } from "./useQuoteBoxes";
import { amountIndex, viewerBoxes } from "./viewerBoxes";

/** The screen's frame: it fills the window under the version header and never scrolls as a page; the rail and the viewer scroll inside themselves. */
function Frame({ children, rootRef, onKeyDown }: { children: ReactNode; rootRef?: RefObject<HTMLDivElement | null>; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void }) {
  const own = useRef<HTMLDivElement>(null);
  const ref = rootRef ?? own;
  const height = useFillHeight(ref);
  // tabIndex -1: a click anywhere on the screen puts focus here, so the one-key shortcuts keep working after clicking the page.
  return (
    <div ref={ref} tabIndex={-1} onKeyDown={onKeyDown} style={height ? { height } : undefined} className="flex h-[calc(100dvh-14rem)] min-h-[480px] w-full flex-col outline-none">
      {children}
    </div>
  );
}

function ProofSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Loading the proofread screen">
      <Skeleton className="m-3 h-8 w-2/3" />
      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <Skeleton className="hidden w-[300px] shrink-0 rounded-card lg:block" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Skeleton className="h-24 w-full rounded-card" />
          <Skeleton className="min-h-0 w-full flex-1 rounded-card" />
        </div>
      </div>
    </div>
  );
}

/** Reads the version and the coverage check, then hands them to the screen. The first client render must match the server's, so cached data is drawn only after mount. */
export function ProofScreen({ versionId }: { versionId: string }) {
  const mounted = useMounted();
  const version = useQuery({ queryKey: keys.version(versionId), queryFn: () => api.version(versionId) });
  const coverage = useQuery({ queryKey: keys.coverage(versionId), queryFn: () => api.coverage(versionId) });

  const error = version.error ?? coverage.error;
  if (error) {
    return (
      <Frame>
        <LoadError error={error} what="the proofread screen" retry={() => void Promise.all([version.refetch(), coverage.refetch()])} />
      </Frame>
    );
  }
  if (!mounted || !version.data || !coverage.data) {
    return (
      <Frame>
        <ProofSkeleton />
      </Frame>
    );
  }
  const data = buildProof(version.data, coverage.data);
  if (!data) {
    return (
      <Frame>
        <div className="p-6">
          <Empty title="Nothing to proofread yet">The contract is still being read. The rulebook appears here once it is drafted.</Empty>
        </div>
      </Frame>
    );
  }
  return <Proofreading key={version.data.id} data={data} totals={coverage.data.totals} />;
}

function Proofreading({ data, totals }: { data: ProofData; totals: Coverage["totals"] }) {
  const v: Version = data.version;
  const { url, set } = useProofUrl();
  const me = useActingAs();
  const actions = useReviewActions(v, me);
  const narrow = useIsNarrow();
  const [filter, setFilter] = useState<LineFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  const [said, setSaid] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const working = useRef(false);

  const lines = useMemo(() => buildLines(v), [v]);
  const visible = filterLines(lines, v, me, filter);
  const counts: Record<LineFilter, number> = {
    all: lines.length,
    needs: filterLines(lines, v, me, "needs").length,
    flagged: filterLines(lines, v, me, "flagged").length,
    mine: filterLines(lines, v, me, "mine").length,
  };
  const { done, total } = progress(lines, v);

  // The first item to check is picked here, not written to the URL (Back must leave the screen), and kept so that marking it doesn't make the selection jump on its own.
  // A link that names only a page or an amount (a missing one has no item) is left as it is.
  const pageLink = !url.ref && !!url.doc && !!url.page;
  const [pinned, setPinned] = useState<string | null>(null);
  const firstKey = pinned ?? defaultLine(lines, v)?.key ?? null;
  if (pinned === null && firstKey !== null && !url.ref && !pageLink) setPinned(firstKey);
  const line = url.ref ? lines.find((l) => isLine(l, url.ref)) : pageLink ? undefined : lines.find((l) => l.key === firstKey);

  const ref = url.ref ?? line?.ref ?? null;
  const first = v.documents[0];
  const named = url.doc && url.page ? { doc: url.doc, page: url.page, box: url.box } : ref ? spotFor(data, ref) : null;
  const at: Spot | null = named ?? (first ? { doc: first.id, page: 1, box: null } : null);
  const page = pageAt(data, at);
  const pageCount = v.documents.find((d) => d.id === at?.doc)?.pageCount ?? 0;

  const quote = useQuoteBoxes(data, ref, at);
  const { boxes, focus, problems } = viewerBoxes(data, page, { ref, quote, selectedBox: at?.box ?? null, showAll });
  const claim = line ? claimOf(data, line, url.ref) : null;
  const amount = !line && at?.box != null ? page?.amounts[at.box] : undefined;

  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);

  const pick = (l: Line) => {
    setFinished(false);
    set({ ref: l.ref, doc: null, page: null, box: null });
  };
  const step = (by: 1 | -1) => {
    const to = stepLine(visible, line?.key ?? null, by);
    if (to) pick(to);
  };
  const nextMissing = () => {
    const missing = data.pages.flatMap((p) => p.amounts.flatMap((a, i): Spot[] => (a.status === "missing" ? [{ doc: p.documentId, page: p.page, box: i }] : [])));
    const here = missing.findIndex((m) => m.doc === at?.doc && m.page === at.page && m.box === at.box);
    const next = missing[(here + 1) % missing.length];
    if (next) set({ ref: null, ...next });
  };
  const onBoxClick = (id: string) => {
    const i = amountIndex(id);
    const a = i === null ? undefined : page?.amounts[i];
    if (i === null || !a || !at) return;
    setFinished(false);
    set({ ref: a.ref, doc: at.doc, page: at.page, box: i });
  };

  /** Marks the selected item as matching, then moves to the next one nobody has checked yet. */
  const matchAndNext = async () => {
    if (!line || !claim || working.current) return;
    working.current = true;
    try {
      if (!me) {
        await actions.match(claim.items); // asks who is working; sends nothing
        return;
      }
      let latest = v;
      if (markState(v, claim.items, me).todo.length > 0) {
        const updated = await actions.match(claim.items);
        if (!updated) return;
        latest = updated;
      }
      const next = nextUnchecked(lines, latest, line.key);
      if (next) {
        pick(next);
        setSaid(`Checked. Next: ${next.name}`);
      } else if (needsChecking(line, latest)) setSaid("Checked. The rest of this budget grid still needs checking.");
      else {
        setFinished(true);
        setSaid("Checked. Everything is checked.");
      }
    } finally {
      working.current = false;
      // the button that had focus may be gone; without this the keys would stop working
      if (document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true });
    }
  };

  // The note belongs to the review buttons in the strip, so the keys press its own buttons.
  const strip = () => stripRef.current;
  const press = (text: string) => [...(strip()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.includes(text))?.click();
  const flag = () => {
    const box = strip()?.querySelector("textarea");
    if (box) box.focus();
    else press("Something looks wrong");
  };
  const close = () => {
    if (helpOpen) return setHelpOpen(false);
    if (strip()?.querySelector("textarea")) {
      press("Cancel");
      rootRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    // Esc closes a note even from inside it; everything else leaves typing alone.
    if (e.key !== "Escape" && t.closest("input, textarea, select, [contenteditable='true']")) return;
    const act = shortcutOf(e.key, { onControl: !!t.closest("button, a, summary") && !t.closest("[data-active-row]"), inViewer: !!t.closest("[data-proof-viewer]") });
    if (!act) return;
    e.preventDefault();
    if (act === "match") void matchAndNext();
    else if (act === "next") step(1);
    else if (act === "prev") step(-1);
    else if (act === "flag") flag();
    else if (act === "help") setHelpOpen(!helpOpen);
    else close();
  };

  const studyHref = `/studies/${v.studyId}`;
  const rail = (onSelect: (l: Line) => void) => <ItemRail lines={lines} visible={visible} filter={filter} version={v} selected={line?.key ?? null} onSelect={onSelect} />;

  if (lines.length === 0) {
    return (
      <Frame>
        <div className="p-6">
          <Empty title="No items to proofread" action={<Link href={studyHref} className={btnCls("secondary")}>Back to contract</Link>}>
            The rulebook has no items yet, so there is nothing to check against the contract.
          </Empty>
        </div>
      </Frame>
    );
  }

  return (
    <Frame rootRef={rootRef} onKeyDown={onKeyDown}>
      <TopBar
        studyHref={studyHref}
        done={done}
        total={total}
        filter={filter}
        counts={counts}
        onFilter={setFilter}
        missing={totals.missing}
        onNextMissing={nextMissing}
        narrow={narrow}
        onOpenItems={() => setItemsOpen(true)}
        helpOpen={helpOpen}
        onToggleHelp={() => setHelpOpen(!helpOpen)}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      <div className="flex min-h-0 flex-1">
        {narrow ? (
          <Sheet open={itemsOpen} onClose={() => setItemsOpen(false)} label="Items to proofread">
            <div className="flex h-full flex-col bg-surface">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <h2 className="text-body font-semibold">Items</h2>
                <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setItemsOpen(false)}>
                  ✕
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                {rail((l) => {
                  pick(l);
                  setItemsOpen(false);
                })}
              </div>
            </div>
          </Sheet>
        ) : (
          <aside aria-label="Items to proofread" className="w-[300px] shrink-0 border-r border-line">
            {rail(pick)}
          </aside>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
          {finished ? (
            <div className="grid flex-1 place-items-center">
              <div className="grid max-w-md justify-items-center gap-3 text-center">
                <h3 className="text-heading font-semibold">Everything is checked</h3>
                <p className="text-body text-muted">Every item in the rulebook has been checked by someone. Marks are a record of who looked; approval doesn&apos;t wait for them.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <Link href={studyHref} className={btnCls("secondary")}>
                    Back to the contract
                  </Link>
                  <Link href={`/versions/${v.id}/approve`} className={btnCls("primary")}>
                    Go to Approve
                  </Link>
                  <Button variant="ghost" onClick={() => setFinished(false)}>
                    Keep looking
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <>
              {claim && line ? (
                <ClaimStrip claim={claim} version={v} me={me} stripRef={stripRef} itemsKey={`${line.key}:${claim.items.join(",")}`} />
              ) : amount ? (
                <AmountStrip amount={amount} />
              ) : (
                <NoClaim>{url.ref ? "This item is no longer in the rulebook. Pick another from the list." : "Pick an item from the list to see what the rulebook claims about it."}</NoClaim>
              )}
              <div data-proof-viewer className="min-h-0 flex-1">
                {at && pageCount > 0 ? (
                  <ContractViewer
                    documentId={at.doc}
                    page={at.page}
                    pageCount={pageCount}
                    onPageChange={(p) => set({ doc: at.doc, page: p, box: null })}
                    boxes={boxes}
                    focus={focus}
                    startIn="passage"
                    onBoxClick={onBoxClick}
                    ariaLabel={docName(data, at.doc)}
                    toolbarExtra={
                      <>
                        <span className="text-small text-muted">{problems === 0 ? "Nothing here needs a look" : `${problems} ${problems === 1 ? "amount needs" : "amounts need"} a look`}</span>
                        <button
                          type="button"
                          aria-pressed={showAll}
                          onClick={() => setShowAll(!showAll)}
                          className={cx("h-7 rounded-full border px-3 text-small font-medium", showAll ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted hover:bg-sunken")}
                        >
                          Show every amount
                        </button>
                      </>
                    }
                  />
                ) : (
                  <Empty title="There is no page to show">This contract has no pages we can show. Go back to the contract and check its files.</Empty>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}
