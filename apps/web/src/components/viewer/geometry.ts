import type { Region } from "@dct/shared";

/**
 * The viewer's arithmetic, kept free of the DOM so it can be tested without layout (jsdom has none).
 *
 * Zoom is relative to "fit width": at 1 the page is as wide as the viewport minus a gutter. Positions on the page are
 * fractions (0–1, origin top-left), so highlights and crops stay exact at any zoom.
 */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 6;
/** Above this zoom a whole-page picture would be too big to be sharp, so only the visible area is fetched. */
export const WHOLE_PAGE_MAX_ZOOM = 2;
export const PASSAGE_MIN_ZOOM = 1;
export const PASSAGE_MAX_ZOOM = 3;
/** A line of text (the focus box's height) should read about this tall, in CSS pixels. */
export const PASSAGE_LINE_PX = 16;
/** The whole focus box must fit within this share of the viewport's width and height. */
export const PASSAGE_FIT_SHARE = 0.85;
export const MAX_DPI = 300;
/** A quick look first; also what tells us the page's physical width. */
export const PREVIEW_DPI = 60;
export const GUTTER = 16;
/** Letter, until the first picture says otherwise. */
export const DEFAULT_ASPECT = 11 / 8.5;

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM);

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5, 6];

/** One zoom button press: the next round percentage up or down (from a pinch's odd value too), so presses always land on 100% again. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir === 1 ? ZOOM_STEPS.find((s) => s > z + 1e-6) : [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6);
  return clampZoom(next ?? z);
}

export const baseWidth = (vw: number) => Math.max(1, vw - 2 * GUTTER);

export interface Layout {
  pageW: number;
  pageH: number;
  /** The page's top-left inside the scrollable content. */
  left: number;
  top: number;
  contentW: number;
  contentH: number;
}

/** `aspect` is page height ÷ width. A page smaller than the viewport is centred; a bigger one scrolls. */
export function layoutOf(vw: number, vh: number, zoom: number, aspect: number): Layout {
  const pageW = baseWidth(vw) * zoom;
  const pageH = pageW * aspect;
  const contentW = Math.max(vw, pageW + 2 * GUTTER);
  const contentH = Math.max(vh, pageH + 2 * GUTTER);
  return { pageW, pageH, left: (contentW - pageW) / 2, top: (contentH - pageH) / 2, contentW, contentH };
}

export function clampScroll(left: number, top: number, l: Layout, vw: number, vh: number) {
  return { left: clamp(left, 0, Math.max(0, l.contentW - vw)), top: clamp(top, 0, Math.max(0, l.contentH - vh)) };
}

/** The page fraction under a point of the viewport (px, py measured from its top-left). */
export function pageFractionAt(l: Layout, scrollLeft: number, scrollTop: number, px: number, py: number) {
  return { fx: (scrollLeft + px - l.left) / l.pageW, fy: (scrollTop + py - l.top) / l.pageH };
}

/** The scroll position that puts page fraction (fx, fy) under viewport point (px, py): how zoom stays around the pointer. */
export function scrollForAnchor(l: Layout, vw: number, vh: number, a: { fx: number; fy: number; px: number; py: number }) {
  return clampScroll(l.left + a.fx * l.pageW - a.px, l.top + a.fy * l.pageH - a.py, l, vw, vh);
}

/** Where in the viewport a passage's centre is put: right of centre and a little high, so what sits to its left (a table's row label) and above it stays in view. */
export const passageAnchor = (vw: number, vh: number) => ({ px: vw * 0.62, py: vh * 0.45 });

export const centreOf = (b: Region) => ({ fx: (b[0] + b[2]) / 2, fy: (b[1] + b[3]) / 2 });

/**
 * The zoom that makes the focus box's height (a line of text) about 16 px, limited so the whole box fits within 85% of the
 * viewport, within 1–3. A single table cell then lands near 1.5–2x with its row label and column headers still on screen,
 * and a paragraph-sized box is limited by fitting in the viewport.
 */
export function zoomToBox(box: Region, vw: number, vh: number, aspect: number): number {
  const bw = Math.max(box[2] - box[0], 0.005);
  const bh = Math.max(box[3] - box[1], 0.002);
  const base = baseWidth(vw);
  const byLine = PASSAGE_LINE_PX / (bh * base * aspect);
  const fitW = (PASSAGE_FIT_SHARE * vw) / (bw * base);
  const fitH = (PASSAGE_FIT_SHARE * vh) / (bh * base * aspect);
  return clamp(Math.min(byLine, fitW, fitH), PASSAGE_MIN_ZOOM, PASSAGE_MAX_ZOOM);
}

/** Zoom at which the whole page height is visible (never above fit-width). */
export const fitPageZoom = (vw: number, vh: number, aspect: number) => clampZoom(Math.min(1, (vh - 2 * GUTTER) / (baseWidth(vw) * aspect)));

/** Smallest region the server accepts is 1% a side. */
const MIN_SIDE = 0.01;

function minSide(lo: number, hi: number): [number, number] {
  if (hi - lo >= MIN_SIDE) return [lo, hi];
  const c = clamp((lo + hi) / 2, MIN_SIDE / 2, 1 - MIN_SIDE / 2);
  return [c - MIN_SIDE / 2, c + MIN_SIDE / 2];
}

/**
 * The part of the page showing in the viewport, grown by `margin` (a share of the viewport on every side, so a small pan
 * needs no new request), clamped to the page.
 */
export function visibleRegion(l: Layout, scrollLeft: number, scrollTop: number, vw: number, vh: number, margin = 0.25): Region {
  const mx = vw * margin;
  const my = vh * margin;
  const [x0, x1] = minSide(clamp((scrollLeft - mx - l.left) / l.pageW, 0, 1), clamp((scrollLeft + vw + mx - l.left) / l.pageW, 0, 1));
  const [y0, y1] = minSide(clamp((scrollTop - my - l.top) / l.pageH, 0, 1), clamp((scrollTop + vh + my - l.top) / l.pageH, 0, 1));
  return [x0, y0, x1, y1];
}

export const regionCovers = (outer: Region, inner: Region) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

/**
 * Pixels per page inch needed to show the page at this zoom without blur: the pixels the screen will give the page's width
 * (CSS pixels × device pixel ratio) over the page's physical width. Rounded up to a multiple of 25 so small zoom changes
 * reuse a picture already loaded; never above 300 (the server's limit).
 */
export function neededDpi({ zoom, viewportWidth, dpr, pageWidthIn }: { zoom: number; viewportWidth: number; dpr: number; pageWidthIn: number }): number {
  const px = baseWidth(viewportWidth) * zoom * Math.max(1, dpr);
  return clamp(Math.ceil(px / Math.max(pageWidthIn, 1) / 25) * 25, 50, MAX_DPI);
}

/**
 * The server may ignore `region` (older API): what came back is then a whole page. Told by its shape: the picture's aspect
 * matches the page's, not the region's, which differ unless the region happens to be shaped like the page (that case can't be
 * told this way, and is the one a stale server would get wrong).
 */
export function looksLikeWholePage(region: Region, picture: { width: number; height: number }, pageAspect: number): boolean {
  if (picture.width <= 0 || picture.height <= 0) return false;
  const got = picture.height / picture.width;
  const asked = ((region[3] - region[1]) * pageAspect) / (region[2] - region[0]);
  const rel = (a: number, b: number) => Math.abs(a - b) / b;
  return rel(got, pageAspect) < 0.03 && rel(asked, pageAspect) > 0.06;
}
