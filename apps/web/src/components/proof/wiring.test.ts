import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { coverage, sampleVersion } from "../contract/test-data";
import { claimOf, sourceText } from "./claim";
import { shortcutOf } from "./keys";
import { buildLines } from "./lines";
import { buildProof } from "./model";
import { useIsNarrow } from "./useScreenSize";
import { amountIndex, amountTone, union, viewerBoxes } from "./viewerBoxes";

const data = () => buildProof(sampleVersion(), coverage())!;
const lineOf = (d: ReturnType<typeof data>, key: string) => buildLines(d.version).find((l) => l.key === key)!;

describe("claimOf", () => {
  it("a term: its name, value, quote, page and the details behind the disclosure", () => {
    const d = data();
    const c = claimOf(d, lineOf(d, "term:t1"), null);
    expect(c).toMatchObject({ name: "Startup fee", value: "$5,000.00 · invoiced", quote: "Startup fee $5,000", page: 1, doc: "Contract.pdf", items: ["t1"], evidence: "quote" });
    expect(sourceText(c)).toBe("Page 1 · Contract.pdf");
    expect(c.details.map((x) => x.label)).toEqual(["How it is paid"]);
  });
  it("a grid line has no quote and stands for every cell; a cell link narrows it to that cell", () => {
    const d = data();
    const whole = claimOf(d, lineOf(d, "grid:g1"), null);
    expect(whole).toMatchObject({ name: "Budget grid: Visit budget", quote: null, page: 2, items: ["grid:g1:0:0", "grid:g1:0:1"] });
    const cell = claimOf(d, lineOf(d, "grid:g1"), { target: "grid", id: "g1", row: 0, col: 1 });
    expect(cell).toMatchObject({ name: "Blood draw, Week 4", value: "$30.00", items: ["grid:g1:0:1"] });
  });
});

describe("viewerBoxes", () => {
  const page2 = () => data().pages[1]!;
  it("draws the quote as the focus and, besides it, only the problems", () => {
    const d = data();
    const out = viewerBoxes(d, d.pages[0]!, { ref: { target: "term", id: "t1" }, quote: [[0.1, 0.5, 0.4, 0.52], [0.1, 0.53, 0.6, 0.55]], selectedBox: null, showAll: false });
    expect(out.boxes.map((b) => [b.id, b.tone])).toEqual([
      ["quote:0", "focus"],
      ["quote:1", "focus"],
      ["amt:0", "focus"], // the item's own amount
      ["amt:1", "problem"], // $99.00 is missing
    ]);
    expect(out.focus).toEqual([0.1, 0.5, 0.6, 0.55]);
    expect(out.problems).toBe(1);
  });
  it("shows only the doubtful amount of a page by default, and every amount with its own tone when asked", () => {
    const d = data();
    const base = { ref: null, quote: [], selectedBox: null };
    expect(viewerBoxes(d, page2(), { ...base, showAll: false }).boxes.map((b) => [b.id, b.tone])).toEqual([["amt:3", "doubt"]]);
    expect(viewerBoxes(d, page2(), { ...base, showAll: true }).boxes.map((b) => [b.id, b.tone])).toEqual([["amt:0", "captured"], ["amt:1", "decided"], ["amt:2", "set_aside"], ["amt:3", "doubt"]]);
  });
  it("a grid cell focuses its own amount, and a picked amount is the focus whatever else is drawn", () => {
    const d = data();
    const cell = viewerBoxes(d, page2(), { ref: { target: "grid", id: "g1", row: 0, col: 0 }, quote: [], selectedBox: null, showAll: false });
    expect(cell.focus).toEqual(page2().amounts[0]!.box);
    expect(cell.boxes.find((b) => b.id === "amt:0")?.tone).toBe("focus");
    const picked = viewerBoxes(d, page2(), { ref: null, quote: [], selectedBox: 2, showAll: false });
    expect(picked.focus).toEqual(page2().amounts[2]!.box);
    expect(picked.boxes.map((b) => b.id)).toContain("amt:2");
  });
  it("says what an amount is in words, with its doubt", () => {
    const d = data();
    expect(viewerBoxes(d, page2(), { ref: null, quote: [], selectedBox: null, showAll: false }).boxes[0]!.label).toBe("$31.00 · captured as Visit budget · read with a doubt: handwritten");
  });
  it("has nothing for a page we don't have", () => expect(viewerBoxes(data(), undefined, { ref: null, quote: [], selectedBox: null, showAll: true })).toEqual({ boxes: [], focus: null, focusApprox: false, problems: 0 }));
  it("without any flag nothing is approximate: no mark carries the field and the focus is exact", () => {
    const d = data();
    const out = viewerBoxes(d, d.pages[0]!, { ref: { target: "term", id: "t1" }, quote: [[0.1, 0.5, 0.4, 0.52]], selectedBox: null, showAll: true });
    expect(out.boxes.every((b) => !("approx" in b))).toBe(true);
    expect(out.focusApprox).toBe(false);
  });
  it("an approximate amount is marked and worded as somewhere in its area; the exact ones beside it are not", () => {
    const d = data();
    d.pages[0]!.amounts[0]!.approx = true;
    const out = viewerBoxes(d, d.pages[0]!, { ref: { target: "term", id: "t1" }, quote: [], selectedBox: null, showAll: true });
    const [loose, exact] = out.boxes;
    expect(loose).toMatchObject({ id: "amt:0", tone: "focus", approx: true });
    expect(loose!.label).toMatch(/^\$5,000\.00 is somewhere in this area · /);
    expect("approx" in exact!).toBe(false);
    expect(out.focusApprox).toBe(true);
  });
  it("an approximate quote is marked on every box and in its label; a picked exact amount is an exact focus", () => {
    const d = data();
    const quote: [number, number, number, number][] = [[0.1, 0.5, 0.9, 0.7]];
    const out = viewerBoxes(d, d.pages[0]!, { ref: { target: "term", id: "t1" }, quote, quoteApprox: true, selectedBox: null, showAll: false });
    expect(out.boxes[0]).toMatchObject({ id: "quote:0", approx: true, label: "Approximate area · The words quoted in the rulebook" });
    expect(out.focusApprox).toBe(true);
    const picked = viewerBoxes(d, d.pages[0]!, { ref: null, quote: [], selectedBox: 0, showAll: false });
    expect(picked.focus).toEqual(d.pages[0]!.amounts[0]!.box);
    expect(picked.focusApprox).toBe(false); // an exact picked amount is exact
  });
  it("helpers", () => {
    expect(union([])).toBeNull();
    expect(amountIndex("amt:3")).toBe(3);
    expect(amountIndex("quote:0")).toBeNull();
    expect(amountTone(page2().amounts[3]!)).toBe("doubt");
  });
});

describe("shortcutOf", () => {
  const free = { onControl: false, inViewer: false };
  it("maps the keys", () => {
    const all = { " ": "match", Enter: "match", j: "next", J: "next", ArrowDown: "next", k: "prev", ArrowUp: "prev", f: "flag", Escape: "close", "?": "help", x: null };
    for (const [key, want] of Object.entries(all)) expect(shortcutOf(key, free)).toBe(want);
  });
  it("leaves Space and Enter to a focused button", () => {
    expect(shortcutOf(" ", { ...free, onControl: true })).toBeNull();
    expect(shortcutOf("j", { ...free, onControl: true })).toBe("next");
  });
  it("leaves the arrows to the page area, which pans, but not J and K", () => {
    expect(shortcutOf("ArrowDown", { ...free, inViewer: true })).toBeNull();
    expect(shortcutOf("k", { ...free, inViewer: true })).toBe("prev");
  });
});

describe("useIsNarrow", () => {
  const resize = (w: number) => act(() => void ((window.innerWidth = w), window.dispatchEvent(new Event("resize"))));
  afterEach(() => resize(1024));
  it("follows the window width across the breakpoint", () => {
    resize(1400);
    const { result } = renderHook(() => useIsNarrow());
    expect(result.current).toBe(false);
    resize(1099);
    expect(result.current).toBe(true);
    resize(1100);
    expect(result.current).toBe(false);
  });
});
