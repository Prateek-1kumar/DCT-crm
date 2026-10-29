"use client";

import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { formatValue } from "@/lib/format";
import type { ProofUnit } from "@/lib/proofread";
import { PageMissing, spotQuery } from "./SpotView";
import { cx } from "./ui";

const LETTER = 11 / 8.5;
/** Print is scaled up until it's about this tall (px), up to 4× the fit-to-width size; wider rows scroll sideways. */
const READABLE_PX = 15;
/** Narrowest gap between two of our numbers (px), so a value like "$1,184.80" never runs into its neighbour. */
const COLUMN_PX = 84;

/**
 * The PDF's row and our values for it, lined up: each of our numbers sits right under the number the PDF prints.
 * Both strips are in one scroll area, so they stay lined up when a wide budget row scrolls sideways.
 * While `selecting`, our numbers are buttons to mark the ones that look wrong.
 */
export function RowCompare({ unit, selecting, selected, onToggle }: { unit: ProofUnit; selecting: boolean; selected: Set<string>; onToggle: (path: string) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(LETTER);
  const src = useQuery(spotQuery(unit.doc, unit.page));
  const [failed, setFailed] = useState<string | null>(null);
  const broken = !!src.error || (!!src.data && failed === src.data);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const boxes = unit.cells.flatMap((c) => (c.box ? [c.box] : []));
  const x0 = 0.04;
  const x1 = Math.min(0.98, Math.max(...boxes.map((b) => b[0] + b[2])) + 0.02);
  const textH = boxes.reduce((n, b) => n + b[3], 0) / Math.max(1, boxes.length);
  // Just the row: a little air above and below, never the neighbouring rows.
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - textH * 0.15);
  const y1 = Math.min(1, Math.max(...boxes.map((b) => b[1] + b[3])) + textH * 0.15);
  const fit = width / (x1 - x0);
  const rights = boxes.map((b) => b[0] + b[2]).sort((a, b) => a - b);
  const gap = rights.slice(1).reduce((m, r, i) => Math.min(m, r - rights[i]!), Infinity);
  const imgW = Math.max(fit, Math.min(READABLE_PX / (textH * 0.7 * ratio), fit * 4), Number.isFinite(gap) && gap > 0 ? COLUMN_PX / gap : 0);
  const imgH = imgW * ratio;
  const contentW = (x1 - x0) * imgW;
  const stripH = (y1 - y0) * imgH;
  const rightOf = (b: [number, number, number, number]) => contentW - (b[0] + b[2] - x0) * imgW;

  return (
    <div className="flex shrink-0 flex-col overflow-hidden rounded-card bg-surface ring-1 ring-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-small text-muted">
        <span>
          <span className="font-medium text-ink-2">{unit.title}</span>
          <span className="num"> · page {unit.page}</span>
        </span>
        {contentW > width + 4 && <span className="text-faint">Scroll sideways to see the whole row →</span>}
      </div>
      <div ref={frame} className="overflow-x-auto bg-sunken/50 pb-2">
        {(src.data || broken) && width > 0 && boxes.length > 0 ? (
          <div style={{ width: contentW }} className="flex flex-col gap-0">
            <p className="sticky left-0 w-max px-4 pt-4 pb-2 eyebrow">In the PDF</p>
            {broken ? (
              <div className="sticky left-0" style={{ width }}>
                <PageMissing />
              </div>
            ) : (
              <div className="relative overflow-hidden bg-surface shadow-[inset_0_0_0_1px_var(--color-line)]" style={{ height: stripH }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a page image at a computed size */}
                <img
                  src={src.data}
                  alt={`Page ${unit.page}, ${unit.title}`}
                  draggable={false}
                  className="absolute top-0 left-0 max-w-none select-none"
                  style={{ width: imgW, height: imgH, transform: `translate(${-x0 * imgW}px, ${-y0 * imgH}px)` }}
                  onLoad={(e) => setRatio(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth || LETTER)}
                  onError={() => setFailed(src.data)}
                />
              </div>
            )}
            <p className="sticky left-0 w-max px-4 pt-4 pb-1 eyebrow">Ours</p>
            <div className="relative h-16">
              {unit.cells.map((c) => {
                if (!c.box) return null;
                const bad = selected.has(c.path);
                const body = (
                  <>
                    <span className="block text-caption text-faint">{c.label}</span>
                    <span className="num block text-body font-semibold text-ink">{formatValue(c.path, c.value)}</span>
                  </>
                );
                return selecting ? (
                  <button
                    key={c.path}
                    type="button"
                    aria-pressed={bad}
                    onClick={() => onToggle(c.path)}
                    className={cx(
                      "absolute top-1 rounded-[8px] px-1.5 py-0.5 text-right ring-1 transition-colors",
                      bad ? "bg-danger-soft ring-2 ring-danger" : "bg-surface ring-line-strong hover:ring-danger/50",
                    )}
                    style={{ right: Math.max(0, rightOf(c.box) - 6) }}
                  >
                    {body}
                  </button>
                ) : (
                  <span key={c.path} className="absolute top-1 py-0.5 text-right" style={{ right: Math.max(0, rightOf(c.box)) }}>
                    {body}
                  </span>
                );
              })}
            </div>
          </div>
        ) : (
          <div aria-hidden className="m-6 h-24 animate-pulse rounded-tile bg-ink/[0.04]" />
        )}
      </div>
    </div>
  );
}
