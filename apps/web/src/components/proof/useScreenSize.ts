"use client";

import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** Below this window width the item rail becomes a sheet, so the contract page keeps the whole width. */
export const NARROW_BELOW = 1100;

const subscribe = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};

/** True while the window is narrower than `below`. The server and the first client render say false, so they agree. */
export const useIsNarrow = (below = NARROW_BELOW) =>
  useSyncExternalStore(
    subscribe,
    () => window.innerWidth < below,
    () => false,
  );

const MIN_HEIGHT = 480;

/**
 * The height that makes the element end at the bottom of the window, so the screen never scrolls as a page. It is measured
 * rather than calculated because what sits above it (the version header) is not this screen's to know; null until measured,
 * when the CSS fallback on the element applies.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, bottomGap = 8): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      setHeight(Math.max(MIN_HEIGHT, Math.round(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - bottomGap)));
    };
    measure();
    window.addEventListener("resize", measure);
    // What is above can change height after load (the header's title loads late).
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [ref, bottomGap]);
  return height;
}
