import { Worker } from "node:worker_threads";
import type { TextPage } from "./textlayer";

/** Pure-WASM PDF rendering (mupdf): no system binaries needed at runtime. All of it runs in a worker thread (`call`). */

export type Rotation = 0 | 90 | 180 | 270;

/** x0, y0, x1, y1 in page points (the space the text layer's word boxes are in). */
export type PageRect = [number, number, number, number];

export type RenderOptions = {
  dpi?: number;
  /** Clockwise rotation applied before rendering, to make sideways grids upright. */
  rotate?: Rotation;
  /** Crop in output pixels (after scale + rotation): [x0, y0, x1, y1]. */
  clip?: [number, number, number, number];
  gray?: boolean;
  /** Page areas painted black in the image, e.g. bank details (ADR-001 §9: never sent to a model). */
  mask?: PageRect[];
};

/** Resource limits: a page number, DPI or page size from a request must never allocate unbounded memory. */
export const RENDER_LIMITS = {
  /** Requested DPI above this is clamped. */
  maxDpi: 600,
  /** Max pixels (width × height) of one rendered image; full pages are downscaled to fit, oversize tiles are rejected. */
  maxPixels: 40_000_000,
  /** Max tiles for one page; renderTiles lowers the DPI until the page fits. */
  maxTilesPerPage: 12,
  /** One mupdf call (draw a page, read its text) longer than this is stopped; the page then fails fast until a restart. */
  timeoutMs: 30_000,
};

export type Tile = { png: Buffer; row: number; col: number; rows: number; cols: number; box: [number, number, number, number] };

/** A page that takes too long to draw or read (a crafted or broken PDF): it was stopped, and isn't tried again. */
export class RenderTimeoutError extends Error {
  override name = "RenderTimeoutError";
}

// ---------- the mupdf worker ----------

type Job = { op: string; args: unknown[]; key: string; resolve: (v: unknown) => void; reject: (e: Error) => void };
// ponytail: one worker, calls in order: mupdf is single-threaded anyway. A pool if renders queue behind long extractions.
let worker: Worker | null = null;
let busy: (Job & { timer: NodeJS.Timeout }) | null = null;
const queue: Job[] = [];
/** Pages (path#page, or path for the whole file) that timed out: refused at once from then on. */
const stuck = new Set<string>();

const revive = (e: { name: string; message: string }) => Object.assign(e.name === "RangeError" ? new RangeError(e.message) : new Error(e.message), { name: e.name });

function settle(fn: (j: Job) => void) {
  const j = busy!;
  clearTimeout(j.timer);
  busy = null;
  fn(j);
  next();
}

function spawn(): Worker {
  const w = new Worker(new URL("./mupdf-worker.mjs", import.meta.url));
  w.on("message", (m: { result?: unknown; error?: { name: string; message: string } }) => {
    if (worker === w && busy) settle((j) => (m.error ? j.reject(revive(m.error)) : j.resolve(m.result)));
  });
  w.on("error", (e) => {
    if (worker !== w) return;
    worker = null;
    if (busy) settle((j) => j.reject(e));
  });
  w.on("exit", () => {
    if (worker !== w) return;
    worker = null;
    if (busy) settle((j) => j.reject(new Error("The PDF reader stopped unexpectedly")));
  });
  w.unref(); // after the listeners (adding one refs it again): an idle worker never keeps a process alive; a job in flight does (its timer)
  return w;
}

function next() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  const w = (worker ??= spawn());
  const timer = setTimeout(() => {
    stuck.add(job.key);
    worker = null;
    void w.terminate();
    settle((j) => j.reject(new RenderTimeoutError(`This page took longer than ${RENDER_LIMITS.timeoutMs / 1000} s to read, so it was stopped. The PDF may be damaged or unusually complex.`)));
  }, RENDER_LIMITS.timeoutMs);
  busy = { ...job, timer };
  w.postMessage({ op: job.op, args: job.args });
}

function call<T>(op: string, path: string, page: number | null, ...rest: unknown[]): Promise<T> {
  const key = page === null ? path : `${path}#${page}`;
  if (stuck.has(key) || stuck.has(path)) return Promise.reject(new RenderTimeoutError("This page took too long to read earlier, so it isn't tried again."));
  return new Promise<T>((resolve, reject) => {
    queue.push({ op, args: page === null ? [path, ...rest] : [path, page, ...rest], key, resolve: resolve as (v: unknown) => void, reject });
    next();
  });
}

// ---------- pages ----------

export function pageCount(pdfPath: string): Promise<number> {
  return call("count", pdfPath, null);
}

/** The page's embedded text layer; empty for a scanned image with no OCR. */
export function pageText(pdfPath: string, page: number): Promise<string> {
  return call("text", pdfPath, page);
}

/** One page of the PDF's own text, words with boxes (textlayer.ts readTextLayer). */
export function textPage(pdfPath: string, page: number, documentId: string, minVisiblePt: number, minPageText: number): Promise<TextPage> {
  return call("textPage", pdfPath, page, documentId, minVisiblePt, minPageText);
}

/** PDFs the worker holds open (bounded, least recently used closed first). */
export const openDocuments = () => call<number>("openDocuments", "", null);

/** x0, y0, x1, y1 of the page in points; RangeError for a page that isn't there. */
const bounds = (pdfPath: string, page: number) => call<[number, number, number, number]>("bounds", pdfPath, page);

type Matrix = [number, number, number, number, number, number];
const concat = ([a, b, c, d, e, f]: Matrix, [A, B, C, D, E, F]: Matrix): Matrix => [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
/** mupdf's fz_rotate for quarter turns (exact, no float error). */
const ROTATE: Record<Rotation, Matrix> = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, 0, 0], 180: [-1, 0, 0, -1, 0, 0], 270: [0, -1, 1, 0, 0, 0] };

function safeDpi(dpi: number): number {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new RangeError(`invalid dpi ${dpi}`);
  return Math.min(dpi, RENDER_LIMITS.maxDpi);
}

function transform([x0, y0, x1, y1]: [number, number, number, number], dpi: number, rotate: Rotation) {
  let m = concat([dpi / 72, 0, 0, dpi / 72, 0, 0], ROTATE[rotate]);
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => [x! * m[0] + y! * m[2] + m[4], x! * m[1] + y! * m[3] + m[5]] as const);
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  m = concat(m, [1, 0, 0, 1, -minX, -minY]);
  const width = Math.round(Math.max(...pts.map((p) => p[0])) - minX);
  const height = Math.round(Math.max(...pts.map((p) => p[1])) - minY);
  return { m, width, height };
}

/** Output size in pixels of a page at a DPI and rotation. */
export async function pageSize(pdfPath: string, page: number, dpi = 150, rotate: Rotation = 0) {
  const { width, height } = transform(await bounds(pdfPath, page), safeDpi(dpi), rotate);
  return { width, height };
}

/**
 * Render one page (1-based) to PNG. DPI is clamped to RENDER_LIMITS.maxDpi; a full page larger than
 * RENDER_LIMITS.maxPixels is downscaled to fit; a clip larger than that is rejected.
 */
export async function renderPng(pdfPath: string, page: number, opts: RenderOptions = {}): Promise<Buffer> {
  const b = await bounds(pdfPath, page);
  let dpi = safeDpi(opts.dpi ?? 150);
  let t = transform(b, dpi, opts.rotate ?? 0);
  if (!opts.clip && t.width * t.height > RENDER_LIMITS.maxPixels) {
    dpi = Math.floor(dpi * 0.995 * Math.sqrt(RENDER_LIMITS.maxPixels / (t.width * t.height)) * 1000) / 1000; // margin for pixel rounding
    t = transform(b, dpi, opts.rotate ?? 0);
  }
  const { m, width, height } = t;
  const box = opts.clip ?? [0, 0, width, height];
  if ((box[2] - box[0]) * (box[3] - box[1]) > RENDER_LIMITS.maxPixels) throw new RangeError(`render area ${box[2] - box[0]}x${box[3] - box[1]} exceeds ${RENDER_LIMITS.maxPixels} pixels`);
  return Buffer.from(await call<Uint8Array>("render", pdfPath, page, m, box, !!opts.gray, opts.mask ?? []));
}

export type TileOptions = { dpi: number; rotate?: Rotation; maxPx?: number; overlap?: number; gray?: boolean; mask?: PageRect[] };
export type TileLayout = { dpi: number; width: number; height: number; tw: number; th: number; cols: number; rows: number; count: number };

/**
 * Tile grid for a page, without rendering anything. Fixed-size tiles (<= maxPx) step so neighbours
 * overlap by `overlap` of a tile. Too many tiles (huge page or DPI) → DPI is lowered until the page fits
 * RENDER_LIMITS.maxTilesPerPage; if it still can't (pathological page), RangeError.
 */
export async function tileLayout(pdfPath: string, page: number, opts: TileOptions): Promise<TileLayout> {
  const rotate = opts.rotate ?? 0;
  const maxPx = opts.maxPx ?? 2400;
  const overlap = opts.overlap ?? 0.08;
  let dpi = safeDpi(opts.dpi);
  for (;;) {
    const { width, height } = await pageSize(pdfPath, page, dpi, rotate);
    const tw = Math.min(width, maxPx);
    const th = Math.min(height, maxPx);
    const cols = width <= tw ? 1 : Math.ceil((width - tw) / (tw * (1 - overlap))) + 1;
    const rows = height <= th ? 1 : Math.ceil((height - th) / (th * (1 - overlap))) + 1;
    if (rows * cols <= RENDER_LIMITS.maxTilesPerPage) return { dpi, width, height, tw, th, cols, rows, count: rows * cols };
    if (dpi < 10) throw new RangeError(`page ${page} needs ${rows * cols} tiles even at ${dpi.toFixed(1)} DPI; limit is ${RENDER_LIMITS.maxTilesPerPage}`);
    dpi *= 0.85;
  }
}

/**
 * Render a page as overlapping tiles no larger than maxPx on either side, so a dense grid can be read
 * at high DPI without the model downscaling it. `maxTiles` (e.g. the caller's remaining budget) is
 * checked against the layout before any pixmap is allocated.
 */
export async function renderTiles(pdfPath: string, page: number, opts: TileOptions & { maxTiles?: number }): Promise<Tile[]> {
  const layout = await tileLayout(pdfPath, page, opts);
  if (opts.maxTiles !== undefined && layout.count > opts.maxTiles)
    throw new RangeError(`page ${page} needs ${layout.count} tiles; only ${opts.maxTiles} left in the budget`);
  const { dpi, width, height, tw, th, cols, rows } = layout;
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = cols === 1 ? 0 : Math.round(((width - tw) * c) / (cols - 1));
      const y0 = rows === 1 ? 0 : Math.round(((height - th) * r) / (rows - 1));
      const box: [number, number, number, number] = [x0, y0, x0 + tw, y0 + th];
      const png = await renderPng(pdfPath, page, { dpi, rotate: opts.rotate ?? 0, clip: box, gray: opts.gray, mask: opts.mask });
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
