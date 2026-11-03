import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { readTextLayer } from "../src/textlayer";

// White text counts as visible only on a dark box a reader can see under it: drawn through no clip but a rectangle that
// keeps it, with no opaque box drawn over the text afterwards. Hidden text is never evidence (AGENTS.md), so anything
// unsure stays hidden. Synthetic PDF only.

const at = (x: number, y: number, s: string) => `BT 0 Tr 1 1 1 rg /F1 8 Tf ${x} ${792 - y} Td (${s}) Tj ET 0 g\n`;
const bar = (y: number) => `0.09 0.21 0.36 rg 36 ${792 - y - 4} 540 14 re f 0 g\n`;

function pdf(): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) }, ExtGState: { Faint: { ca: 0.05 }, Half: { ca: 0.5 } } };
  const content =
    // plain: a dark bar, white text on it (visible)
    bar(60) + at(40, 60, "$1,111.00") +
    // the bar drawn through a text clip (render mode 7): what shows of it is unknown (hidden)
    `q BT 7 Tr /F1 30 Tf 300 ${792 - 110} Td (CLIP) Tj ET ${bar(100)}${at(40, 100, "$2,222.00")}Q\n` +
    // an opaque white box drawn over the white text afterwards (hidden)
    bar(140) + at(40, 140, "$3,333.00") + `1 1 1 rg 30 ${792 - 150} 200 20 re f 0 g\n` +
    // a thin rule drawn over it afterwards, an underline: still visible
    bar(180) + at(40, 180, "$4,444.00") + `1 1 1 rg 38 ${792 - 181} 60 0.5 re f 0 g\n` +
    // a rectangular clip that keeps the bar under the text: visible
    `q 30 ${792 - 230} 300 30 re W n ${bar(220)}${at(40, 220, "$5,555.00")}Q\n` +
    // a rectangular clip that cuts the bar away where the text is: hidden
    `q 300 ${792 - 270} 200 30 re W n ${bar(260)}Q ${at(40, 260, "$6,666.00")}` +
    // clip-only text (render mode 7) draws nothing, even on a dark bar; fill-and-clip text (mode 4) is drawn
    bar(300) + `q BT 7 Tr 0 g /F1 8 Tf 40 ${792 - 300} Td ($7,777.00) Tj ET Q\n` + `q BT 4 Tr 0 g /F1 8 Tf 300 ${792 - 340} Td ($8,888.00) Tj ET Q\n` +
    // a clip-only glyph with a white one painted on the page at the same spot: still nothing drawn (hidden)
    `q BT 7 Tr 0 g /F1 8 Tf 40 ${792 - 380} Td ($1,212.00) Tj ET Q\n` + at(40, 380, "$1,212.00") +
    // a white box drawn over the text through a text clip we can't see through: may hide it (hidden)
    bar(420) + at(40, 420, "$2,323.00") + `q BT 7 Tr /F1 30 Tf 30 ${792 - 430} Td (CLIPPED) Tj ET 1 1 1 rg 30 ${792 - 430} 200 20 re f Q\n` +
    // a white box over most of the glyphs but not their baseline: hidden
    bar(460) + at(40, 460, "$3,434.00") + `1 1 1 rg 30 ${792 - 460 + 1.5} 200 6 re f 0 g\n` +
    // a half see-through white box over the text: hidden
    bar(500) + at(40, 500, "$5,656.00") + `q /Half gs 1 1 1 rg 30 ${792 - 510} 200 20 re f Q\n` +
    // black text all but see-through: hidden
    `q /Faint gs BT 0 Tr 0 g /F1 8 Tf 40 ${792 - 540} Td ($4,545.00) Tj ET Q\n` +
    at(40, 700, "Synthetic page: white figures on dark bars, some clipped or covered.").replace("1 1 1 rg", "0 g");
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));
  const path = join(mkdtempSync(join(tmpdir(), "dct-white-")), "white.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

describe("white text", () => {
  it("is visible on a dark box only when nothing clips the box away or covers the text", async () => {
    const [p] = await readTextLayer(pdf(), "d1");
    const hidden = (t: string) => p!.words.find((w) => w.text === t)!.hidden;
    expect([" 1,111.00", hidden("$1,111.00")]).toEqual([" 1,111.00", false]);
    expect([" 2,222.00", hidden("$2,222.00")]).toEqual([" 2,222.00", true]);
    expect([" 3,333.00", hidden("$3,333.00")]).toEqual([" 3,333.00", true]);
    expect([" 4,444.00", hidden("$4,444.00")]).toEqual([" 4,444.00", false]);
    expect([" 5,555.00", hidden("$5,555.00")]).toEqual([" 5,555.00", false]);
    expect([" 6,666.00", hidden("$6,666.00")]).toEqual([" 6,666.00", true]);
    expect([" 7,777.00", hidden("$7,777.00")]).toEqual([" 7,777.00", true]);
    expect([" 8,888.00", hidden("$8,888.00")]).toEqual([" 8,888.00", false]);
    // every word printing this figure is hidden: the clip-only one and the white one on white
    expect(p!.words.filter((w) => w.text.includes("1,212.00")).every((w) => w.hidden)).toBe(true);
    expect([" 2,323.00", hidden("$2,323.00")]).toEqual([" 2,323.00", true]);
    expect([" 3,434.00", hidden("$3,434.00")]).toEqual([" 3,434.00", true]);
    expect([" 5,656.00", hidden("$5,656.00")]).toEqual([" 5,656.00", true]);
    expect([" 4,545.00", hidden("$4,545.00")]).toEqual([" 4,545.00", true]);
  });
});
