import { describe, expect, it } from "vitest";
import { GUTTER, passageAnchor, MAX_ZOOM, MIN_ZOOM, clampScroll, clampZoom, fitPageZoom, layoutOf, looksLikeWholePage, neededDpi, pageFractionAt, regionCovers, scrollForAnchor, stepZoom, visibleRegion, zoomToBox } from "./geometry";

const LETTER = 11 / 8.5;
const VW = 1000;
const VH = 700;

describe("zoom", () => {
  it("is kept within 50%–600%", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, -1)).toBe(1);
    expect(stepZoom(1.37, 1)).toBe(1.5);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it("makes a line of text about 16 px tall, so a cell keeps its row and header context in view", () => {
    const cell: [number, number, number, number] = [0.5, 0.4, 0.62, 0.41]; // 1% tall
    const z = zoomToBox(cell, VW, VH, LETTER);
    expect(0.01 * layoutOf(VW, VH, z, LETTER).pageH).toBeCloseTo(16, 0);
    expect(z).toBeGreaterThan(1.2);
    expect(z).toBeLessThan(2);
  });

  it("is limited so the whole box fits in 85% of the viewport, and kept within 1–3", () => {
    const wide: [number, number, number, number] = [0.05, 0.4, 0.95, 0.41]; // a full-width line: fits only at fit width
    expect(zoomToBox(wide, VW, VH, LETTER)).toBe(1); // fitting would need 0.98, below the floor
    const para: [number, number, number, number] = [0.3, 0.1, 0.5, 0.5];
    const z = zoomToBox(para, VW, VH, LETTER);
    expect(0.4 * layoutOf(VW, VH, z, LETTER).pageH).toBeLessThanOrEqual(VH * 0.85 + 1);
    expect(zoomToBox([0, 0, 1, 1], VW, VH, LETTER)).toBe(1);
    expect(zoomToBox([0.5, 0.5, 0.52, 0.5005], VW, VH, LETTER)).toBe(3);
  });

  it("fits the page height without going past fit-width", () => {
    const z = fitPageZoom(VW, VH, LETTER);
    expect(layoutOf(VW, VH, z, LETTER).pageH).toBeLessThanOrEqual(VH - 2 * GUTTER + 0.001);
    expect(fitPageZoom(VW, 4000, LETTER)).toBe(1);
  });
});

describe("layout and scroll", () => {
  it("centres a page smaller than the viewport and scrolls a bigger one", () => {
    const small = layoutOf(VW, VH, 0.5, LETTER);
    expect(small.left).toBeCloseTo((VW - small.pageW) / 2);
    expect(small.contentW).toBe(VW);
    const big = layoutOf(VW, VH, 3, LETTER);
    expect(big.left).toBe(GUTTER);
    expect(big.contentW).toBe(big.pageW + 2 * GUTTER);
  });

  it("keeps the page point under the pointer fixed while zooming", () => {
    const before = layoutOf(VW, VH, 1, LETTER);
    const at = { px: 300, py: 200 };
    const { fx, fy } = pageFractionAt(before, 0, 150, at.px, at.py);
    const after = layoutOf(VW, VH, 2.5, LETTER);
    const s = scrollForAnchor(after, VW, VH, { fx, fy, ...at });
    const again = pageFractionAt(after, s.left, s.top, at.px, at.py);
    expect(again.fx).toBeCloseTo(fx);
    expect(again.fy).toBeCloseTo(fy);
  });

  it("puts a passage at 62% across and 45% down, and never scrolls past the page's edges", () => {
    const l = layoutOf(VW, VH, 2, LETTER);
    const a = passageAnchor(VW, VH);
    expect(a).toEqual({ px: 620, py: 315 });
    const s = scrollForAnchor(l, VW, VH, { fx: 0.5, fy: 0.5, ...a });
    expect(pageFractionAt(l, s.left, s.top, a.px, a.py).fx).toBeCloseTo(0.5);
    // a passage at the page's left edge can't be pulled to 62%: the scroll stops at 0
    expect(scrollForAnchor(l, VW, VH, { fx: 0.02, fy: 0.02, ...a })).toEqual({ left: 0, top: 0 });
  });

  it("clamps scroll to the content", () => {
    const l = layoutOf(VW, VH, 2, LETTER);
    expect(clampScroll(-50, -50, l, VW, VH)).toEqual({ left: 0, top: 0 });
    const s = clampScroll(1e6, 1e6, l, VW, VH);
    expect(s.left).toBe(l.contentW - VW);
    expect(s.top).toBe(l.contentH - VH);
  });
});

describe("visible region", () => {
  it("is the whole page at fit width with a short page and stays inside 0–1", () => {
    const l = layoutOf(VW, 4000, 1, LETTER);
    const r = visibleRegion(l, 0, 0, VW, 4000);
    expect(r).toEqual([0, 0, 1, 1]);
  });

  it("follows the scroll and adds a margin", () => {
    const l = layoutOf(VW, VH, 4, LETTER);
    const none = visibleRegion(l, 1000, 1500, VW, VH, 0);
    const some = visibleRegion(l, 1000, 1500, VW, VH, 0.25);
    expect(none[0]).toBeCloseTo((1000 - l.left) / l.pageW);
    expect(none[3]).toBeCloseTo((1500 + VH - l.top) / l.pageH);
    expect(some[0]).toBeLessThan(none[0]);
    expect(some[2]).toBeGreaterThan(none[2]);
    expect(regionCovers(some, none)).toBe(true);
    expect(regionCovers(none, some)).toBe(false);
  });

  it("is never thinner than the 1% the server accepts", () => {
    const l = layoutOf(VW, VH, 6, LETTER);
    const r = visibleRegion(l, l.contentW, l.contentH, VW, VH, 0); // scrolled past the end
    expect(r[2] - r[0]).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(r[3] - r[1]).toBeGreaterThanOrEqual(0.01 - 1e-9);
    expect(r[2]).toBeLessThanOrEqual(1);
  });
});

describe("sharpness", () => {
  const base = { viewportWidth: 1032, pageWidthIn: 8.5 };
  it("asks for what the screen can show: width in pixels over the page's inches", () => {
    // 1000 css px × 1 = 1000 px / 8.5 in = 118 dpi, rounded up to 125
    expect(neededDpi({ ...base, zoom: 1, dpr: 1 })).toBe(125);
    expect(neededDpi({ ...base, zoom: 1, dpr: 2 })).toBe(250);
  });
  it("is capped at 300 and floored at 50", () => {
    expect(neededDpi({ ...base, zoom: 6, dpr: 2 })).toBe(300);
    expect(neededDpi({ ...base, zoom: 0.5, dpr: 1 })).toBe(75);
    expect(neededDpi({ viewportWidth: 100, pageWidthIn: 8.5, zoom: 0.5, dpr: 1 })).toBe(50);
  });
});

describe("a crop that came back as a whole page", () => {
  const region: [number, number, number, number] = [0.1, 0.2, 0.9, 0.4]; // wide and short
  it("is told by its shape", () => {
    expect(looksLikeWholePage(region, { width: 850, height: 1100 }, LETTER)).toBe(true);
  });
  it("a real crop is not", () => {
    // 0.8 × 8.5 = 6.8 in wide, 0.2 × 11 = 2.2 in tall
    expect(looksLikeWholePage(region, { width: 680, height: 220 }, LETTER)).toBe(false);
  });
  it("a region shaped like the page can't be told (documented limit), and nothing loaded is not a page", () => {
    expect(looksLikeWholePage([0, 0, 0.5, 0.5], { width: 425, height: 550 }, LETTER)).toBe(false);
    expect(looksLikeWholePage(region, { width: 0, height: 0 }, LETTER)).toBe(false);
  });
});
