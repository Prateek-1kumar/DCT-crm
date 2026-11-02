import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { PageBox } from "@dct/shared";
import { renderPng } from "./render";
import type { TextPage, Word } from "./textlayer";

/**
 * Our own local OCR of pages that have no text (ADR-001 addendum 2026-10-29): PaddleOCR in a Python process with no
 * network (ocr/worker.py), its words put in the space readTextLayer uses, so the binder checks a scan's numbers by
 * position exactly as it checks a born-digital PDF's. The OCR text is contract text: cached next to the PDF
 * it came from, never logged. Anything going wrong leaves the page as a scan (its values asked), never half-read.
 */

/** One word as the OCR worker reports it: pixel box [x0, y0, x1, y1] in the image it read, and its line in that image. */
export type OcrWord = { text: string; conf: number; bbox: [number, number, number, number]; line: number };

/**
 * What the worker read on one page: the image was the page rendered at `dpi`, turned `turned` degrees clockwise (90 for
 * text running bottom to top, 270 for top to bottom: turned, it reads upright). `unread`: pixel boxes of ink no word
 * covers (a stamp, handwriting, text too blurred to read).
 */
export type OcrReading = { words: OcrWord[]; dpi: number; turned: 0 | 90 | 270; unread?: [number, number, number, number][] };

type Rect = Word["rect"];

/**
 * The page with the OCR's words in place of its (missing) text: boxes back in page points, in the page's own frame, and
 * each word's reading direction. Lines that sit close together and overlap across are one block, so sentences don't
 * run from one paragraph or table cell into the next.
 */
export function ocrPage(base: TextPage, r: OcrReading): TextPage {
  const s = 72 / r.dpi;
  const [wpx, hpx] = [base.width / s, base.height / s];
  // turned 90° clockwise, image (u, v) was page (v, H − u); turned 270°, page (W − v, u)
  const back = ([u0, v0, u1, v1]: Rect): Rect =>
    r.turned === 90 ? [v0 * s, (hpx - u1) * s, v1 * s, (hpx - u0) * s] : r.turned === 270 ? [(wpx - v1) * s, u0 * s, (wpx - v0) * s, u1 * s] : [u0 * s, v0 * s, u1 * s, v1 * s];
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
  const dir = r.turned === 90 ? 3 : r.turned === 270 ? 1 : 0;
  const words: Word[] = r.words
    .filter((w) => w.text.trim())
    .map((w) => ({ text: w.text.trim(), rect: back(w.bbox), dir, block: blockOf.get(w.line)!, line: w.line, hidden: false, conf: w.conf }));
  const unread = (r.unread ?? []).map((u): PageBox => {
    const [x0, y0, x1, y1] = back(u);
    return { documentId: base.documentId, page: base.page, box: [x0 / base.width, y0 / base.height, (x1 - x0) / base.width, (y1 - y0) / base.height] };
  });
  return { ...base, source: "ocr", words, hidden: 0, largePicture: false, unread };
}

// ---------- the OCR process ----------

const DPI = 300;
/** A page the worker hasn't answered in this long is given up (a sideways page is read three times). */
const PAGE_TIMEOUT_MS = 180_000;

/** ocr/ in this package, found through its exports like the mupdf worker: a bundle that inlines this module has no ocr/ beside it. */
const OCR_DIR = dirname(createRequire(import.meta.url).resolve("@dct/extraction/ocr-worker"));
const PYTHON = join(OCR_DIR, ".venv/bin/python");
const MANIFEST = join(OCR_DIR, "models.json");

/** Off with SCAN_OCR=0 (the automated tests, which don't install Python); on otherwise. */
export const ocrEnabled = () => process.env.SCAN_OCR !== "0";

/** How to run the worker with no network, or null where this computer can't promise that (then there's no OCR). */
function sandboxed(): string[] | null {
  if (process.platform === "darwin") return ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"];
  if (process.platform === "linux" && spawnSync("unshare", ["-rn", "true"]).status === 0) return ["unshare", "-rn"];
  return null;
}

/** Changes whenever the engine, its settings or its models do, so a cached reading from another engine is never used. */
const engineKey = () => createHash("sha256").update(readFileSync(MANIFEST)).update(readFileSync(join(OCR_DIR, "worker.py"))).update(`dpi=${DPI}`).digest("hex");

type Answer = { id: number; turned?: 0 | 90 | 270; words?: OcrWord[]; unread?: OcrReading["unread"]; error?: string; ready?: boolean; fatal?: string };

/** The worker, started for one read and stopped after it. Its environment holds nothing but PATH: no keys, no database. */
async function startWorker(): Promise<{ ask: (png: Buffer) => Promise<Answer>; stop: () => void } | null> {
  const box = sandboxed();
  if (!box || !existsSync(PYTHON)) return null;
  const [cmd, ...pre] = box;
  const child = spawn(cmd!, [...pre, PYTHON, "-I", join(OCR_DIR, "worker.py"), join(OCR_DIR, "models"), MANIFEST], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "" } });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<number, (a: Answer) => void>();
  let failed: ((a: Answer) => void) | null = null;
  const ready = new Promise<boolean>((res) => (failed = (a) => res(!!a.ready)));
  lines.on("line", (l) => {
    let a: Answer;
    try {
      a = JSON.parse(l) as Answer;
    } catch {
      return;
    }
    if (failed) return (failed(a), (failed = null));
    waiting.get(a.id)?.(a);
    waiting.delete(a.id);
  });
  const dead = () => {
    failed?.({ id: -1, fatal: "exit" });
    for (const [id, f] of waiting) f({ id, error: "exit" });
    waiting.clear();
  };
  child.on("exit", dead);
  child.on("error", dead);
  if (!(await ready)) return (child.kill(), null);
  let n = 0;
  return {
    ask: (png) =>
      new Promise<Answer>((resolve) => {
        const id = n++;
        const timer = setTimeout(() => (waiting.delete(id), resolve({ id, error: "timeout" }), child.kill()), PAGE_TIMEOUT_MS);
        waiting.set(id, (a) => (clearTimeout(timer), resolve(a)));
        child.stdin.write(`${JSON.stringify({ id, png: png.toString("base64") })}\n`);
      }),
    stop: () => child.kill(),
  };
}

/**
 * A synthetic page printed with known words and an amount ("Screening visit fee 1,234.56 due net 45 days"), read before
 * each document, so a broken engine reads nothing. A file, rendered by the mupdf worker: mupdf isn't loaded here.
 */
const SELF_TEST = join(OCR_DIR, "self-test.pdf");
const passes = (a: Answer) => !!a.words?.some((w) => w.text.replace(/[^\d.,]/g, "") === "1,234.56") && a.words.some((w) => /screening/i.test(w.text));

/** One read at a time: the worker holds about 2 GB while it reads (measured), and a small server has room for one. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The OCR'd pages of a PDF in place of its scan pages (image only, or a scanner's own OCR layer, which is never trusted).
 * null when there's no OCR here (switched off, not installed, no sandbox) or it failed its self-test or a page: then the
 * caller keeps the scan pages as they are. Cached next to the PDF, per engine.
 */
export function withOcr(pdfPath: string, pages: TextPage[]): Promise<TextPage[] | null> {
  const run = queue.then(() => ocrDocument(pdfPath, pages));
  queue = run.catch(() => null);
  return run.catch(() => null);
}

async function ocrDocument(pdfPath: string, pages: TextPage[]): Promise<TextPage[] | null> {
  const scans = pages.filter((p) => p.source === "image_only" || p.source === "ocr_layer");
  if (!scans.length) return pages;
  if (!ocrEnabled()) return null;
  const cachePath = `${pdfPath}.ocr.json`;
  const key = engineKey();
  let cache: { key: string; pages: Record<string, OcrReading> } = { key, pages: {} };
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8")) as typeof cache;
    if (c.key === key) cache = c;
  } catch {
    // none yet, or unreadable: read again
  }
  const missing = scans.filter((p) => !cache.pages[p.page]);
  if (missing.length) {
    const w = await startWorker();
    if (!w) return null;
    try {
      if (!passes(await w.ask(await renderPng(SELF_TEST, 1, { dpi: DPI, gray: true })))) return null;
      for (const p of missing) {
        const a = await w.ask(await renderPng(pdfPath, p.page, { dpi: DPI, gray: true }));
        if (!a.words || a.turned === undefined) return null;
        cache.pages[p.page] = { words: a.words, dpi: DPI, turned: a.turned, unread: a.unread ?? [] };
      }
    } finally {
      w.stop();
    }
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, cachePath);
  }
  return pages.map((p) => (cache.pages[p.page] && (p.source === "image_only" || p.source === "ocr_layer") ? ocrPage(p, cache.pages[p.page]!) : p));
}
