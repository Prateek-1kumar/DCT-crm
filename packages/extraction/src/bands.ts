import type { BandPlan, PageRect } from "./render";
import { amounts, type Word } from "./textlayer";

/**
 * Row bands for a grid page (ADR-002 §1.5; EXTRACTION_BANDS). The cut points come from where the page's own words are, never
 * from the model: the header is every line above the first line that prints a money amount, and a band boundary is a gap
 * between two lines, so no row is cut in half.
 *
 * No overlap between bands, on purpose. Square tiles overlapped 8% because a blind cut can split a glyph, and the prompt then
 * had to say "count the overlap once"; a cut in a gap with no word in it splits nothing, and a row shown twice is a row that
 * can be counted twice. Every line is in exactly one band; only the header repeats.
 *
 * ponytail: a row is a line of words (a merged span of their vertical extents), so a wrapped label whose cells sit in between
 * stays one row, but a row of one-line labels with nothing between two wrapped lines would be cut there. A page with no
 * header above its first amount (a table's continuation page) isn't banded. Upgrade: row boundaries from the page's rules
 * (`TextPage.grids`), and the earlier page's header for a continuation.
 */

export type BandFail = "rows" | "size";

export type BandOptions = {
  /** Rows per band, at most (bands are cut evenly, so a 13-row body is 7 and 6). */
  rows: number;
  /** The DPI to use at most (EXTRACTION_GRID_DPI). */
  dpi: number;
  /** Widest a band may be, in pixels. */
  maxPx: number;
  /** The long edge the model reads an image at: a band wider than this is shrunk by the provider, so `minWordPx` counts what is left. */
  viewPx: number;
  /** Most pixels of body rows in a band, before the header: bands are cut evenly under it where the rows allow (else only `maxPixels` binds). */
  bodyPx: number;
  /** Most pixels in one band (Claude reads about 3.75 MP; the tiles stay under 3.6). */
  maxPixels: number;
  /** A word box shorter than this many pixels, as the model sees it (at the chosen DPI, then shrunk to `viewPx`), is too small to read: the page keeps its tiles. */
  minWordPx: number;
};

const PAD = 4;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/**
 * `words` are the page's (any source); `to` carries their boxes into the upright frame of the image the model sees, `size`
 * is that frame in points. A string says why the page can't be banded: "rows" (no words, no row of amounts, or no header above
 * it) or "size" (the table is too wide, its type too small or its header too tall to read in a band).
 */
export function planBands(words: Word[], to: (r: PageRect) => PageRect, size: { width: number; height: number }, o: BandOptions): BandPlan | BandFail {
  const ws = words.filter((w) => !w.hidden && w.text.trim()).map((w) => ({ ...w, rect: to(w.rect) }));
  if (ws.length < 2) return "rows";

  // lines: words whose middle 80% overlaps vertically, so a word box a little taller than its glyphs doesn't join its neighbour
  const trim = (w: Word) => (w.rect[3] - w.rect[1]) * 0.1;
  const lines: { top: number; bottom: number; words: Word[] }[] = [];
  for (const w of [...ws].sort((a, b) => a.rect[1] + trim(a) - (b.rect[1] + trim(b)))) {
    const [top, bottom] = [w.rect[1] + trim(w), w.rect[3] - trim(w)];
    const last = lines.at(-1);
    if (last && top <= last.bottom) {
      last.bottom = Math.max(last.bottom, bottom);
      last.words.push(w);
    } else lines.push({ top, bottom, words: [w] });
  }
  const first = lines.findIndex((l) => amounts(l.words.sort((a, b) => a.rect[0] - b.rect[0])).length > 0);
  if (first < 1) return "rows";
  const cut = (i: number) => (lines[i - 1]!.bottom + lines[i]!.top) / 2; // the gap before line i

  const [x0, x1] = [Math.max(0, Math.min(...ws.map((w) => w.rect[0])) - PAD), Math.min(size.width, Math.max(...ws.map((w) => w.rect[2])) + PAD)];
  const dpi = Math.min(o.dpi, Math.floor((72 * o.maxPx) / (x1 - x0)));
  const s = dpi / 72;
  const seen = Math.min(1, o.viewPx / ((x1 - x0) * s)); // what the provider's own downsizing leaves of a band's pixels
  if (median(ws.map((w) => w.rect[3] - w.rect[1])) * s * seen < o.minWordPx) return "size";
  const maxH = Math.floor(o.maxPixels / ((x1 - x0) * s));
  const header: [number, number] = [Math.max(0, lines[0]!.top - PAD), cut(first)];
  const headerPx = (header[1] - header[0]) * s;
  if (headerPx > 0.4 * maxH) return "size";

  const body = lines.length - first;
  const end = Math.min(size.height, lines.at(-1)!.bottom + PAD);
  // k bands of body / k lines, the first `body % k` one longer: the fewest bands whose body is within `bodyPx` (when no k gets
  // there, as for a few very tall rows, the fewest that fit the pixel budget)
  const cutInto = (k: number) => {
    const bands: [number, number][] = [];
    for (let i = 0, from = first; i < k; i++) {
      const to2 = from + Math.floor(body / k) + (i < body % k ? 1 : 0);
      bands.push([i ? cut(from) : header[1], to2 < lines.length ? cut(to2) : end]);
      from = to2;
    }
    return bands;
  };
  const fits = (bands: [number, number][]) => bands.every(([a, b]) => headerPx + (b - a) * s <= maxH);
  const ks = Array.from({ length: body - Math.ceil(body / o.rows) + 1 }, (_, i) => Math.ceil(body / o.rows) + i);
  const best = ks.map(cutInto).find((b) => fits(b) && b.every(([a, z]) => (z - a) * s <= o.bodyPx)) ?? ks.map(cutInto).find(fits);
  return best ? { dpi, x: [x0, x1], header, bands: best } : "size";
}
