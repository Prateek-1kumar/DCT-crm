import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { readTextLayer } from "../src/textlayer";

/** The tables a page draws with ruled lines, and whether the page is drawn as shapes (TextPage.grids / drawn). Synthetic PDFs only. */

/** Page 612 x 792 from a content stream (PDF coordinates, origin bottom-left); `image` adds a full-page picture as /Im0. */
async function read(content: string, opts: { text?: boolean; image?: boolean } = {}) {
  const doc = new mupdf.PDFDocument();
  const res: Record<string, unknown> = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  if (opts.image) {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 10, 10], false);
    pix.clear(200);
    res.XObject = { Im0: doc.addImage(new mupdf.Image(pix)) };
  }
  const words = ["This page continues the agreement between the parties and the site, as set out in full above.", "A second line of ordinary words keeps the page well above the threshold for a real text layer.", "A third line, because a page with fewer than two hundred characters of text is treated as a scan."];
  const text = opts.text ? words.map((w, i) => `BT /F1 8 Tf 40 ${60 + i * 12} Td (${w}) Tj ET\n`).join("") : "";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, text + content));
  const path = join(mkdtempSync(join(tmpdir(), "dct-grid-")), "p.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return (await readTextLayer(path, "d1"))[0]!;
}

/** Ruled table, stroked: vertical rules at `xs`, horizontal at `ys` (PDF coordinates), each spanning the table. */
const stroked = (xs: number[], ys: number[]) => {
  const [x0, x1, y0, y1] = [xs[0]!, xs[xs.length - 1]!, ys[0]!, ys[ys.length - 1]!];
  return `0.5 w\n${xs.map((x) => `${x} ${y0} m ${x} ${y1} l S`).join("\n")}\n${ys.map((y) => `${x0} ${y} m ${x1} ${y} l S`).join("\n")}\n`;
};
/** The same table, every rule a thin filled rectangle. */
const filled = (xs: number[], ys: number[]) => {
  const [x0, x1, y0, y1] = [xs[0]!, xs[xs.length - 1]!, ys[0]!, ys[ys.length - 1]!];
  return `${xs.map((x) => `${x - 0.4} ${y0} 0.8 ${y1 - y0} re f`).join("\n")}\n${ys.map((y) => `${x0} ${y - 0.4} ${x1 - x0} 0.8 re f`).join("\n")}\n`;
};
/** `n` small curved shapes, as text turned to outlines is drawn. */
const glyphs = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const [x, y] = [20 + (i % 40) * 14, 40 + Math.floor(i / 40) * 14];
    return `${x} ${y} m ${x + 3} ${y + 6} ${x + 7} ${y + 6} ${x + 9} ${y} c h f`;
  }).join("\n") + "\n";

const near = (got: number[] | undefined, want: number[]) => {
  expect(got).toHaveLength(want.length);
  want.forEach((v, i) => expect(got![i]).toBeCloseTo(v, 0));
};

describe("drawn tables", () => {
  it("finds a table drawn with stroked lines, in page points from the top", async () => {
    const p = await read(stroked([100, 200, 300, 400], [692, 642, 592, 542]));
    expect(p.grids).toHaveLength(1);
    near(p.grids![0]!.xs, [100, 200, 300, 400]);
    near(p.grids![0]!.ys, [100, 150, 200, 250]);
    near(p.grids![0]!.box, [100, 100, 400, 250]);
  });

  it("finds a table drawn with thin filled rectangles", async () => {
    const p = await read(filled([100, 200, 300, 400], [692, 642, 592, 542]));
    expect(p.grids).toHaveLength(1);
    near(p.grids![0]!.xs, [100, 200, 300, 400]);
    near(p.grids![0]!.ys, [100, 150, 200, 250]);
  });

  it("finds a table drawn sideways, upright in page points", async () => {
    // Content turned a quarter turn inside an unrotated page: local (x, y) lands at (612 - y, x).
    const p = await read(`q 0 1 -1 0 612 0 cm\n${stroked([100, 200, 300, 400], [100, 150, 200, 250])}Q\n`);
    expect(p.grids).toHaveLength(1);
    near(p.grids![0]!.xs, [362, 412, 462, 512]);
    near(p.grids![0]!.ys, [392, 492, 592, 692]);
  });

  it("keeps two tables on one page apart", async () => {
    const p = await read(stroked([50, 100, 150], [700, 660, 620]) + stroked([300, 400, 500], [300, 250, 200]));
    expect(p.grids).toHaveLength(2);
    near(p.grids![0]!.xs, [50, 100, 150]);
    near(p.grids![0]!.ys, [92, 132, 172]);
    near(p.grids![1]!.xs, [300, 400, 500]);
    near(p.grids![1]!.ys, [492, 542, 592]);
  });

  it("joins a table whose cells are stroked one by one, and merges rules within a point", async () => {
    const cells = [0, 1, 2].flatMap((c) => [0, 1, 2].map((r) => `${100 + c * 80} ${600 - r * 40} 80 -40 re S`)).join("\n");
    const p = await read(`0.5 w\n${cells}\n`);
    expect(p.grids).toHaveLength(1);
    near(p.grids![0]!.xs, [100, 180, 260, 340]);
    near(p.grids![0]!.ys, [192, 232, 272, 312]);
  });

  it("ignores a stray short mark and a column that spans too little of the table", async () => {
    // A 3 x 3 table, plus a 40 pt tick at its side and a rule inside the first row only.
    const p = await read(`${stroked([100, 200, 300], [692, 592, 492])}0.5 w\n150 692 m 150 672 l S\n301 560 m 330 560 l S\n`);
    expect(p.grids).toHaveLength(1);
    near(p.grids![0]!.xs, [100, 200, 300]);
    near(p.grids![0]!.ys, [100, 200, 300]);
  });

  it("finds no table in two rules, or in a few lines that don't form three by three", async () => {
    const p = await read(stroked([100, 200], [692, 592, 492]));
    expect(p.grids).toEqual([]);
  });

  it("draws no rules from outlined text", async () => {
    const p = await read(glyphs(400));
    expect(p.grids).toEqual([]);
    expect(p.drawn).toBe(true);
  });

  it("still finds a table on a page with a real text layer", async () => {
    const p = await read(stroked([100, 200, 300, 400], [692, 642, 592, 542]), { text: true });
    expect(p.source).toBe("text");
    expect(p.words.length).toBeGreaterThan(10);
    expect(p.grids).toHaveLength(1);
    expect(p.drawn).toBe(false);
  });
});

describe("drawn pages", () => {
  it("is true for a page of outlined shapes and its table, false for a normal text page", async () => {
    expect((await read(glyphs(400) + stroked([100, 200, 300], [692, 592, 492]))).drawn).toBe(true);
    expect((await read("", { text: true })).drawn).toBe(false);
  });

  it("is false for a page that is one picture, even with many filled paths", async () => {
    const p = await read(`q 612 0 0 792 0 0 cm /Im0 Do Q\n${glyphs(400)}`, { image: true });
    expect(p.drawn).toBe(false);
  });

  it("is false for a page with few filled paths", async () => {
    expect((await read(glyphs(50))).drawn).toBe(false);
  });
});
