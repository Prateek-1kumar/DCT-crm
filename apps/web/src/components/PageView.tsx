"use client";

import type { Region } from "@dct/shared";
import { useEffect, useRef, useState } from "react";
import { pageImage } from "@/lib/queries";
import { cx } from "./ui";

/** How a box is drawn: the status colours of the design system, plus the yellow "look here" highlighter. */
export type Mark = "captured" | "decided" | "set_aside" | "missing" | "clause" | "highlight";

const MARK: Record<Mark, string> = {
  captured: "bg-ok/15 ring-ok/70",
  decided: "bg-info/15 ring-info/70",
  set_aside: "bg-ink/10 ring-ink/30",
  missing: "bg-danger/20 ring-danger",
  clause: "bg-brand/10 ring-transparent",
  highlight: "bg-highlight ring-highlight-strong",
};

export interface Box {
  box: Region;
  mark: Mark;
  /** Shown on hover and read by screen readers, e.g. "$5,000.00 · captured as Startup fee". */
  label: string;
  onClick?: () => void;
  selected?: boolean;
}

const pct = (n: number) => `${n * 100}%`;

/**
 * One contract page as an image with boxes drawn over it (positions are fractions of the page, so they scale with it).
 * `focus` scrolls the page into view with that region centred, for "show me where this came from".
 */
export function PageView({ documentId, page, boxes = [], focus, dpi, className, alt }: { documentId: string; page: number; boxes?: Box[]; focus?: Region; dpi?: number; className?: string; alt: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!focus || !loaded || !frame.current) return;
    const el = frame.current;
    const top = el.offsetTop + el.offsetHeight * ((focus[1] + focus[3]) / 2);
    const scroller = el.closest<HTMLElement>("[data-page-scroller]");
    if (scroller) scroller.scrollTo({ top: top - scroller.clientHeight / 2, behavior: "smooth" });
    else el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, loaded]);

  return (
    <div ref={frame} className={cx("relative overflow-hidden rounded-tile bg-surface shadow-card ring-1 ring-ink/[0.06]", className)}>
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
          const cls = cx("absolute rounded-[3px] ring-1 transition-shadow", MARK[b.mark], b.selected && "ring-2 ring-offset-1 ring-offset-surface", b.onClick && "cursor-pointer hover:ring-2");
          return b.onClick ? (
            <button key={i} type="button" title={b.label} aria-label={b.label} aria-pressed={b.selected} onClick={b.onClick} style={style} className={cls} />
          ) : (
            <span key={i} title={b.label} aria-label={b.label} role="img" style={style} className={cls} />
          );
        })}
    </div>
  );
}
