import type { TextPage, Word } from "./textlayer";

/**
 * Words from our own local OCR (PaddleOCR, ADR-001 addendum 2026-10-29) for a page that has no text layer, in the space
 * readTextLayer uses, so the binder checks a scan's numbers by position exactly as it checks a born-digital PDF's. The
 * OCR text is a second reading, never given to the AI reader: two channels that can't see each other mean something
 * when they agree.
 */

/** One word as the OCR worker reports it: pixel box [x0, y0, x1, y1] in the image it read, and its line in that image. */
export type OcrWord = { text: string; conf: number; bbox: [number, number, number, number]; line: number };

/**
 * What the worker read on one page: the image was the page rendered at `dpi`, turned `turned` degrees clockwise
 * (90 for a page whose text runs bottom to top: turned, it reads upright).
 */
export type OcrReading = { words: OcrWord[]; dpi: number; turned: 0 | 90 };

type Rect = Word["rect"];

/**
 * The page with the OCR's words in place of its (missing) text: boxes back in page points, in the page's own frame, and
 * each word's reading direction. Lines that sit close together and overlap across are one block, so sentences don't
 * run from one paragraph or table cell into the next.
 */
export function ocrPage(base: TextPage, r: OcrReading): TextPage {
  const s = 72 / r.dpi;
  const hpx = base.height / s;
  // turned 90° clockwise, image (u, v) was page (v, H − u)
  const back = ([u0, v0, u1, v1]: Rect): Rect => (r.turned ? [v0 * s, (hpx - u1) * s, v1 * s, (hpx - u0) * s] : [u0 * s, v0 * s, u1 * s, v1 * s]);
  const lineBox = new Map<number, Rect>();
  for (const w of r.words) {
    const b = lineBox.get(w.line);
    lineBox.set(w.line, b ? [Math.min(b[0], w.bbox[0]), Math.min(b[1], w.bbox[1]), Math.max(b[2], w.bbox[2]), Math.max(b[3], w.bbox[3])] : [...w.bbox]);
  }
  const blockOf = new Map<number, number>();
  let block = 0;
  let prev: Rect | null = null;
  for (const [line, b] of [...lineBox].sort((x, y) => x[1][1] - y[1][1])) {
    if (prev && !(b[1] - prev[3] < b[3] - b[1] && b[0] < prev[2] && prev[0] < b[2])) block++;
    blockOf.set(line, block);
    prev = b;
  }
  const words: Word[] = r.words
    .filter((w) => w.text.trim())
    .map((w) => ({ text: w.text.trim(), rect: back(w.bbox), dir: r.turned ? 3 : 0, block: blockOf.get(w.line)!, line: w.line, hidden: false, conf: w.conf }));
  return { ...base, source: "ocr", words, hidden: 0, largePicture: false };
}
