"use client";

import { useQuery } from "@tanstack/react-query";
import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActingAs } from "@/lib/acting-as";
import { api, keys } from "@/lib/queries";
import type { Coverage, CoverageRef, Version } from "@/lib/types";
import { buildProof, encodeRef, type ProofData } from "../proof/model";
import type { ShowRef } from "../rulebook";
import { ProofBadge } from "../rulebook/parts";
import { Skeleton } from "../study/Skeleton";
import { Button, cx, Empty, LoadError } from "../ui";
import { APPROX_NOTE, ContractViewer, ReviewActions } from "../viewer";
import { itemsOf } from "./proofreads";
import { headOf, usePassage } from "./side/passage";

// Before the pages are checked there is nothing on them to draw; the header and the page still work.
const NO_COVERAGE: Coverage = { pages: [], totals: { amounts: 0, captured: 0, decided: 0, setAside: 0, missing: 0 } };
// About two lines of quote at this width; a longer one gets "Show full quote".
const LONG_QUOTE = 140;

const toggleCls = (on: boolean) => cx("h-8 rounded-full border px-3.5 text-small font-medium", on ? "border-brand bg-brand-soft text-accent" : "border-line-strong bg-surface text-muted");

function Viewer({ data, line }: { data: ProofData; line: CoverageRef }) {
  const [moved, setMoved] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const p = usePassage(data, line, moved, showAll);

  if (!p.home) return <Empty title="This spot isn't on the pages we have">We couldn&apos;t tell which page this came from. Open the full view to look through the contract.</Empty>;
  if (p.pending) return (
      <div role="status" aria-label="Finding the passage on the page" className="h-full">
        <Skeleton className="h-full w-full rounded-tile" />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {p.lost && <p className="rounded-field bg-warn-soft px-3 py-1.5 text-small text-warn">We couldn&apos;t find the exact words on this page. The page is shown so you can look.</p>}
      {p.focusApprox && <p className="px-1 text-small text-muted">{APPROX_NOTE}</p>}
      <ContractViewer
        documentId={p.docId}
        page={p.page}
        pageCount={p.pageCount}
        onPageChange={setMoved}
        boxes={p.boxes}
        focus={p.focus}
        startIn="passage"
        ariaLabel={p.docName}
        toolbarExtra={
          <button type="button" aria-pressed={showAll} onClick={() => setShowAll(!showAll)} className={toggleCls(showAll)}>
            Show every amount
          </button>
        }
      />
    </div>
  );
}

function Header({ data, line, version, onOpenFull, onClose, heading }: { data: ProofData; line: CoverageRef; version: Version; onOpenFull: () => void; onClose: () => void; heading: React.RefObject<HTMLHeadingElement | null> }) {
  const me = useActingAs();
  const [fullQuote, setFullQuote] = useState(false);
  const [details, setDetails] = useState(false);
  const head = headOf(data, line);
  const items = itemsOf(data.rulebook, line);

  return (
    // The cap keeps a long quote or a flag note from squeezing the page out; in the usual case the header is its natural, compact height.
    <header className="max-h-[50%] shrink-0 overflow-y-auto border-b border-line px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="contract-panel-title" ref={heading} tabIndex={-1} className="min-w-0 text-title font-semibold tracking-tight break-words outline-none">
            {head ? head.name : "In the contract"}
          </h2>
          {head && <p className="num text-heading font-semibold tracking-tight break-words">{head.value}</p>}
          {head && <ProofBadge evidence={head.evidence} />}
        </div>
        <Button size="sm" variant="secondary" onClick={onOpenFull}>
          <Maximize2 aria-hidden className="size-3.5" />
          Expand
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close the contract panel" onClick={onClose}>
          <X aria-hidden className="size-4" />
        </Button>
      </div>

      {head ? (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-small text-muted">
            <span>
              Page {head.page} · {head.doc}
            </span>
            {head.quote && head.quote.length > LONG_QUOTE && (
              <button type="button" aria-expanded={fullQuote} onClick={() => setFullQuote(!fullQuote)} className="font-medium text-accent hover:text-accent-hover hover:underline">
                {fullQuote ? "Show less" : "Show full quote"}
              </button>
            )}
            <button type="button" aria-expanded={details} onClick={() => setDetails(!details)} className="font-medium text-accent hover:text-accent-hover hover:underline">
              Details
            </button>
          </p>
          {head.quote && (
            <p className={cx("mt-1 text-small text-ink-2 break-words", !fullQuote && "line-clamp-2")}>
              <q>{head.quote}</q>
            </p>
          )}
          {details && (
            <dl className="mt-2 grid gap-1.5 rounded-field bg-sunken px-3 py-2 text-small sm:grid-cols-2">
              {head.details.length === 0 && <p className="text-muted">Nothing more is recorded for this line.</p>}
              {head.details.map(([label, text]) => (
                <div key={label} className="min-w-0">
                  <dt className="eyebrow">{label}</dt>
                  <dd className="break-words text-ink">{text}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      ) : (
        <p className="mt-1 text-small text-muted">This line is no longer in the rulebook.</p>
      )}
      {items.length > 0 && (
        <div className="mt-2">
          <ReviewActions version={version} items={items} me={me} compact />
        </div>
      )}
    </header>
  );
}

// COMPONENT: a proper right-hand drawer (focus trap optional, drag to resize). This is a plain fixed column: about half the screen from 640px up, a full-screen sheet below.
function Panel({ version, target, onClose, onOpenFull, remember }: { version: Version; target: ShowRef; onClose: () => void; onOpenFull: () => void; remember: (from: Element) => void }) {
  const coverage = useQuery({ queryKey: keys.coverage(version.id), queryFn: () => api.coverage(version.id), enabled: !!version.rulebook });
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    // Whatever was focused (the card's button) is where focus goes back to when the panel closes.
    const from = document.activeElement;
    if (from && !root.current?.contains(from)) remember(from);
    heading.current?.focus();
  }, [remember]);

  const data = version.rulebook ? buildProof(version, coverage.data ?? NO_COVERAGE) : null;

  return (
    <aside
      ref={root}
      aria-labelledby="contract-panel-title"
      onKeyDown={(e) => e.key === "Escape" && !(e.target as HTMLElement).closest("textarea, input") && onClose()}
      className="fixed inset-y-0 right-0 z-40 flex w-[min(50vw,760px)] min-w-[520px] flex-col bg-surface shadow-raised ring-1 ring-ink/[0.08] max-sm:inset-0 max-sm:w-full max-sm:min-w-0"
    >
      {data ? (
        <Header data={data} line={target} version={version} onOpenFull={onOpenFull} onClose={onClose} heading={heading} />
      ) : (
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="contract-panel-title" ref={heading} tabIndex={-1} className="mr-auto text-title font-semibold tracking-tight outline-none">
            In the contract
          </h2>
          <Button size="icon-sm" variant="ghost" aria-label="Close the contract panel" onClick={onClose}>
            <X aria-hidden className="size-4" />
          </Button>
        </header>
      )}
      <div className="min-h-0 flex-1 p-3">
        {!data ? (
          <Empty title="Nothing to show yet">The rulebook appears here once the contract has been read.</Empty>
        ) : coverage.isError ? (
          <LoadError error={coverage.error} what="the contract pages" retry={() => void coverage.refetch()} back={{ href: "/", label: "Back to contracts" }} />
        ) : coverage.isPending ? (
          <div aria-label="Loading the contract page" className="grid h-full gap-3">
            <Skeleton className="h-full w-full rounded-tile" />
          </div>
        ) : (
          <Viewer data={data} line={target} />
        )}
      </div>
    </aside>
  );
}

/** "Show in the contract": a column over the right half of the screen with a compact header and the contract page zoomed on the passage. Mount once; pass the card's ref as `target`, or null to close. */
export function ContractSidePanel(props: { version: Version; target: ShowRef | null; onClose: () => void; onOpenFull: () => void }) {
  const opener = useRef<Element | null>(null);
  const open = props.target !== null;
  const remember = useCallback((from: Element) => {
    opener.current = from;
  }, []);
  useEffect(() => {
    if (open) return;
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, [open]);
  return props.target ? <Panel key={encodeRef(props.target)} {...props} target={props.target} remember={remember} /> : null;
}
