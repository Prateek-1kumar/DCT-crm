"use client";

import type { DocumentDto, PageBox, SourceRef } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { DOC_KIND_LABEL } from "@/lib/format";
import { Button, cx } from "./ui";

/** `box`: where on the page to look, as fractions of the page; draws a highlight. */
type ViewerTarget = { source: SourceRef; label: string; nonce: number; box?: PageBox["box"] };

/** Contract page viewer. `target` jumps to a page, shows what to look for, and highlights its box. */
export function PageViewer({ documents, target }: { documents: DocumentDto[]; target: ViewerTarget | null }) {
  const [docId, setDocId] = useState(documents[0]?.id ?? "");
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Jump when a new target arrives (state adjusted during render, not in an effect).
  const [seen, setSeen] = useState<ViewerTarget | null>(null);
  if (target !== seen) {
    setSeen(target);
    if (target) {
      setDocId(target.source.documentId);
      setPage(target.source.page);
    }
  }

  const doc = documents.find((d) => d.id === docId) ?? documents[0];
  const pages = doc?.pageCount ?? 1;
  const go = (p: number) => setPage(Math.max(1, Math.min(pages, p)));
  const src = useQuery({ queryKey: ["page", doc?.id, page], queryFn: () => api.pageSrc(doc!.id, page), enabled: !!doc, staleTime: Infinity });
  const [failed, setFailed] = useState<string | null>(null);
  const onTarget = target && target.source.documentId === doc?.id && target.source.page === page;
  const box = onTarget ? target.box : null;
  // Scroll only the page pane (scrollIntoView would move the whole window too).
  const toBox = () => {
    const b = boxRef.current;
    const c = scrollRef.current;
    const w = b?.parentElement;
    if (b && c && w) c.scrollTo({ top: w.offsetTop + b.offsetTop + b.offsetHeight / 2 - c.clientHeight / 2 });
  };
  useEffect(toBox, [box]);

  if (!doc) return <div className="grid h-full place-items-center p-6 text-sm text-muted">No files.</div>;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
        if (e.key === "ArrowRight" || e.key === "PageDown") go(page + 1);
        if (e.key === "ArrowLeft" || e.key === "PageUp") go(page - 1);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <select
          aria-label="File"
          value={doc.id}
          onChange={(e) => (setDocId(e.target.value), setPage(1))}
          className="h-8 max-w-[16rem] truncate rounded-[10px] border border-line-strong bg-surface px-2 text-[13px] focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none"
        >
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {DOC_KIND_LABEL[d.kind]} · {d.filename}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1" role="group" aria-label="Page">
          <Button size="sm" variant="ghost" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">
            ‹
          </Button>
          <label className="flex items-center gap-1 text-[13px]">
            <span className="sr-only">Page number</span>
            <input
              type="number"
              min={1}
              max={pages}
              value={page}
              onChange={(e) => go(Number(e.target.value) || 1)}
              className="num h-7 w-12 rounded-md border border-line-strong bg-surface text-center focus:border-brand focus:ring-4 focus:ring-brand/20 focus:outline-none"
            />
            <span className="text-muted">of {pages}</span>
          </label>
          <Button size="sm" variant="ghost" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page">
            ›
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Zoom">
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">
            −
          </Button>
          <button type="button" className="num w-12 text-center text-xs text-muted" onClick={() => setZoom(1)} title="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))} aria-label="Zoom in">
            +
          </Button>
        </div>
      </div>

      {target && (
        <div key={target.nonce} aria-live="polite" className={cx("pulse border-b border-line px-3 py-2 text-[13px]", onTarget ? "bg-accent-soft" : "bg-sunken text-muted")}>
          <span className="font-medium">{target.label}</span>
          {target.source.location && <span className="text-muted"> · {target.source.location}</span>}
          {target.source.quote && <span className="mt-0.5 block italic">“{target.source.quote}”</span>}
          {onTarget && box === null && <span className="text-muted"> · somewhere on this page</span>}
          {!onTarget && (
            <button type="button" className="ml-2 text-accent underline" onClick={() => (setDocId(target.source.documentId), setPage(target.source.page))}>
              Back to page {target.source.page}
            </button>
          )}
        </div>
      )}

      <div ref={scrollRef} tabIndex={0} aria-label={`${doc.filename}, page ${page} of ${pages}`} className="relative min-h-0 flex-1 overflow-auto bg-sunken p-4">
        {src.data && failed !== src.data ? (
          <div className="relative mx-auto" style={{ width: `${zoom * 100}%` }}>
            {/* Page images are dynamic API/data URLs; next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src.data} alt={`${doc.filename}, page ${page}`} onLoad={toBox} onError={() => setFailed(src.data)} className="block w-full rounded-md bg-surface shadow-card" />
            {box && (
              <div
                ref={boxRef}
                aria-hidden
                className="pulse pointer-events-none absolute rounded-sm bg-highlight ring-2 ring-focus"
                style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }}
              />
            )}
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted">{failed ? "This page image isn't available." : "Loading page…"}</div>
        )}
      </div>
    </div>
  );
}
