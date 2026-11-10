"use client";

import type { Region } from "@dct/shared";
import { ChevronLeft, ChevronRight, Crosshair, Maximize2, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Button, cx } from "../ui";
import {
  DEFAULT_ASPECT,
  MIN_ZOOM,
  clamp,
  clampZoom,
  centreOf,
  fitPageZoom,
  layoutOf,
  pageFractionAt,
  passageAnchor,
  scrollForAnchor,
  stepZoom,
  zoomToBox,
} from "./geometry";
import { PageLayers } from "./PageLayers";

export type ViewerTone = "focus" | "problem" | "captured" | "decided" | "set_aside" | "doubt";

export interface ViewerBox {
  id: string;
  box: Region;
  tone: ViewerTone;
  /** Read out by screen readers and shown on hover, e.g. "$5,000.00 · captured as Startup fee". */
  label: string;
  /** The box is deliberately larger than the spot and only sure to contain it (a scanned page we couldn't pin down); the label must say so, see `approxLabel`. */
  approx?: boolean;
}

/** What a screen shows, quietly, beside a passage whose highlighted area is approximate. */
export const APPROX_NOTE = "We couldn't pin down the exact spot on this scanned page, so the highlighted area is approximate. What you're looking for is inside it.";

/** The hover and screen-reader words for a box: an approximate one says so, in words, so it never reads as exact. `amount` is the printed text of an amount, which is somewhere inside the area. */
export const approxLabel = (label: string, approx: boolean | undefined, amount?: string) =>
  !approx ? label : amount !== undefined && label.startsWith(amount) ? `${amount} is somewhere in this area${label.slice(amount.length)}` : `Approximate area · ${label}`;

/**
 * How each tone is drawn. They differ in line style and in a corner glyph as well as colour, so they can be told apart without
 * seeing colour: the focus box is the thickest with a tint, problems solid red, doubts dashed amber, captured thin green,
 * decided by a person dotted, set aside dashed grey.
 */
const TONE: Record<ViewerTone, { box: string; approx: string; glyph: string; chip: string }> = {
  focus: { box: "z-20 border-[3px] border-solid border-highlight-strong bg-highlight", approx: "z-20 border-[3px] border-dashed border-highlight-strong bg-highlight/40", glyph: "◆", chip: "bg-highlight-strong text-ink" },
  problem: { box: "z-10 border-2 border-solid border-danger bg-danger/15", approx: "z-10 border-2 border-dashed border-danger bg-danger/[0.06]", glyph: "!", chip: "bg-danger text-on-primary" },
  doubt: { box: "z-10 border-2 border-dashed border-warn bg-warn/15", approx: "z-10 border-2 border-dashed border-warn bg-warn/[0.06]", glyph: "?", chip: "bg-warn text-on-primary" },
  captured: { box: "border border-solid border-ok bg-ok/10", approx: "border-2 border-dashed border-ok bg-ok/[0.04]", glyph: "✓", chip: "bg-ok text-on-primary" },
  decided: { box: "border-2 border-dotted border-info bg-info/10", approx: "border-2 border-dashed border-info bg-info/[0.04]", glyph: "●", chip: "bg-info text-on-primary" },
  set_aside: { box: "border border-dashed border-ink/60 bg-ink/5", approx: "border-2 border-dashed border-ink/60 bg-ink/[0.02]", glyph: "–", chip: "bg-ink/60 text-on-primary" },
};
/** An approximate box is dashed with a lighter tint, whatever its tone, and its corner marker gains "≈" before the tone's own glyph: the tones must still be told apart without colour. */
const APPROX_GLYPH = "≈";

const pct = (n: number) => `${n * 100}%`;
const ANIMATION_MS = 280;
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Anchor = { fx: number; fy: number; px: number; py: number };

/**
 * The one place a contract page is read. Fills the height its parent gives it. Zoom is relative to "fit width" (1 = the page
 * is as wide as the viewport) from 50% to 600%; the sharpness follows the zoom (see PageLayers), and highlights are drawn in
 * page fractions above the picture, so they stay exact at every zoom.
 *
 * `focus` is the passage to bring into view: when it changes the viewer centres and zooms to it. `startIn="passage"` opens
 * that way; the default opens at fit width with the passage centred.
 */
export function ContractViewer({
  documentId,
  page,
  pageCount,
  onPageChange,
  boxes,
  focus,
  startIn = "page",
  onBoxClick,
  toolbarExtra,
  ariaLabel,
  className,
}: {
  documentId: string;
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  boxes: ViewerBox[];
  focus: Region | null;
  startIn?: "page" | "passage";
  onBoxClick?: (id: string) => void;
  toolbarExtra?: ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  /** Which page `aspect` was measured on: positioning waits for it, so a passage is centred on the real page shape. */
  const [measuredFor, setMeasuredFor] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const pageKey = `${documentId}:${page}`;
  const noPicture = !documentId || pageCount < 1 || page < 1 || page > pageCount;
  const failed = failedAt === `${pageKey}:${attempt}`;
  const showScroller = !noPicture && !failed;

  // Handlers read the newest values from here, so they needn't be rebuilt (and re-bound) on every zoom step.
  const zoomRef = useRef(1);
  const view = useRef({ vw: 0, vh: 0, aspect, focus, page, pageCount, approxFocus: false });
  const approxFocus = boxes.some((b) => b.tone === "focus" && b.approx);
  useLayoutEffect(() => {
    view.current = { vw: size.w, vh: size.h, aspect, focus, page, pageCount, approxFocus };
  });
  // Where the page must sit once the next zoom has been drawn: the scroll position can only be set after the page has its new size.
  const pending = useRef<Anchor | null>(null);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showScroller]);

  const layout = layoutOf(size.w, size.h, zoom, aspect);

  useLayoutEffect(() => {
    const a = pending.current;
    const el = scroller.current;
    if (!a || !el) return;
    pending.current = null;
    const s = scrollForAnchor(layoutOf(size.w, size.h, zoom, aspect), size.w, size.h, a);
    el.scrollLeft = s.left;
    el.scrollTop = s.top;
  }, [zoom, size.w, size.h, aspect]);

  /** Where the viewport really is, counting a zoom that is decided but not drawn yet. */
  const logicalScroll = () => {
    const v = view.current;
    const el = scroller.current;
    if (pending.current) return scrollForAnchor(layoutOf(v.vw, v.vh, zoomRef.current, v.aspect), v.vw, v.vh, pending.current);
    return { left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 };
  };

  const applyZoom = useCallback((z: number, anchor: Anchor) => {
    const v = view.current;
    const el = scroller.current;
    if (!el || v.vw <= 0) return;
    if (Math.abs(z - zoomRef.current) < 1e-6 && !pending.current) {
      const s = scrollForAnchor(layoutOf(v.vw, v.vh, z, v.aspect), v.vw, v.vh, anchor);
      el.scrollLeft = s.left;
      el.scrollTop = s.top;
      return;
    }
    zoomRef.current = z;
    pending.current = anchor;
    setZoom(z);
  }, []);

  const stop = () => cancelAnimationFrame(raf.current);

  /** Zoom to `to.zoom` with page fraction (fx, fy) at the centre of the viewport; smoothly unless the person prefers less motion. */
  const go = useCallback(
    (to: { zoom: number; fx: number; fy: number }, animate: boolean, at?: { px: number; py: number }) => {
      stop();
      const v = view.current;
      if (v.vw <= 0) return;
      const centre = at ?? { px: v.vw / 2, py: v.vh / 2 };
      const z1 = clampZoom(to.zoom);
      if (!animate || reducedMotion()) return applyZoom(z1, { fx: to.fx, fy: to.fy, ...centre });
      const z0 = zoomRef.current;
      const s = logicalScroll();
      const from = pageFractionAt(layoutOf(v.vw, v.vh, z0, v.aspect), s.left, s.top, centre.px, centre.py);
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = clamp((now - t0) / ANIMATION_MS, 0, 1);
        const e = 1 - (1 - p) ** 3;
        applyZoom(z0 * (z1 / z0) ** e, { fx: from.fx + (to.fx - from.fx) * e, fy: from.fy + (to.fy - from.fy) * e, ...centre });
        if (p < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [applyZoom],
  );

  const centreNow = () => {
    const v = view.current;
    const s = logicalScroll();
    return pageFractionAt(layoutOf(v.vw, v.vh, zoomRef.current, v.aspect), s.left, s.top, v.vw / 2, v.vh / 2);
  };
  const zoomAround = (z: number, px: number, py: number) => {
    const v = view.current;
    const next = clampZoom(z);
    if (next === zoomRef.current) return;
    const s = logicalScroll();
    const { fx, fy } = pageFractionAt(layoutOf(v.vw, v.vh, zoomRef.current, v.aspect), s.left, s.top, px, py);
    applyZoom(next, { fx, fy, px, py });
  };
  const zoomBy = (dir: 1 | -1) => zoomAround(stepZoom(zoomRef.current, dir), view.current.vw / 2, view.current.vh / 2);
  const fitWidth = () => go({ zoom: 1, ...centreNow(), fx: 0.5 }, true);
  const fitPage = () => go({ zoom: fitPageZoom(view.current.vw, view.current.vh, view.current.aspect), fx: 0.5, fy: 0.5 }, true);
  const toPassage = (animate = true) => {
    const { focus: f, vw, vh, aspect: a, approxFocus: loose } = view.current;
    if (f) go({ zoom: zoomToBox(f, vw, vh, a, loose ? MIN_ZOOM : undefined), ...centreOf(f) }, animate, passageAnchor(vw, vh));
  };

  // Bring the passage into view when it (or the page) changes: once the page's picture has told us its shape and we know the viewport.
  const focusKey = focus ? focus.join(",") : "";
  const handled = useRef<string | null>(null);
  const ready = size.w > 0 && measuredFor === pageKey;
  useEffect(() => {
    if (!ready) return;
    const key = `${pageKey}:${focusKey}`;
    if (handled.current === key) return;
    const first = handled.current === null;
    handled.current = key;
    if (!focus) return go({ zoom: 1, fx: 0.5, fy: 0 }, false);
    if (first && startIn === "page") return go({ zoom: 1, fx: 0.5, fy: centreOf(focus).fy }, false);
    toPassage(!first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value (focusKey), not by the array's identity
  }, [ready, pageKey, focusKey, startIn]);
  useEffect(() => stop, []);

  // Ctrl/⌘ + wheel (also how a trackpad pinch arrives) zooms around the pointer. React's own wheel listener is passive, which can't stop the browser zooming the whole page, hence a native one.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      stop();
      const r = el.getBoundingClientRect();
      zoomAround(zoomRef.current * Math.exp(-clamp(e.deltaY, -40, 40) * 0.01), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAround only reads refs
  }, [showScroller]);

  // Drag to pan; two fingers pinch. Native scroll (wheel, trackpad, scrollbars) works as well.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pinch = useRef<{ dist: number; zoom: number; fx: number; fy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const twoFingers = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
  };
  const rebase = (el: HTMLElement) => {
    const [p] = [...pointers.current.values()];
    drag.current = p ? { x: p.x, y: p.y, left: el.scrollLeft, top: el.scrollTop } : null;
    setGrabbing(!!p);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // A highlight is a button: pressing it is a click, not the start of a drag.
    if ((e.target as HTMLElement).closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
    stop();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const t = twoFingers();
      const r = el.getBoundingClientRect();
      const v = view.current;
      const s = logicalScroll();
      pinch.current = { dist: t.dist, zoom: zoomRef.current, ...pageFractionAt(layoutOf(v.vw, v.vh, zoomRef.current, v.aspect), s.left, s.top, t.mx - r.left, t.my - r.top) };
      drag.current = null;
    } else rebase(el);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = e.currentTarget;
    if (pinch.current && pointers.current.size === 2) {
      const t = twoFingers();
      const r = el.getBoundingClientRect();
      applyZoom(clampZoom(pinch.current.zoom * (t.dist / pinch.current.dist)), { fx: pinch.current.fx, fy: pinch.current.fy, px: t.mx - r.left, py: t.my - r.top });
    } else if (drag.current) {
      el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
      el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
    }
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    pinch.current = null;
    rebase(e.currentTarget);
  };

  const goPage = (p: number) => {
    const next = clamp(p, 1, Math.max(1, pageCount));
    if (next !== page) onPageChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select, [contenteditable='true']")) return;
    const el = scroller.current;
    const nudge = (dx: number, dy: number) => {
      // Arrows scroll only from the page area itself; on a button they keep their usual meaning.
      if (!el || t !== el) return false;
      el.scrollLeft += dx;
      el.scrollTop += dy;
      return true;
    };
    const keys: Record<string, () => boolean> = {
        "+": () => (zoomBy(1), true),
        "=": () => (zoomBy(1), true),
        "-": () => (zoomBy(-1), true),
        _: () => (zoomBy(-1), true),
        "0": () => (fitWidth(), true),
        "[": () => (goPage(page - 1), true),
        PageUp: () => (goPage(page - 1), true),
        "]": () => (goPage(page + 1), true),
        PageDown: () => (goPage(page + 1), true),
        Home: () => (goPage(1), true),
        End: () => (goPage(pageCount), true),
        ArrowLeft: () => nudge(-80, 0),
        ArrowRight: () => nudge(80, 0),
        ArrowUp: () => nudge(0, -80),
        ArrowDown: () => nudge(0, 80),
    };
    const handled = keys[e.key]?.();
    if (handled) {
      e.preventDefault();
      stop();
    }
  };

  const ordered = [...boxes].sort((a, b) => Number(a.tone === "focus") - Number(b.tone === "focus"));

  return (
    <div role="group" aria-label={ariaLabel} onKeyDown={onKeyDown} className={cx("flex h-full min-h-0 flex-col overflow-hidden rounded-tile bg-sunken ring-1 ring-ink/[0.06]", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2">
        <div role="group" aria-label="Pages" className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => goPage(page - 1)}>
            <ChevronLeft aria-hidden className="size-4" />
          </Button>
          <span className="min-w-[88px] text-center text-small font-medium text-ink-2" aria-live="polite">
            {pageCount > 0 ? `Page ${page} of ${pageCount}` : "No pages"}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pageCount} onClick={() => goPage(page + 1)}>
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
        <div role="group" aria-label="Zoom" className="flex flex-wrap items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out" disabled={!showScroller || zoom <= 0.5} onClick={() => zoomBy(-1)}>
            <ZoomOut aria-hidden className="size-4" />
          </Button>
          <span className="min-w-[44px] text-center text-small font-medium tabular-nums text-ink-2" aria-label="Zoom level">
            {Math.round(zoom * 100)}%
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in" disabled={!showScroller || zoom >= 6} onClick={() => zoomBy(1)}>
            <ZoomIn aria-hidden className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" disabled={!showScroller} onClick={fitWidth}>
            <MoveHorizontal aria-hidden className="size-4" />
            Fit width
          </Button>
          <Button size="sm" variant="ghost" disabled={!showScroller} onClick={fitPage}>
            <Maximize2 aria-hidden className="size-4" />
            Fit page
          </Button>
          <Button size="sm" variant="ghost" disabled={!showScroller || !focus} onClick={() => toPassage()}>
            <Crosshair aria-hidden className="size-4" />
            Zoom to passage
          </Button>
        </div>
        {toolbarExtra && <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>}
      </div>

      {noPicture ? (
        <p role="status" className="grid flex-1 place-items-center px-6 text-center text-body text-muted">
          This page has no picture to show.
        </p>
      ) : failed ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-body text-ink-2">This page didn&apos;t load. Try again.</p>
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : (
        <div
          ref={scroller}
          role="region"
          aria-label={`${ariaLabel}, page ${page}. Drag to move, Ctrl or ⌘ with the scroll wheel to zoom.`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          style={{ touchAction: "none" }}
          className={cx("relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus", grabbing ? "cursor-grabbing" : "cursor-grab")}
        >
          {size.w > 0 && (
            <div className="relative" style={{ width: layout.contentW, height: layout.contentH }}>
              <div
                key={`${pageKey}:${attempt}`}
                data-testid="page"
                className="absolute overflow-hidden bg-surface shadow-card"
                style={{ left: layout.left, top: layout.top, width: layout.pageW, height: layout.pageH }}
              >
                <PageLayers
                  documentId={documentId}
                  page={page}
                  alt={`${ariaLabel}, page ${page}`}
                  scroller={scroller}
                  zoom={zoom}
                  layout={layout}
                  viewport={size}
                  aspect={aspect}
                  onAspect={(a) => {
                    setAspect(a);
                    setMeasuredFor(pageKey);
                  }}
                  onFail={() => setFailedAt(`${pageKey}:${attempt}`)}
                />
                {ordered.map((b) => {
                  const t = TONE[b.tone];
                                  const cls = cx("absolute min-h-1.5 min-w-1.5 rounded-[3px] transition-shadow", b.approx ? t.approx : t.box, onBoxClick && "cursor-pointer hover:ring-2 hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary");
                  const style = { left: pct(b.box[0]), top: pct(b.box[1]), width: pct(b.box[2] - b.box[0]), height: pct(b.box[3] - b.box[1]) };
                  // A small marker of constant screen size, just outside the top-right corner so it never covers the text; inside only where the page edge would cut it off.
                  const atEdge = b.box[2] > 0.985 || b.box[1] < 0.015;
                  const chip = (
                    <span aria-hidden className={cx("pointer-events-none absolute grid h-3.5 place-items-center rounded-full text-[9px] leading-none font-bold shadow-button ring-1 ring-surface", b.approx ? "px-1 whitespace-nowrap" : "w-3.5", atEdge ? "top-px right-px" : "bottom-full left-full mb-[3px] ml-[3px]", t.chip)}>
                      {b.approx ? APPROX_GLYPH + t.glyph : t.glyph}
                    </span>
                  );
                  return onBoxClick ? (
                    <button key={b.id} type="button" data-box={b.id} data-tone={b.tone} data-approx={b.approx ? "" : undefined} title={b.label} aria-label={b.label} onClick={() => onBoxClick(b.id)} style={style} className={cls}>
                      {chip}
                    </button>
                  ) : (
                    <span key={b.id} role="img" data-box={b.id} data-tone={b.tone} data-approx={b.approx ? "" : undefined} title={b.label} aria-label={b.label} style={style} className={cls}>
                      {chip}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
