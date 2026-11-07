import { describe, expect, it } from "vitest";
import { amountsOf, gridItems, isProblem, visibleAmounts } from "./highlights";
import { grid, pageOf } from "./test-data";

const page2 = pageOf(1); // $25 captured (cell 0,0), $30 decided, $1,000 set aside, $31 captured but handwritten
const page1 = pageOf(0); // $5,000 captured, $99 missing

describe("isProblem", () => {
  it("is true for a missing amount and for any doubt, false otherwise", () => {
    expect(page1.amounts.map(isProblem)).toEqual([false, true]);
    expect(page2.amounts.map(isProblem)).toEqual([false, false, false, true]);
  });
});

describe("visibleAmounts", () => {
  it("draws only problems by default", () => {
    expect(visibleAmounts(page2, { showAll: false, selected: null, strong: [] })).toEqual([3]);
    expect(visibleAmounts(page1, { showAll: false, selected: null, strong: [] })).toEqual([1]);
  });
  it("draws everything when asked", () => {
    expect(visibleAmounts(page2, { showAll: true, selected: null, strong: [] })).toEqual([0, 1, 2, 3]);
  });
  it("always draws the selected amount and the line's own amounts", () => {
    expect(visibleAmounts(page2, { showAll: false, selected: 2, strong: [0] })).toEqual([0, 2, 3]);
  });
});

describe("amountsOf", () => {
  it("finds a term's amounts", () => expect(amountsOf(page1, { target: "term", id: "t1" })).toEqual([0]));
  it("finds one grid cell's amount, and nothing when the cell has none", () => {
    expect(amountsOf(page2, { target: "grid", id: "g1", row: 0, col: 1 })).toEqual([3]);
    expect(amountsOf(page2, { target: "grid", id: "g1", row: 5, col: 5 })).toEqual([]);
  });
  it("a whole-grid link matches every amount of that grid", () => {
    expect(amountsOf(page2, { target: "grid", id: "g1", row: -1, col: 0 })).toEqual([0, 3]);
  });
});

describe("gridItems", () => {
  it("lists a proofread item per amount cell, skipping blanks and words", () => {
    const g = { ...grid, rows: [{ ...grid.rows[0]!, cells: [2500, null, "N/A", 100] }] };
    expect(gridItems(g)).toEqual(["grid:g1:0:0", "grid:g1:0:3"]);
  });
});
