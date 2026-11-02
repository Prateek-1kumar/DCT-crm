import { describe, expect, it } from "vitest";
import { besideOnLine, type TextPage, type Word } from "../src/textlayer";

// A fee's row on a two-column page, built as words directly: the other column's sentence shares the row's visual line.
const W = 600;
const H = 800;
const word = (text: string, x0: number, x1: number, block: number): Word => ({ text, rect: [x0, 100, x1, 110], dir: 0, block, line: 0, hidden: false });
const page = (words: Word[], grids?: TextPage["grids"]): TextPage => ({ documentId: "d", page: 1, width: W, height: H, source: "text", words, hidden: 0, largePicture: false, grids });
const amount = { documentId: "d", page: 1, box: [100 / W, 100 / H, 30 / W, 10 / H] as [number, number, number, number] };

describe("besideOnLine reads only the amount's own cell", () => {
  it("stops at the gap to the other column", () => {
    const words = [word("$2,000", 100, 130, 1), word("one-time", 180, 215, 2), word("payment", 218, 250, 2), word("paid", 320, 335, 3), word("once", 338, 355, 3), word("the", 358, 370, 3), word("site", 373, 390, 3)];
    expect(besideOnLine([page(words)], amount)).toBe("one-time payment");
  });

  it("stops at the edge of the ruled table the amount sits in, however close the next column is", () => {
    const words = [word("$2,000", 100, 130, 1), word("per", 180, 192, 2), word("year", 195, 212, 2), word("paid", 218, 233, 3), word("once", 236, 250, 3)];
    expect(besideOnLine([page(words, [{ box: [90, 90, 214, 120], xs: [90, 170, 214], ys: [90, 120] }])], amount)).toBe("per year");
    expect(besideOnLine([page(words)], amount)).toBe("per year paid once"); // no table: one run, as printed
  });
});
