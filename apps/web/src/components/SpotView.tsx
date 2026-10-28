"use client";

import type { DocumentDto, PageBox } from "@dct/shared";
import { useQuery } from "@tanstack/react-query";
import { Expand, Minus, Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { DOC_KIND_LABEL } from "@/lib/format";
import { PageViewer } from "./PageViewer";
import { Button, cx, Dialog } from "./ui";

/** Page images for close-ups are rendered sharper than the default 150 DPI: budget print can be ~3pt. */
export const SPOT_DPI = 300;
/** How much of the page width the close-up shows at each zoom step. */
const SPANS = [1, 0.72, 0.52, 0.38, 0.28, 0.2];
export const DEFAULT_ZOOM = 2;
const LETTER = 11 / 8.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const spotQuery = (documentId: string, page: number) => ({
  queryKey: ["page", documentId, page, SPOT_DPI] as const,
  queryFn: () => api.pageSrc(documentId, page, SPOT_DPI),
  staleTime: Infinity,
});

/**
 * Close-up of one spot on a contract page: the spot ringed, its row lightly banded so the eye can follow it to the
 * row's label, and a mini page in the corner showing where it is. Zoom is owned by the caller so it stays put from one
 * question to the next (moving along a row just pans).
 */
export function SpotView({ documents, spot, zoom, onZoom }: { documents: DocumentDto[]; spot: PageBox; zoom: number; onZoom: (z: number) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState(LETTER);
  const [whole, setWhole] = useState(false);
  const doc = documents.find((d) => d.id === spot.documentId);
  const src = useQuery(spotQuery(spot.documentId, spot.page));

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const box = spot.box;
  // Never narrower than the spot itself (plus a margin), so a wide spot is never cut off.
  const span = box ? Math.max(SPANS[clamp(zoom, 0, SPANS.length - 1)]!, Math.min(1, box[2] + 0.08)) : 1;
  const imgW = size.w / span;
  const imgH = imgW * ratio;
  const [bx, by, bw, bh] = box ?? [0, 0, 0, 0];
  const viewH = imgH ? size.h / imgH : 1; // fraction of the page height in view
  const left = span >= 1 ? 0 : clamp(bx + bw / 2 - span / 2, 0, 1 - span);
  const top = viewH >= 1 ? 0 : clamp(by + bh / 2 - viewH / 2, 0, 1 - viewH);
  const dx = -left * imgW;
  const dy = viewH >= 1 ? (size.h - imgH) / 2 : -top * imgH;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-card bg-surface ring-1 ring-line">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-small text-muted">
          <span className="font-medium text-ink-2">{doc ? DOC_KIND_LABEL[doc.kind] : "Contract"}</span>
          <span className="num">
            {" "}
            · page {spot.page}
            {doc ? ` of ${doc.pageCount}` : ""}
          </span>
          {!box && " · look anywhere on this page"}
        </p>
        {box && (
          <span className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Zoom out" disabled={zoom <= 0} onClick={() => onZoom(zoom - 1)}>
              <Minus className="size-4" strokeWidth={2} />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Zoom in" disabled={zoom >= SPANS.length - 1} onClick={() => onZoom(zoom + 1)}>
              <Plus className="size-4" strokeWidth={2} />
            </Button>
          </span>
        )}
        <Button size="sm" variant="ghost" aria-label="Whole page" onClick={() => setWhole(true)}>
          <Expand className="size-4" strokeWidth={1.75} /> <span className="hidden sm:inline">Whole page</span>
        </Button>
      </div>

      <div ref={frame} className={cx("relative min-h-0 flex-1 bg-sunken", box ? "overflow-hidden" : "overflow-auto")}>
        {src.data &&
          (box ? (
            <div
              className="absolute top-0 left-0 bg-surface transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ width: imgW, height: imgH, transform: `translate(${dx}px, ${dy}px)` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a page image at a computed size, not a layout image */}
              <img src={src.data} alt={`Page ${spot.page}`} draggable={false} className="absolute inset-0 size-full select-none" onLoad={(e) => setRatio(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth || LETTER)} />
              <span aria-hidden className="absolute inset-x-0 bg-brand/[0.08]" style={{ top: by * imgH - 4, height: bh * imgH + 8 }} />
              <span
                aria-hidden
                className="absolute rounded-md bg-highlight/40 ring-2 ring-highlight-strong shadow-[0_0_0_6px_rgb(245_196_81/0.18)]"
                style={{ left: bx * imgW - 6, top: by * imgH - 4, width: bw * imgW + 12, height: bh * imgH + 8 }}
              />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src.data} alt={`Page ${spot.page}`} className="w-full bg-surface" />
          ))}
        {!src.data && <div aria-hidden className="absolute inset-6 animate-pulse rounded-tile bg-ink/[0.04]" />}

        {box && src.data && (
          <button
            type="button"
            onClick={() => setWhole(true)}
            aria-label="Open the whole page"
            className="absolute right-3 bottom-3 hidden w-[92px] overflow-hidden rounded-[10px] bg-surface shadow-raised ring-1 ring-ink/10 transition hover:ring-brand sm:block"
            style={{ aspectRatio: `1 / ${ratio}` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src.data} alt="" className="size-full opacity-90" />
            <span className="absolute border-2 border-brand bg-brand/10" style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${Math.min(1, span) * 100}%`, height: `${Math.min(1, viewH) * 100}%` }} />
          </button>
        )}
      </div>

      <Dialog open={whole} onClose={() => setWhole(false)} title={`${doc ? DOC_KIND_LABEL[doc.kind] : "Contract"} · page ${spot.page}`} wide>
        <div className="h-[75vh]">
          <PageViewer documents={documents} target={{ source: { documentId: spot.documentId, page: spot.page }, box: spot.box, label: "The spot", nonce: 0 }} />
        </div>
      </Dialog>
    </div>
  );
}
