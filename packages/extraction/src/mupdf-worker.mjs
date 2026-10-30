// Every mupdf call on a PDF runs here, in a worker thread (see render.ts `call`): a page that takes minutes to draw
// (a crafted content stream) then costs a timeout and this worker, never the server's event loop.
// Plain JS on purpose: Node runs it as is, under tsx, vitest or a build, with no TypeScript loader.
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import * as mupdf from "mupdf";

// ponytail: LRU of open documents by Map order; raise if the viewer jumps between more PDFs than this.
const MAX_DOCS = 8;
const docs = new Map();

function open(path) {
  let doc = docs.get(path);
  if (doc) docs.delete(path);
  else doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf");
  docs.set(path, doc);
  for (const [k, d] of docs) {
    if (docs.size <= MAX_DOCS) break;
    docs.delete(k);
    d.destroy();
  }
  return doc;
}

function loadPage(path, page) {
  const doc = open(path);
  const n = doc.countPages();
  if (!Number.isInteger(page) || page < 1 || page > n) throw new RangeError(`Page ${page} is out of range (1–${n}).`);
  return doc.loadPage(page - 1);
}

function withPage(path, page, fn) {
  const p = loadPage(path, page);
  try {
    return fn(p);
  } finally {
    p.destroy();
  }
}

const union = (rs) => [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
const area = ([x0, y0, x1, y1]) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
const touch = (a, b) => a[0] <= b[2] + 1 && b[0] <= a[2] + 1 && a[1] <= b[3] + 1 && b[1] <= a[3] + 1;

/**
 * Pictures on a text page (TextPage.largePicture): image blocks merged where they touch (a picture saved in strips),
 * each large unless visible text covers 5% of it or more (a background under the page's own text). Measured on the COPD
 * original: signatures and logos are 0.3–1.7% of the page each; a pasted table of a few rows is 5% or more.
 * ponytail: a pasted table under 5% of the page, or under 15% in the top or bottom tenth, isn't found. Upgrade: compare
 * the page render with its text.
 */
function largePicture(images, chars, [px0, py0, px1, py1]) {
  const regions = [];
  for (let r of images) {
    for (let i = regions.findIndex((x) => touch(x, r)); i >= 0; i = regions.findIndex((x) => touch(x, r))) r = union([r, ...regions.splice(i, 1)]);
    regions.push(r);
  }
  const page = (px1 - px0) * (py1 - py0);
  return regions.some((r) => {
    const mid = ((r[1] + r[3]) / 2 - py0) / (py1 - py0);
    const text = chars.reduce((n, q) => n + area([Math.max(q[0], r[0]), Math.max(q[1], r[1]), Math.min(q[2], r[2]), Math.min(q[3], r[3])]), 0);
    return area(r) >= (mid > 0.1 && mid < 0.9 ? 0.05 : 0.15) * page && text < 0.05 * area(r);
  });
}

const MIN_RULE = 5;
const MIN_DRAWN_FILLS = 300;
const MAX_RULES = 20000;
const tf = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** A path's subpaths as point lists in page points; one with a curve is a glyph or a shape, not a rule, and is dropped. */
function subpaths(path, ctm) {
  const out = [];
  let cur = [];
  let curved = false;
  const end = () => {
    if (cur.length && !curved) out.push(cur);
    cur = [];
    curved = false;
  };
  path.walk({
    moveTo: (x, y) => {
      end();
      cur.push(tf(ctm, x, y));
    },
    lineTo: (x, y) => void cur.push(tf(ctm, x, y)),
    curveTo: () => void (curved = true),
    closePath: () => void (cur.length && cur.push(cur[0])),
  });
  end();
  return out;
}

/** Rule segments of one drawn path: the straight sides of a stroke, or a thin filled rectangle (a rule drawn as a shape). */
function addRules(rules, path, ctm, stroked) {
  // a crafted page can't grow this without bound: collecting stops past the cap (gridsOf then finds no table)
  if (rules.length > MAX_RULES) return;
  for (const sp of subpaths(path, ctm)) {
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [x, y] of sp) [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    if (stroked) {
      for (let i = 1; i < sp.length; i++) {
        const [[ax, ay], [bx, by]] = [sp[i - 1], sp[i]];
        if (Math.abs(ay - by) < 0.5 && Math.abs(ax - bx) > MIN_RULE) rules.push({ dir: "h", at: ay, from: Math.min(ax, bx), to: Math.max(ax, bx) });
        else if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) > MIN_RULE) rules.push({ dir: "v", at: ax, from: Math.min(ay, by), to: Math.max(ay, by) });
      }
    } else if (sp.length <= 6 && sp.every(([x, y]) => (Math.abs(x - x0) < 0.1 || Math.abs(x - x1) < 0.1) && (Math.abs(y - y0) < 0.1 || Math.abs(y - y1) < 0.1))) {
      // a rectangle: four corners, closed back to the first (the last side drawn out or by closePath), corners to 0.1 pt
      if (y1 - y0 < 1.5 && x1 - x0 > MIN_RULE) rules.push({ dir: "h", at: (y0 + y1) / 2, from: x0, to: x1 });
      else if (x1 - x0 < 1.5 && y1 - y0 > MIN_RULE) rules.push({ dir: "v", at: (x0 + x1) / 2, from: y0, to: y1 });
    }
  }
}

/** Positions of one direction's rules, within 1 pt merged, each kept only if its segments cover at least 30% of `extent`. */
function positions(rules, extent) {
  const out = [];
  const sorted = [...rules].sort((a, b) => a.at - b.at);
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].at - sorted[j - 1].at <= 1) j++;
    const group = sorted.slice(i, j).sort((a, b) => a.from - b.from);
    let covered = 0;
    let end = -Infinity;
    for (const r of group) {
      covered += Math.max(0, r.to - Math.max(r.from, end));
      end = Math.max(end, r.to);
    }
    if (covered >= 0.3 * extent) out.push(group.reduce((s, r) => s + r.at, 0) / group.length);
    i = j;
  }
  return out;
}

/**
 * The ruled tables on a page (TextPage.grids): segments that touch within 2 pt are one table; a table needs 3 vertical
 * and 3 horizontal rule positions. Everything is in page points, so a table drawn sideways comes out upright.
 * ponytail: touching is tested pairwise (quadratic), so a page with more than MAX_RULES segments gets none. Upgrade: sort
 * and sweep.
 */
function gridsOf(rules) {
  if (rules.length > MAX_RULES) return [];
  const root = rules.map((_, i) => i);
  const find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
  const near = (a, b) =>
    a.dir === b.dir
      ? Math.abs(a.at - b.at) <= 1 && a.from <= b.to + 2 && b.from <= a.to + 2
      : a.at >= b.from - 2 && a.at <= b.to + 2 && b.at >= a.from - 2 && b.at <= a.to + 2;
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) if (near(rules[i], rules[j])) root[find(i)] = find(j);
  const tables = new Map();
  rules.forEach((r, i) => tables.set(find(i), [...(tables.get(find(i)) ?? []), r]));
  const out = [];
  for (const t of tables.values()) {
    const [h, v] = [t.filter((r) => r.dir === "h"), t.filter((r) => r.dir === "v")];
    if (!h.length || !v.length) continue;
    const width = Math.max(...h.map((r) => r.to)) - Math.min(...h.map((r) => r.from));
    const height = Math.max(...v.map((r) => r.to)) - Math.min(...v.map((r) => r.from));
    const [xs, ys] = [positions(v, height), positions(h, width)];
    if (xs.length >= 3 && ys.length >= 3) out.push({ box: [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]], xs, ys });
  }
  return out.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/** One page of the PDF's own text; see textlayer.ts (TextPage, Word) for the shape and the rules. */
function textPage(page, documentId, n, minVisiblePt, minPageText) {
  const [px0, py0, px1, py1] = page.getBounds();
  // Invisible render mode (3 Tr) reaches a device as ignoreText; structured text keeps it as plain black text.
  // ponytail: glyphs matched to chars by origin on a 0.5 pt grid. Upgrade: compare the render under each word.
  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const invisible = new Set();
  // The same run collects the page's rules and counts its filled paths: text turned to outlines is thousands of them.
  const rules = [];
  let fills = 0;
  const dev = new mupdf.Device({
    fillPath: (path, _eo, ctm) => {
      fills++;
      addRules(rules, path, ctm, false);
    },
    strokePath: (path, _stroke, ctm) => addRules(rules, path, ctm, true),
    ignoreText: (text, m) => text.walk({ showGlyph: (_f, t) => void invisible.add(key(t[4] * m[0] + t[5] * m[2] + m[4], t[4] * m[1] + t[5] * m[3] + m[5])) }),
  });
  page.run(dev, mupdf.Matrix.identity);
  dev.close();
  dev.destroy();

  const words = [];
  const [images, seen] = [[], []];
  let [chars, imageArea, block, line, dir] = [0, 0, -1, -1, 0];
  let cur = null;
  const flush = () => {
    if (cur) words.push({ ...cur, dir, block, line });
    cur = null;
  };
  const st = page.toStructuredText("preserve-images,clip=no");
  st.walk({
    onImageBlock: ([x0, y0, x1, y1]) => {
      const r = [Math.max(x0, px0), Math.max(y0, py0), Math.min(x1, px1), Math.min(y1, py1)];
      imageArea = Math.max(imageArea, area(r));
      if (area(r) > 0) images.push(r);
    },
    beginTextBlock: () => void block++,
    beginLine: (_b, _w, [dx, dy]) => {
      line++;
      dir = (Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) + 4) % 4;
    },
    onChar: (c, [ox, oy], _font, size, q, color) => {
      if (!c.trim()) return flush();
      chars++;
      const r = [Math.min(q[0], q[2], q[4], q[6]), Math.min(q[1], q[3], q[5], q[7]), Math.max(q[0], q[2], q[4], q[6]), Math.max(q[1], q[3], q[5], q[7])];
      // ponytail: white means white fill; white text on a dark box is visible but flagged. Upgrade: sample the render under the glyph.
      const hidden = size < minVisiblePt || color.every((v) => v > 0.95) || ox < px0 || ox > px1 || oy < py0 || oy > py1 || invisible.has(key(ox, oy));
      if (!hidden) seen.push(r);
      cur ??= { text: "", rect: r, hidden: false };
      cur.text += c;
      cur.rect = union([cur.rect, r]);
      cur.hidden ||= hidden;
    },
    endLine: flush,
  });
  st.destroy();
  const [width, height] = [px1 - px0, py1 - py0];
  // ponytail: a genuine text page under minPageText characters reads as image_only, so it goes to page attestation.
  const source = chars < minPageText ? "image_only" : imageArea > 0.8 * width * height ? "ocr_layer" : "text";
  // ponytail: "few characters, many filled paths, no big picture"; vector art with no text passes too and is read as a scan.
  const drawn = chars < minPageText && fills >= MIN_DRAWN_FILLS && imageArea <= 0.5 * width * height;
  return { documentId, page: n, width, height, source, words, hidden: words.filter((w) => w.hidden).length, largePicture: source === "text" && largePicture(images, seen, [px0, py0, px1, py1]), drawn, grids: gridsOf(rules) };
}

const ops = {
  openDocuments: () => docs.size,
  // A /Count that claims more pages than the page tree holds is corrected once mupdf loads a page, so load one first:
  // the upload's count is then the read's, and the page viewer's.
  count: (path) => {
    const doc = open(path);
    if (doc.countPages() > 0) doc.loadPage(0).destroy();
    return doc.countPages();
  },
  bounds: (path, page) => withPage(path, page, (p) => p.getBounds()),
  text: (path, page) => withPage(path, page, (p) => p.toStructuredText("preserve-whitespace").asText()),
  textPage: (path, page, documentId, minVisiblePt, minPageText) => withPage(path, page, (p) => textPage(p, documentId, page, minVisiblePt, minPageText)),
  /** PNG of `box` (output pixels) drawn through `m`; `mask` rects (page points) are painted black over the drawing. */
  render: (path, page, m, box, gray, mask) =>
    withPage(path, page, (p) => {
      const pix = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, box, false);
      try {
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        p.run(dev, m);
        if (mask.length) {
          const shape = new mupdf.Path();
          for (const [x0, y0, x1, y1] of mask) shape.rect(x0, y0, x1, y1);
          dev.fillPath(shape, false, m, mupdf.ColorSpace.DeviceGray, [0], 1);
          shape.destroy();
        }
        dev.close();
        dev.destroy();
        return pix.asPNG().slice();
      } finally {
        pix.destroy();
      }
    }),
};

parentPort.on("message", ({ op, args }) => {
  try {
    parentPort.postMessage({ result: ops[op](...args) });
  } catch (e) {
    parentPort.postMessage({ error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
  }
});
