"use client";

import type { DocumentDto, SourceRef } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { DOC_KIND_LABEL } from "@/lib/format";
import { Button, cx } from "./ui";

export type ViewerTarget = { source: SourceRef; label: string; nonce: number };

/**
 * Contract page viewer. `target` jumps to a page and shows what to look for.
 * SourceRef has no coordinates yet, so the "highlight" is a callout with the location/quote.
 */
export function PageViewer({ documents, target }: { documents: DocumentDto[]; target: ViewerTarget | null }) {
  const [docId, setDocId] = useState(documents[0]?.id ?? "");
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);

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

  if (!doc) return <div className="grid h-full place-items-center p-6 text-sm text-muted">No documents.</div>;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (e.key === "ArrowRight" || e.key === "PageDown") go(page + 1);
        if (e.key === "ArrowLeft" || e.key === "PageUp") go(page - 1);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <select
          aria-label="Document"
          value={doc.id}
          onChange={(e) => (setDocId(e.target.value), setPage(1))}
          className="h-8 max-w-[16rem] truncate rounded-md border border-line-strong bg-surface px-2 text-sm"
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
          <label className="flex items-center gap-1 text-sm">
            <span className="sr-only">Page number</span>
            <input
              type="number"
              min={1}
              max={pages}
              value={page}
              onChange={(e) => go(Number(e.target.value) || 1)}
              className="num h-7 w-12 rounded border border-line-strong bg-surface text-center text-sm"
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
        <div
          key={target.nonce}
          aria-live="polite"
          className={cx("pulse border-b px-3 py-2 text-sm", onTarget ? "border-line bg-highlight/60" : "border-line bg-sunken text-muted")}
        >
          <span className="font-medium">{target.label}</span>
          {target.source.location && <span className="text-muted"> · {target.source.location}</span>}
          {target.source.quote && <span className="mt-0.5 block italic">“{target.source.quote}”</span>}
          {!onTarget && (
            <button type="button" className="ml-2 text-accent underline" onClick={() => (setDocId(target.source.documentId), setPage(target.source.page))}>
              Back to p.{target.source.page}
            </button>
          )}
        </div>
      )}

      <div tabIndex={0} aria-label={`${doc.filename}, page ${page} of ${pages}`} className="min-h-0 flex-1 overflow-auto bg-sunken p-4">
        {src.data && failed !== src.data ? (
          // Page images are dynamic API/data URLs; next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src.data}
            alt={`${doc.filename}, page ${page}`}
            onError={() => setFailed(src.data)}
            style={{ width: `${zoom * 100}%` }}
            className={cx("mx-auto block max-w-none rounded bg-surface shadow-md", onTarget && "ring-4 ring-highlight")}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted">{failed ? "This page image isn't available." : "Loading page…"}</div>
        )}
      </div>
    </div>
  );
}
