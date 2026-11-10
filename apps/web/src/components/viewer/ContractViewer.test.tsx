import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approxLabel, ContractViewer, type ViewerBox } from "./ContractViewer";

// jsdom has no layout: give every element a 1000 × 700 viewport, and a Letter page at 60 dpi (510 × 660) for the first picture.
const sizes = { w: 1000, h: 700 };
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => sizes.w });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => sizes.h });
  // The person "prefers reduced motion": jumps, so tests needn't run animation frames.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const loadImg = (img: Element, width: number, height: number) => {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
};
const layer = (name: string) => document.querySelector<HTMLImageElement>(`img[data-layer="${name}"]`);
const preview = () => screen.getByRole("img", { name: /contract, page/i }) as HTMLImageElement;
const params = (img: HTMLImageElement) => new URL(img.src, "http://x").searchParams;
const zoomText = () => screen.getByLabelText("Zoom level").textContent;

function setup(over: Partial<Parameters<typeof ContractViewer>[0]> = {}) {
  const onPageChange = vi.fn();
  const props = { documentId: "d1", page: 3, pageCount: 5, onPageChange, boxes: [] as ViewerBox[], focus: null, ariaLabel: "Contract", ...over };
  const view = render(<ContractViewer {...props} />);
  return { onPageChange, props, rerender: (o: Partial<typeof props> = {}) => view.rerender(<ContractViewer {...props} {...o} />) };
}
const loadPreview = () => loadImg(preview(), 510, 660);

describe("loading", () => {
  it("shows a skeleton and a quick low-sharpness picture first, never a blank", () => {
    setup();
    expect(screen.getByTestId("page-skeleton")).toBeTruthy();
    const p = params(preview());
    expect(preview().src).toContain("/api/v1/documents/d1/pages/3/image");
    expect(p.get("dpi")).toBe("60");
    expect(p.get("region")).toBeNull();
    loadPreview();
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
  });

  it("then asks for the whole page at the sharpness the screen can use, and swaps it in only once it has loaded", async () => {
    setup();
    loadPreview();
    await waitFor(() => expect(layer("whole-loading")).toBeTruthy());
    // 968 css px across 8.5 in = 114 dpi, rounded up
    expect(params(layer("whole-loading")!).get("dpi")).toBe("125");
    expect(layer("whole")).toBeNull();
    loadImg(layer("whole-loading")!, 1063, 1375);
    expect(layer("whole")).toBeTruthy();
    expect(layer("whole-loading")).toBeNull();
  });

  it("says plainly when the page didn't load, and tries again", () => {
    setup();
    fireEvent.error(preview());
    expect(screen.getByRole("alert").textContent).toContain("This page didn't load. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(preview()).toBeTruthy();
  });

  it("says so when there is no picture", () => {
    setup({ pageCount: 0 });
    expect(screen.getByRole("status").textContent).toContain("no picture");
  });
});

describe("zoom and sharpness", () => {
  it("zoom buttons change the percentage, within 50%–600%", () => {
    setup();
    loadPreview();
    expect(zoomText()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomText()).toBe("125%");
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomText()).toBe("50%");
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(zoomText()).toBe("100%");
  });

  it("Ctrl + wheel zooms and the page is not zoomed by the browser", () => {
    setup();
    loadPreview();
    const ev = new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("region").dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(Number(zoomText()!.replace("%", ""))).toBeGreaterThan(100);
  });

  it("above 2x asks for just the visible area as a crop, at a sharp dpi", async () => {
    setup();
    loadPreview();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomText()).toBe("300%");
    await waitFor(() => expect(layer("crop-loading")).toBeTruthy());
    const p = params(layer("crop-loading")!);
    expect(p.get("region")).toMatch(/^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/);
    const [x0, y0, x1, y1] = p.get("region")!.split(",").map(Number) as [number, number, number, number];
    expect(x1 - x0).toBeLessThan(1);
    expect(Number(p.get("dpi"))).toBeGreaterThan(125);
    // A real crop: shaped like the region, so it is shown
    loadImg(layer("crop-loading")!, Math.round((x1 - x0) * 8.5 * 200), Math.round((y1 - y0) * 11 * 200));
    expect(layer("crop")).toBeTruthy();
  });

  it("copes with a server that ignores `region`: the whole page it sends is used as a page, and no more crops are asked for", async () => {
    setup();
    loadPreview();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(layer("crop-loading")).toBeTruthy());
    // The region asked for is not page-shaped, yet a whole page comes back
    loadImg(layer("crop-loading")!, 850, 1100);
    expect(layer("crop")).toBeNull();
    expect(layer("whole")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(layer("crop-loading")).toBeNull();
  });
});

describe("passage", () => {
  const focus: [number, number, number, number] = [0.4, 0.4, 0.6, 0.41];

  it("opens at fit width by default, and zooms to the passage when it changes", () => {
    const { rerender } = setup({ focus: null });
    loadPreview();
    expect(zoomText()).toBe("100%");
    rerender({ focus });
    // 1% tall → 16 px: 16 / (0.01 × 968 × 1.294)
    expect(zoomText()).toBe("128%");
  });

  it('startIn="passage" opens zoomed to it', () => {
    setup({ focus, startIn: "passage" });
    loadPreview();
    expect(zoomText()).toBe("128%");
  });

  it("Zoom to passage is disabled without a focus and brings the passage back after the person zooms away", () => {
    const first = setup({ focus: null });
    loadPreview();
    expect((screen.getByRole("button", { name: /Zoom to passage/ }) as HTMLButtonElement).disabled).toBe(true);
    first.rerender({ focus });
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(zoomText()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: /Zoom to passage/ }));
    expect(zoomText()).toBe("128%");
  });

  it("does not re-centre when the same passage is passed again as a new array", () => {
    const { rerender } = setup({ focus });
    loadPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const z = zoomText();
    rerender({ focus: [...focus] as typeof focus });
    expect(zoomText()).toBe(z);
  });
});

describe("pages and keys", () => {
  it("shows 'Page N of M' and moves between pages", () => {
    const { onPageChange } = setup();
    expect(screen.getByText("Page 3 of 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
  });

  it("disables previous on the first page and next on the last", () => {
    setup({ page: 1, pageCount: 1 });
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keys: + − 0, [ ] PageUp PageDown, Home End", () => {
    const { onPageChange } = setup();
    loadPreview();
    const region = screen.getByRole("region");
    region.focus();
    fireEvent.keyDown(region, { key: "+" });
    expect(zoomText()).toBe("125%");
    fireEvent.keyDown(region, { key: "-" });
    expect(zoomText()).toBe("100%");
    fireEvent.keyDown(region, { key: "+" });
    fireEvent.keyDown(region, { key: "0" });
    expect(zoomText()).toBe("100%");
    fireEvent.keyDown(region, { key: "]" });
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(region, { key: "[" });
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(region, { key: "PageDown" });
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(region, { key: "PageUp" });
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(region, { key: "Home" });
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(region, { key: "End" });
    expect(onPageChange).toHaveBeenLastCalledWith(5);
  });

  it("arrow keys scroll the page area; typing in a field inside the toolbar is left alone", () => {
    const { onPageChange } = setup({ toolbarExtra: <input aria-label="Search" /> });
    loadPreview();
    const region = screen.getByRole("region");
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    region.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "]" });
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

describe("highlights", () => {
  const boxes: ViewerBox[] = [
    { id: "a", box: [0.1, 0.1, 0.3, 0.15], tone: "captured", label: "$5,000.00 · captured as Startup fee" },
    { id: "b", box: [0.1, 0.5, 0.3, 0.55], tone: "problem", label: "$900.00 · not captured" },
    { id: "f", box: [0.5, 0.5, 0.7, 0.55], tone: "focus", label: "The passage" },
  ];

  it("are focusable buttons named by their label, in page fractions, and report clicks", () => {
    const onBoxClick = vi.fn();
    setup({ boxes, onBoxClick });
    loadPreview();
    const b = screen.getByRole("button", { name: "$900.00 · not captured" });
    expect(b.style.left).toBe("10%");
    expect(b.style.width).toBe("20%");
    fireEvent.click(b);
    expect(onBoxClick).toHaveBeenCalledWith("b");
  });

  it("differ by more than colour: a glyph and a line style per tone, the focus box thickest", () => {
    setup({ boxes, onBoxClick: () => {} });
    const f = screen.getByRole("button", { name: "The passage" });
    const c = screen.getByRole("button", { name: /captured as/ });
    expect(f.className).toContain("border-[3px]");
    expect(c.className).not.toContain("border-[3px]");
    expect(f.textContent).not.toBe(c.textContent);
    expect(screen.getByRole("button", { name: /not captured/ }).textContent).toBe("!");
  });

  it("an approximate box is dashed with a lighter tint, marked ≈, and its label says so in words", () => {
    const loose: ViewerBox[] = [
      { id: "a", box: [0.1, 0.1, 0.5, 0.3], tone: "captured", label: approxLabel("$5,000.00 · captured as Startup fee", true, "$5,000.00"), approx: true },
      { id: "f", box: [0.1, 0.5, 0.9, 0.7], tone: "focus", label: approxLabel("The words quoted in the rulebook", true), approx: true },
      { id: "x", box: [0.1, 0.8, 0.3, 0.85], tone: "captured", label: "$1.00 · captured" },
    ];
    setup({ boxes: loose, onBoxClick: () => {} });
    const a = screen.getByRole("button", { name: "$5,000.00 is somewhere in this area · captured as Startup fee" });
    const f = screen.getByRole("button", { name: "Approximate area · The words quoted in the rulebook" });
    const exact = screen.getByRole("button", { name: "$1.00 · captured" });
    expect(a.className).toContain("border-dashed");
    expect(a.className).toContain("border-ok"); // keeps its tone's colour
    expect(f.className).toContain("border-dashed");
    expect(f.className).toContain("border-highlight-strong");
    expect(a.textContent).toBe("≈✓"); // the tone glyph stays, so tones differ without colour
    expect(a.dataset.approx).toBe("");
    // the exact one of the same tone is unchanged
    expect(exact.className).toContain("border-solid");
    expect(exact.textContent).toBe("✓");
    expect(exact.dataset.approx).toBeUndefined();
  });

  it("approxLabel leaves an exact label alone and words an approximate one plainly", () => {
    expect(approxLabel("$5,000.00 · captured as Startup fee", undefined, "$5,000.00")).toBe("$5,000.00 · captured as Startup fee");
    expect(approxLabel("The passage", false)).toBe("The passage");
    expect(approxLabel("$5,000.00 · not captured", true, "$5,000.00")).toBe("$5,000.00 is somewhere in this area · not captured");
    expect(approxLabel("The passage", true)).toBe("Approximate area · The passage");
  });

  it("are plain labelled marks when nothing listens for clicks", () => {
    setup({ boxes });
    expect(screen.queryByRole("button", { name: "The passage" })).toBeNull();
    expect(screen.getByRole("img", { name: "The passage" })).toBeTruthy();
  });
});

describe("pointer", () => {
  it("dragging the page moves it (pan) and pressing a highlight does not start a drag", () => {
    setup({ boxes: [{ id: "a", box: [0.1, 0.1, 0.3, 0.15], tone: "captured", label: "Box" }], onBoxClick: () => {} });
    loadPreview();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const region = screen.getByRole("region");
    region.scrollLeft = 200;
    fireEvent.pointerDown(region, { pointerId: 1, clientX: 300, clientY: 300, button: 0 });
    fireEvent.pointerMove(region, { pointerId: 1, clientX: 250, clientY: 300 });
    act(() => {});
    expect(region.scrollLeft).toBe(250);
    fireEvent.pointerUp(region, { pointerId: 1 });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Box" }), { pointerId: 2, clientX: 300, clientY: 300, button: 0 });
    fireEvent.pointerMove(region, { pointerId: 2, clientX: 100, clientY: 300 });
    expect(region.scrollLeft).toBe(250);
  });
});
