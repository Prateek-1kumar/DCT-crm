import { readFile } from "node:fs/promises";
import * as mupdf from "mupdf";

/** Pure-WASM PDF rendering (mupdf): no system binaries needed at runtime. */

export type Rotation = 0 | 90 | 180 | 270;

export type RenderOptions = {
  dpi?: number;
  /** Clockwise rotation applied before rendering, to make sideways grids upright. */
  rotate?: Rotation;
  /** Crop in output pixels (after scale + rotation): [x0, y0, x1, y1]. */
  clip?: [number, number, number, number];
  gray?: boolean;
};

/** Resource limits: a page number, DPI or page size from a request must never allocate unbounded memory. */
export const RENDER_LIMITS = {
  /** Requested DPI above this is clamped. */
  maxDpi: 600,
  /** Max pixels (width × height) of one rendered image; full pages are downscaled to fit, oversize tiles are rejected. */
  maxPixels: 40_000_000,
  /** Max tiles for one page; renderTiles lowers the DPI until the page fits. */
  maxTilesPerPage: 12,
};

export type Tile = { png: Buffer; row: number; col: number; rows: number; cols: number; box: [number, number, number, number] };

// ponytail: one open document per path, never evicted. Fine for a worker that handles a few PDFs; add an LRU if it serves many.
const docs = new Map<string, Promise<mupdf.Document>>();

function openDoc(pdfPath: string): Promise<mupdf.Document> {
  let doc = docs.get(pdfPath);
  if (!doc) {
    doc = readFile(pdfPath).then((buf) => mupdf.Document.openDocument(buf, "application/pdf"));
    docs.set(pdfPath, doc);
    doc.catch(() => docs.delete(pdfPath));
  }
  return doc;
}

export async function pageCount(pdfPath: string): Promise<number> {
  return (await openDoc(pdfPath)).countPages();
}

function loadPage(doc: mupdf.Document, page: number): mupdf.Page {
  const n = doc.countPages();
  if (!Number.isInteger(page) || page < 1 || page > n) throw new RangeError(`page ${page} out of range (1-${n})`);
  return doc.loadPage(page - 1);
}

function safeDpi(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new RangeError(`invalid dpi ${dpi}`);
  return Math.min(dpi, RENDER_LIMITS.maxDpi);
}

function transform(page: mupdf.Page, dpi: number, rotate: Rotation) {
  let m = mupdf.Matrix.concat(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.Matrix.rotate(rotate));
  const [x0, y0, x1, y1] = page.getBounds();
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [x! * m[0] + y! * m[2] + m[4], x! * m[1] + y! * m[3] + m[5]] as const);
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  m = mupdf.Matrix.concat(m, mupdf.Matrix.translate(-minX, -minY));
  const width = Math.round(Math.max(...pts.map((p) => p[0])) - minX);
  const height = Math.round(Math.max(...pts.map((p) => p[1])) - minY);
  return { m, width, height };
}

/** Output size in pixels of a page at a DPI and rotation. */
export async function pageSize(pdfPath: string, page: number, dpi = 150, rotate: Rotation = 0) {
  const p = loadPage(await openDoc(pdfPath), page);
  try {
    const { width, height } = transform(p, safeDpi(dpi), rotate);
    return { width, height };
  } finally {
    p.destroy();
  }
}

/**
 * Render one page (1-based) to PNG. DPI is clamped to RENDER_LIMITS.maxDpi; a full page larger than
 * RENDER_LIMITS.maxPixels is downscaled to fit; a clip larger than that is rejected.
 */
export async function renderPng(pdfPath: string, page: number, opts: RenderOptions = {}): Promise<Buffer> {
  const p = loadPage(await openDoc(pdfPath), page);
  let dpi = safeDpi(opts.dpi ?? 150);
  let t = transform(p, dpi, opts.rotate ?? 0);
  if (!opts.clip && t.width * t.height > RENDER_LIMITS.maxPixels) {
    dpi = Math.floor(dpi * 0.995 * Math.sqrt(RENDER_LIMITS.maxPixels / (t.width * t.height)) * 1000) / 1000; // margin for pixel rounding
    t = transform(p, dpi, opts.rotate ?? 0);
  }
  const { m, width, height } = t;
  const box = opts.clip ?? [0, 0, width, height];
  if ((box[2] - box[0]) * (box[3] - box[1]) > RENDER_LIMITS.maxPixels) {
    p.destroy();
    throw new RangeError(`render area ${box[2] - box[0]}x${box[3] - box[1]} exceeds ${RENDER_LIMITS.maxPixels} pixels`);
  }
  const cs = opts.gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const pix = new mupdf.Pixmap(cs, box, false);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    p.run(dev, m);
    dev.close();
    dev.destroy();
    return Buffer.from(pix.asPNG());
  } finally {
    pix.destroy();
    p.destroy();
  }
}

/**
 * Render a page as overlapping tiles no larger than maxPx on either side, so a dense grid
 * can be read at high DPI without the model downscaling it.
 */
export async function renderTiles(
  pdfPath: string,
  page: number,
  opts: { dpi: number; rotate?: Rotation; maxPx?: number; overlap?: number; gray?: boolean },
): Promise<Tile[]> {
  const rotate = opts.rotate ?? 0;
  const maxPx = opts.maxPx ?? 2400;
  const overlap = opts.overlap ?? 0.08;
  // Fixed-size tiles (<= maxPx) stepped so neighbours overlap by at least `overlap` of a tile.
  // Too many tiles (huge page or DPI) → lower the DPI until the page fits the per-page tile budget.
  let dpi = safeDpi(opts.dpi);
  let layout;
  for (;;) {
    const { width, height } = await pageSize(pdfPath, page, dpi, rotate);
    const tw = Math.min(width, maxPx);
    const th = Math.min(height, maxPx);
    const cols = width <= tw ? 1 : Math.ceil((width - tw) / (tw * (1 - overlap))) + 1;
    const rows = height <= th ? 1 : Math.ceil((height - th) / (th * (1 - overlap))) + 1;
    layout = { width, height, tw, th, cols, rows };
    if (rows * cols <= RENDER_LIMITS.maxTilesPerPage || dpi < 10) break;
    dpi *= 0.85;
  }
  const { width, height, tw, th, cols, rows } = layout;
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = cols === 1 ? 0 : Math.round(((width - tw) * c) / (cols - 1));
      const y0 = rows === 1 ? 0 : Math.round(((height - th) * r) / (rows - 1));
      const box: [number, number, number, number] = [x0, y0, x0 + tw, y0 + th];
      const png = await renderPng(pdfPath, page, { dpi, rotate, clip: box, gray: opts.gray });
      tiles.push({ png, row: r, col: c, rows, cols, box });
    }
  }
  return tiles;
}

/** Largest DPI (capped) at which the page fits within maxPx on its long edge. */
export async function dpiToFit(pdfPath: string, page: number, maxPx: number, capDpi: number): Promise<number> {
  const { width, height } = await pageSize(pdfPath, page, 72);
  return Math.min(capDpi, Math.floor((72 * maxPx) / Math.max(width, height)));
}
