"use client";

import type { Region } from "@dct/shared";
import { useState } from "react";
import { PageView, type Box } from "@/components/PageView";
import { pageImage } from "@/lib/queries";

const pct = (n: number) => `${n * 100}%`;

/**
 * The page cut down to the spot a question is about, with the spot highlighted. Positions are fractions of the page, so the
 * crop is the page image scaled up and slid into a clipped frame (no image processing on the server). With no crop it falls
 * back to the whole page.
 */
export function PageCrop({ documentId, page, crop, boxes, alt }: { documentId: string; page: number; crop: Region | null; boxes: Box[]; alt: string }) {
  // Pages differ in shape (Letter, A4); until the image loads, assume Letter so the frame doesn't jump much.
  const [ratio, setRatio] = useState(11 / 8.5);
  const [failed, setFailed] = useState(false);

  if (!crop)
    return (
      <div data-page-scroller className="max-h-[70vh] overflow-auto rounded-tile">
        <PageView documentId={documentId} page={page} boxes={boxes} focus={boxes[0]?.box} alt={alt} />
      </div>
    );

  const [x0, y0, x1, y1] = crop;
  const w = x1 - x0;
  const h = y1 - y0;
  return (
    <div className="relative overflow-hidden rounded-tile bg-sunken shadow-card ring-1 ring-ink/[0.06]" style={{ aspectRatio: `${w} / ${h * ratio}` }}>
      {failed ? (
        <p role="alert" className="grid h-full place-items-center px-6 py-10 text-center text-body text-muted">
          This page couldn&apos;t be shown. Reload to try again.
        </p>
      ) : (
        <div className="absolute" style={{ width: pct(1 / w), left: pct(-x0 / w), top: pct(-y0 / h) }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a contract page rendered by our own API, sized by the PDF */}
          <img
            src={pageImage(documentId, page)}
            alt={alt}
            className="block h-auto w-full select-none"
            draggable={false}
            onLoad={(e) => e.currentTarget.naturalWidth > 0 && setRatio(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth)}
            onError={() => setFailed(true)}
          />
          {boxes.map((b, i) => {
            const [a, b0, c, d] = b.box;
            return <span key={i} role="img" title={b.label} aria-label={b.label} className="absolute rounded-[3px] bg-highlight ring-1 ring-highlight-strong" style={{ left: pct(a), top: pct(b0), width: pct(c - a), height: pct(d - b0) }} />;
          })}
        </div>
      )}
    </div>
  );
}
