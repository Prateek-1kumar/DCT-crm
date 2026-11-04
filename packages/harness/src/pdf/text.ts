import { Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { Word } from "../types";

// Fragments of one word that pdf.js splits into several items sit closer than a real space (about a quarter em).
const SAME_WORD_GAP_EM = 0.12;
// Glyph boxes reach below the baseline for descenders.
const DESCENT_EM = 0.2;

interface Pt {
  x: number;
  y: number;
}

// A scale-1 viewport transform already applies page rotation.
export function extractWords(content: TextContent, viewportTransform: number[], width: number, height: number): Word[] {
  const words: Word[] = [];
  let text = "";
  let pts: Pt[] = [];
  let lastEnd: Pt | null = null;
  let lastGapLimit = 0;

  const flush = () => {
    if (text && pts.length) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      words.push({ text, x0: Math.min(...xs) / width, y0: Math.min(...ys) / height, x1: Math.max(...xs) / width, y1: Math.max(...ys) / height });
    }
    text = "";
    pts = [];
  };

  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const m = Util.transform(viewportTransform, item.transform);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m;
    const fontSize = Math.hypot(c, d);
    const run = Math.hypot(a, b);
    if (!fontSize || !run) continue;
    const n = item.str.length;
    const length = item.width > 0 ? item.width : n * fontSize * 0.5;
    const dir = { x: (a / run) * length, y: (b / run) * length };
    const at = (i: number, up: number): Pt => ({ x: e + (dir.x * i) / n + c * up, y: f + (dir.y * i) / n + d * up });

    for (let i = 0; i < n; i++) {
      const ch = item.str[i] ?? "";
      if (/\s/.test(ch)) {
        flush();
        lastEnd = null;
        continue;
      }
      const start = at(i, 0);
      if (lastEnd && Math.hypot(start.x - lastEnd.x, start.y - lastEnd.y) > Math.max(lastGapLimit, SAME_WORD_GAP_EM * fontSize)) flush();
      text += ch;
      pts.push(at(i, -DESCENT_EM), at(i, 1), at(i + 1, -DESCENT_EM), at(i + 1, 1));
      lastEnd = at(i + 1, 0);
      lastGapLimit = SAME_WORD_GAP_EM * fontSize;
    }
  }
  flush();
  return words;
}
