"use client";

import type { Region } from "@dct/shared";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { pageImageAt } from "@/lib/queries";
import { cx } from "../ui";
import { DEFAULT_ASPECT, PREVIEW_DPI, WHOLE_PAGE_MAX_ZOOM, looksLikeWholePage, neededDpi, regionCovers, visibleRegion, type Layout } from "./geometry";

interface Whole {
  url: string;
  dpi: number;
}
interface Crop extends Whole {
  /** What the picture shows, in page fractions. */
  region: Region;
  /** The part that must be covered for it to be enough (the visible area, without the pan margin). */
  need: Region;
}

/**
 * A picture that is shown only once it has loaded: the wanted one sits hidden in the page until its `load` fires, so what the
 * person sees is never blank and never the half-drawn picture. A new request replaces one still loading (the browser
 * abandons the old URL), so there is only ever one in flight per layer.
 */
function useSwap<T extends Whole>(enough: (shown: T, wanted: T) => boolean) {
  const [s, set] = useState<{ shown: T | null; pending: T | null }>({ shown: null, pending: null });
  // Stable functions: the scheduler effect lists them, and must not restart on every render.
  const request = useCallback(
    (w: T) =>
      set((p) => {
        if (p.shown && enough(p.shown, w)) return p.pending ? { ...p, pending: null } : p;
        if (p.pending && p.pending.url === w.url) return p;
        return { ...p, pending: w };
      }),
    [enough],
  );
  const loaded = useCallback((url: string) => set((p) => (p.pending?.url === url ? { shown: p.pending, pending: null } : p)), []);
  const fail = useCallback((url: string) => set((p) => (p.pending?.url === url ? { ...p, pending: null } : p)), []);
  const adopt = useCallback((w: T) => set((p) => ({ shown: p.shown && p.shown.dpi >= w.dpi ? p.shown : w, pending: p.pending })), []);
  const clearPending = useCallback(() => set((p) => (p.pending ? { ...p, pending: null } : p)), []);
  return { ...s, request, loaded, fail, adopt, clearPending };
}

const wholeEnough = (shown: Whole, wanted: Whole) => shown.dpi >= wanted.dpi;
const cropEnough = (shown: Crop, wanted: Crop) => shown.dpi >= wanted.dpi && regionCovers(shown.region, wanted.need);

const pct = (n: number) => `${n * 100}%`;
const regionStyle = (r: Region) => ({ left: pct(r[0]), top: pct(r[1]), width: pct(r[2] - r[0]), height: pct(r[3] - r[1]) });
const PICTURE = "pointer-events-none absolute select-none";
const DEBOUNCE_MS = 150;

/**
 * The pictures of one page, stacked inside the page's box: a quick low-sharpness one first (so there is never a blank), then
 * the sharpness the zoom asks for. Up to 2x the whole page is fetched at the dpi the screen can use; beyond that only the
 * visible area (plus a margin) is, re-fetched as the person pans. Mounted with a key per page, so it starts fresh on each.
 */
export function PageLayers({
  documentId,
  page,
  alt,
  scroller,
  zoom,
  layout,
  viewport,
  aspect,
  onAspect,
  onFail,
}: {
  documentId: string;
  page: number;
  alt: string;
  scroller: RefObject<HTMLElement | null>;
  zoom: number;
  layout: Layout;
  viewport: { w: number; h: number };
  aspect: number;
  onAspect: (aspect: number) => void;
  onFail: () => void;
}) {
  const [widthIn, setWidthIn] = useState<number | null>(null);
  const [cropsWork, setCropsWork] = useState(true);
  const failed = useRef(new Set<string>());
  const whole = useSwap<Whole>(wholeEnough);
  const crop = useSwap<Crop>(cropEnough);

  // The scheduler reads the newest values without being rebuilt on every scroll.
  const latest = useRef({ zoom, layout, viewport, aspect });
  useEffect(() => {
    latest.current = { zoom, layout, viewport, aspect };
  });
  const { request: askWhole, clearPending: dropWhole } = whole;
  const { request: askCrop, clearPending: dropCrop } = crop;
  const idle = !whole.shown && !crop.shown;

  // Debounced: wheel and drag fire many events, and only where the person stops matters. The very first sharp picture is not delayed.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !widthIn) return;
    const run = () => {
      const { zoom: z, layout: l, viewport: v } = latest.current;
      if (v.w <= 0) return;
      const dpi = neededDpi({ zoom: z, viewportWidth: v.w, dpr: window.devicePixelRatio || 1, pageWidthIn: widthIn });
      if (z <= WHOLE_PAGE_MAX_ZOOM || !cropsWork) {
        dropCrop();
        const url = pageImageAt(documentId, page, { dpi });
        if (!failed.current.has(url)) askWhole({ url, dpi });
        return;
      }
      dropWhole();
      const need = visibleRegion(l, el.scrollLeft, el.scrollTop, v.w, v.h, 0);
      const region = visibleRegion(l, el.scrollLeft, el.scrollTop, v.w, v.h);
      const url = pageImageAt(documentId, page, { dpi, region });
      if (!failed.current.has(url)) askCrop({ url, dpi, region, need });
    };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, idle ? 0 : DEBOUNCE_MS);
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("scroll", schedule);
    };
  }, [scroller, widthIn, cropsWork, documentId, page, askWhole, askCrop, dropWhole, dropCrop, zoom, viewport.w, viewport.h, idle]);

  const previewUrl = pageImageAt(documentId, page, { dpi: PREVIEW_DPI });
  const cropShown = crop.shown && zoom > WHOLE_PAGE_MAX_ZOOM && cropsWork;

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a contract page rendered by our own API */}
      <img
        src={previewUrl}
        alt={alt}
        draggable={false}
        className={cx(PICTURE, "inset-0 size-full")}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          if (!w || !h) return;
          setWidthIn(w / PREVIEW_DPI);
          onAspect(h / w);
        }}
        onError={onFail}
      />
      {widthIn === null && <div aria-hidden data-testid="page-skeleton" className="absolute inset-0 animate-pulse bg-sunken" />}
      {whole.shown && (
        // eslint-disable-next-line @next/next/no-img-element -- as above
        <img key={whole.shown.url} src={whole.shown.url} alt="" draggable={false} data-layer="whole" className={cx(PICTURE, "inset-0 size-full")} />
      )}
      {whole.pending && (
        // eslint-disable-next-line @next/next/no-img-element -- as above
        <img key={whole.pending.url} src={whole.pending.url} alt="" draggable={false} data-layer="whole-loading" className={cx(PICTURE, "inset-0 size-full opacity-0")} onLoad={() => whole.loaded(whole.pending!.url)} onError={() => (failed.current.add(whole.pending!.url), whole.fail(whole.pending!.url))} />
      )}
      {cropShown && (
        // eslint-disable-next-line @next/next/no-img-element -- as above
        <img key={crop.shown!.url} src={crop.shown!.url} alt="" draggable={false} data-layer="crop" className={PICTURE} style={regionStyle(crop.shown!.region)} />
      )}
      {crop.pending && (
        // eslint-disable-next-line @next/next/no-img-element -- as above
        <img
          key={crop.pending.url}
          src={crop.pending.url}
          alt=""
          draggable={false}
          data-layer="crop-loading"
          className={cx(PICTURE, "opacity-0")}
          style={regionStyle(crop.pending.region)}
          onLoad={(e) => {
            const p = crop.pending!;
            // A server that ignores `region` sends the whole page: use it as a whole-page picture and stop asking for crops.
            if (looksLikeWholePage(p.region, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }, aspect || DEFAULT_ASPECT)) {
              setCropsWork(false);
              whole.adopt({ url: p.url, dpi: p.dpi });
              crop.fail(p.url);
            } else crop.loaded(p.url);
          }}
          onError={() => (failed.current.add(crop.pending!.url), crop.fail(crop.pending!.url))}
        />
      )}
    </>
  );
}
