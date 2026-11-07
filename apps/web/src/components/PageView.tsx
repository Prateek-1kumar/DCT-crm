"use client";

import type { Region } from "@dct/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { pageImage } from "@/lib/queries";
import { cx } from "./ui";

/**
 * How a box is drawn. Each look differs in outline style as well as colour, so it can be told apart without seeing colour:
 * captured is solid, decided by a person double-dotted, set aside dashed, missing thick red. "highlight" is the strong
 * yellow "look here" for the spot being shown.
 */
export type Mark = "captured" | "decided" | "set_aside" | "missing" | "highlight";

export const MARK_LOOK: Record<Mark, string> = {
  captured: "border border-solid border-ok bg-ok/15",
  decided: "border-2 border-dotted border-info bg-info/15",
  set_aside: "border border-dashed border-ink/60 bg-ink/10",
  missing: "border-[3px] border-solid border-danger bg-danger/20",
  highlight: "border-[3px] border-solid border-highlight-strong bg-highlight",
};

export interface Box {
  box: Region;
  mark: Mark;
  /** Shown on hover and read by screen readers, e.g. "$5,000.00 · captured as Startup fee". */
  label: string;
  onClick?: () => void;
  selected?: boolean;
  /** One character in a corner chip, a second cue beside colour and outline. */
  glyph?: string;
}

const pct = (n: number) => `${n * 100}%`;

/**
 * One contract page as an image with boxes drawn over it (positions are fractions of the page, so they scale with it).
 * `focus` scrolls the page into view with that region centred, for "show me where this came from". `zoom` widens the
 * page inside its scroll box (1 = fit the width).
 */
export function PageView({ documentId, page, boxes = [], focus, dpi, className, alt, zoom = 1 }: { documentId: string; page: number; boxes?: Box[]; focus?: Region; dpi?: number; className?: string; alt: string; zoom?: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!focus || !loaded || !frame.current) return;
    const el = frame.current;
    const scroller = el.closest<HTMLElement>("[data-page-scroller]");
    if (scroller) {
      scroller.scrollTo({
        top: el.offsetTop + el.offsetHeight * ((focus[1] + focus[3]) / 2) - scroller.clientHeight / 2,
        left: el.offsetLeft + el.offsetWidth * ((focus[0] + focus[2]) / 2) - scroller.clientWidth / 2,
        behavior: "smooth",
      });
    } else el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [focus, loaded, zoom]);

  // Arrow keys step between the boxes, so a keyboard user needn't Tab through every one.
  const stepBoxes = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-box]")];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (!step || at < 0) return;
    e.preventDefault();
    all[(at + step + all.length) % all.length]?.focus();
  };

  return (
    <div ref={frame} onKeyDown={stepBoxes} style={{ width: `${zoom * 100}%` }} className={cx("relative overflow-hidden rounded-tile bg-surface shadow-card ring-1 ring-ink/[0.06]", className)}>
      {failed ? (
        <p role="alert" className="grid aspect-[8.5/11] place-items-center px-6 text-center text-body text-muted">
          This page couldn&apos;t be shown. Reload to try again.
        </p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a contract page rendered by our own API, sized by the PDF
        <img
          src={pageImage(documentId, page, dpi)}
          alt={alt}
          className={cx("block h-auto w-full select-none transition-opacity", loaded ? "opacity-100" : "opacity-0")}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          draggable={false}
        />
      )}
      {!loaded && !failed && <div aria-hidden className="absolute inset-0 animate-pulse bg-sunken" />}
      {loaded &&
        boxes.map((b, i) => {
          const [x0, y0, x1, y1] = b.box;
          const style = { left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0) };
          const cls = cx("absolute rounded-[3px] transition-shadow", MARK_LOOK[b.mark], b.selected && "ring-2 ring-primary ring-offset-1 ring-offset-surface", b.onClick && "cursor-pointer hover:ring-2 hover:ring-primary");
          const chip = b.glyph && (
            <span aria-hidden className="pointer-events-none absolute -top-2 -right-2 grid size-4 place-items-center rounded-full bg-surface text-[10px] leading-none font-bold text-ink shadow-button ring-1 ring-ink/30">
              {b.glyph}
            </span>
          );
          return b.onClick ? (
            <button key={i} type="button" data-box title={b.label} aria-label={b.label} aria-pressed={b.selected} onClick={b.onClick} style={style} className={cls}>
              {chip}
            </button>
          ) : (
            <span key={i} title={b.label} aria-label={b.label} role="img" style={style} className={cls}>
              {chip}
            </span>
          );
        })}
    </div>
  );
}
