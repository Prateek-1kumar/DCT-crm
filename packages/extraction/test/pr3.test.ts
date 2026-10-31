import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planBands } from "../src/bands";
import { CONFIG, ExtractionLimitError, extractWith, type InputDoc } from "../src/extract";
import { type Image, type LlmClient, type LlmRequest, tokenText } from "../src/llm";
import { AiGrids, AiGridsAnchored, type AiGrid, type AiTerms, gridPrompt, termsPrompt } from "../src/prompts";
import { bandPixels, renderBands, renderPng, uprightFrame } from "../src/render";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// ADR-002 PR 3 (EXTRACTION_BANDS, EXTRACTION_TOKEN_MAP): synthetic PDFs, mocked clients, no AI.

const ROWS = 30;
const BANK = "Payee bank ABA routing 021000021, account 123456789.";
/** A budget table printed as text: a title, a heading line, ROWS rows of a label and four unique amounts, then a bank sentence. */
function tablePdf(rows = ROWS): string {
  const doc = new mupdf.PDFDocument();
  const res = { Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) } };
  const at = (x: number, y: number, t: string) => `BT /F1 8 Tf ${x} ${y} Td (${t}) Tj ET\n`;
  let c = at(40, 750, "Study budget worksheet") + [0, 1, 2, 3].map((k) => at(200 + 70 * k, 730, `V${k + 1}`)).join("") + at(40, 730, "Procedure");
  for (let r = 0; r < rows; r++) c += at(40, 710 - 14 * r, `Item ${r + 1}`) + [0, 1, 2, 3].map((k) => at(200 + 70 * k, 710 - 14 * r, (100 + r * 7 + k * 3 + 0.25).toFixed(2))).join("");
  c += at(40, 710 - 14 * rows - 20, BANK);
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, c));
  const path = join(mkdtempSync(join(tmpdir(), "dct-pr3-")), "table.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

/** Pages with no text at all (a scan with no OCR here), and the rest of the page budget tests. */
function blankPdf(pages: number, size: [number, number] = [612, 792]): string {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) doc.insertPage(-1, doc.addPage([0, 0, size[0], size[1]], 0, {}, "0 0 0 rg 10 10 50 50 re f"));
  const path = join(mkdtempSync(join(tmpdir(), "dct-pr3-")), "blank.pdf");
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
  return path;
}

const opts = { rows: 12, bodyPx: 600, dpi: 400, maxPx: 3500, viewPx: 2576, maxPixels: 3_600_000, minWordPx: 14 };
const pixels = (png: Buffer) => {
  const pix = new mupdf.Image(png).toPixmap();
  return { w: pix.getWidth(), h: pix.getHeight(), stride: pix.getStride(), px: new Uint8Array(pix.getPixels()) }; // a copy: mupdf frees its own
};
const rowsOf = (p: ReturnType<typeof pixels>, y0: number, y1: number) => Buffer.from(p.px.subarray(y0 * p.stride, y1 * p.stride));

describe("row bands: geometry", () => {
  const path = tablePdf();
  it("cuts between lines: every row is in exactly one band, none is cut, and the header is above the first amount", async () => {
    const [page] = await readTextLayer(path, "d1");
    const frame = await uprightFrame(path, 1, 0);
    const plan = planBands(page!.words, frame.to, frame, opts);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.bands.length).toBeGreaterThan(1);
    expect(plan.bands.length).toBeGreaterThanOrEqual(Math.ceil(ROWS / 12)); // at most 12 rows a band (and at most bodyPx tall, below)
    const words = page!.words.map((w) => ({ t: w.text, r: frame.to(w.rect) }));
    // the header holds the title and the heading line, not a row
    const inHeader = words.filter((w) => w.r[3] <= plan.header[1]).map((w) => w.t);
    expect(inHeader).toEqual(expect.arrayContaining(["Study", "V1", "Procedure"]));
    expect(inHeader).not.toContain("Item");
    // bands follow the header and each other with no gap and no overlap
    expect(plan.bands[0]![0]).toBe(plan.header[1]);
    for (let i = 1; i < plan.bands.length; i++) expect(plan.bands[i]![0]).toBe(plan.bands[i - 1]![1]);
    // each row's words sit inside one band, and no word is cut by an edge
    for (let r = 1; r <= ROWS; r++) {
      const label = words.filter((w) => w.t === String(r))[0]!;
      const inBands = plan.bands.filter(([a, b]) => label.r[1] >= a && label.r[3] <= b);
      expect(inBands).toHaveLength(1);
    }
    for (const w of words.filter((x) => x.r[1] >= plan.header[1]))
      for (const [a, b] of plan.bands) {
        expect(a > w.r[1] && a < w.r[3]).toBe(false);
        expect(b > w.r[1] && b < w.r[3]).toBe(false);
      }
  });

  it("composes the header into every band: the top strip is the same pixels in each, and the rest is the page's own rows", async () => {
    const [page] = await readTextLayer(path, "d1");
    const frame = await uprightFrame(path, 1, 0);
    const plan = planBands(page!.words, frame.to, frame, opts);
    if (typeof plan === "string") throw new Error(plan);
    const px = bandPixels(plan);
    const hh = px.header[1] - px.header[0];
    const pngs = await renderBands(path, 1, { plan, rotate: 0, gray: true });
    expect(pngs).toHaveLength(plan.bands.length);
    const header = pixels(await renderPng(path, 1, { dpi: plan.dpi, gray: true, clip: [px.x[0], px.header[0], px.x[1], px.header[1]] }));
    const tops = pngs.map((png) => pixels(png));
    for (const [i, t] of tops.entries()) {
      expect(t.w).toBe(px.x[1] - px.x[0]);
      expect(rowsOf(t, 0, hh).equals(rowsOf(header, 0, hh))).toBe(true); // identical in every band, and the page's own heading
      const [y0, y1] = px.bands[i]!;
      expect(t.h).toBe(hh + y1 - y0);
      const body = pixels(await renderPng(path, 1, { dpi: plan.dpi, gray: true, clip: [px.x[0], y0, px.x[1], y1] }));
      expect(rowsOf(t, hh, t.h).equals(rowsOf(body, 0, body.h))).toBe(true); // the rows are drawn as the page draws them
    }
    expect(rowsOf(tops[0]!, hh, hh + 40).equals(rowsOf(tops[1]!, hh, hh + 40))).toBe(false); // bands differ below it
  });

  it("paints bank details black in a band as in any other image", async () => {
    const [page] = await readTextLayer(path, "d1");
    const frame = await uprightFrame(path, 1, 0);
    const plan = planBands(page!.words, frame.to, frame, opts);
    if (typeof plan === "string") throw new Error(plan);
    const account = page!.words.find((w) => w.text === "123456789.")!;
    const mask = [account.rect];
    const last = pixels((await renderBands(path, 1, { plan, rotate: 0, gray: true, mask })).at(-1)!);
    const [x0, y0, x1, y1] = frame.to(account.rect).map((v) => (v * plan.dpi) / 72);
    const px = bandPixels(plan);
    const top = px.header[1] - px.header[0] + (y0! - px.bands.at(-1)![0]);
    for (let y = Math.ceil(top) + 1; y < top + (y1! - y0!) - 1; y++) for (let x = Math.ceil(x0! - px.x[0]) + 1; x < x1! - px.x[0] - 1; x++) expect(last.px[y * last.stride + x]).toBeLessThan(10);
  });

  it("cuts bands of at most bodyPx of rows where the rows allow, and a band is as wide as the table up to maxPx, one DPI throughout", async () => {
    const [page] = await readTextLayer(path, "d1");
    const frame = await uprightFrame(path, 1, 0);
    const plan = planBands(page!.words, frame.to, frame, opts);
    if (typeof plan === "string") throw new Error(plan);
    expect((plan.x[1] - plan.x[0]) * (plan.dpi / 72)).toBeLessThanOrEqual(3500 + plan.dpi / 72);
    for (const [a, b] of plan.bands) expect(((b - a) * plan.dpi) / 72).toBeLessThanOrEqual(600);
    // a smaller budget cuts more, thinner bands; one no band can meet (under a row) falls back to the pixel budget alone
    const thin = planBands(page!.words, frame.to, frame, { ...opts, bodyPx: 300 });
    if (typeof thin === "string") throw new Error(thin);
    expect(thin.bands.length).toBeGreaterThan(plan.bands.length);
    const tall = planBands(page!.words, frame.to, frame, { ...opts, bodyPx: 1 });
    expect(typeof tall).toBe("object");
  });

  it("counts a word's height as the model sees it: a band wider than viewPx is shrunk by the provider, so the same print needs a bigger render", async () => {
    const [page] = await readTextLayer(path, "d1");
    const frame = await uprightFrame(path, 1, 0);
    const plan = planBands(page!.words, frame.to, frame, opts);
    if (typeof plan === "string") throw new Error(plan);
    const wordPx = (plan.dpi / 72) * 9; // the table is set in 9 pt
    const widthPx = ((plan.x[1] - plan.x[0]) * plan.dpi) / 72;
    const seen = Math.min(1, 2576 / widthPx);
    expect(planBands(page!.words, frame.to, frame, { ...opts, minWordPx: Math.floor(wordPx * seen * 0.8) })).toMatchObject({ dpi: plan.dpi });
    expect(planBands(page!.words, frame.to, frame, { ...opts, minWordPx: Math.ceil(wordPx * seen * 1.5) })).toBe("size");
  });

  it("says why a page can't be banded: no words, no header above the first amount, or print too small for the width", async () => {
    const frame = { width: 612, height: 792 };
    expect(planBands([], (r) => r, frame, opts)).toBe("rows");
    const [page] = await readTextLayer(path, "d1");
    const f = await uprightFrame(path, 1, 0);
    const noHeader = page!.words.filter((w) => !/^(Study|budget|worksheet|Procedure|V\d)$/.test(w.text));
    expect(planBands(noHeader, f.to, f, opts)).toBe("rows");
    expect(planBands(page!.words, f.to, f, { ...opts, minWordPx: 400 })).toBe("size");
  });
});

// ---------------------------------------------------------------- the read

type Call = { name: string; prompt: string; images: Image[]; schema: unknown };
function mock(rb: Rulebook, calls: Call[], grid?: (req: LlmRequest<unknown>) => unknown): LlmClient {
  let n = 0;
  const gridOf = (): AiGrid => {
    const { id, ...g } = rb.budgetGrids[0]!;
    return { ...g, procedures: g.procedures.map((p) => ({ ...p, cells: Object.entries(p.cells).map(([visit, value]) => ({ visit, value })) })) };
  };
  return {
    provider: "anthropic",
    model: "mock",
    cost: () => ({ provider: "anthropic", model: "mock", inputTokens: 0, outputTokens: 0, usd: n * 0.01 }),
    async call<T>(req: LlmRequest<T>): Promise<T> {
      n++;
      calls.push({ name: req.name, prompt: req.prompt, images: req.images, schema: req.schema });
      const { schemaVersion, budgetGrids, governingGridId, ...t } = rb;
      const out =
        req.name === "classify"
          ? { pages: [{ page: 1, kind: "budget_grid", readable: true, rotation: 0, gridGroup: "Exhibit A" }] }
          : req.name.startsWith("terms")
            ? ({ ...t, notes: [] } satisfies AiTerms)
            : req.name === "grid"
              ? (grid?.(req as LlmRequest<unknown>) ?? { grids: [gridOf()] })
              : {};
      return req.schema.parse(out);
    },
  };
}

const input = (path: string): InputDoc[] => [{ id: "d1", filename: "table.pdf", path, kind: null }];
const saved = { maxUsd: CONFIG.maxUsd, bands: CONFIG.bands, tokenMap: CONFIG.tokenMap, tiles: CONFIG.maxTilesPerExtraction, images: CONFIG.maxImagesPerExtraction };
beforeEach(() => Object.assign(CONFIG, { maxUsd: 100 }));
afterEach(() => Object.assign(CONFIG, { maxUsd: saved.maxUsd, bands: saved.bands, tokenMap: saved.tokenMap, maxTilesPerExtraction: saved.tiles, maxImagesPerExtraction: saved.images }));
const readOf = async (path: string, calls: Call[], grid?: Parameters<typeof mock>[2]) => extractWith({ documents: input(path) }, { primary: mock(makeRulebook(), calls, grid), cross: null });

describe("the switches are off by default, and then nothing changes", () => {
  it("defaults off, with the tile limit at 120", () => {
    expect(saved.bands).toBe(false);
    expect(saved.tokenMap).toBe(false);
    expect(saved.tiles).toBe(120);
  });

  it("sends tiles, no token map and today's prompts and schema", async () => {
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls);
    const grid = calls.find((c) => c.name === "grid")!;
    expect(grid.images.some((i) => i.label.includes("tile"))).toBe(true); // a letter page at 400 DPI is tiles today
    expect(grid.images.every((i) => !i.tokens && !/band/.test(i.label))).toBe(true);
    for (const c of calls) expect(c.images.every((i) => !i.tokens)).toBe(true);
    expect(grid.prompt).toBe(gridPrompt("d1", [1], true));
    expect(grid.prompt).not.toMatch(/TOKEN|band/);
    expect(grid.schema).toBe(AiGrids);
    expect(calls.find((c) => c.name === "terms")!.prompt).toBe(termsPrompt(input("x"), "study"));
    expect(out.anchors).toBeUndefined();
    expect(out.warnings.map((w) => w.kind)).toEqual(["cross_read_off"]);
  });

  it("an image with no tokens is the same request as before: tokenText is only added when there are some", () => {
    expect(tokenText([{ id: "0.1.2", text: "$1.00", box: [1, 2, 3, 4] }])).toContain('[["0.1.2","$1.00",1,2,3,4]]');
  });
});

describe("row bands in a read (EXTRACTION_BANDS=1)", () => {
  it("sends the page as bands, with the header on each, and a prompt that says so", async () => {
    CONFIG.bands = true;
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls);
    const grid = calls.find((c) => c.name === "grid")!;
    const labels = grid.images.map((i) => i.label);
    expect(labels[0]).toBe("documentId d1, page 1, overview");
    const bands = labels.filter((l) => l.includes("band"));
    expect(bands.length).toBeGreaterThan(1);
    expect(labels.some((l) => l.includes("tile"))).toBe(false);
    expect(grid.prompt).toContain("row bands");
    expect(grid.prompt).not.toContain("tiles");
    expect(out.warnings.some((w) => w.kind === "bands_fallback")).toBe(false);
    // the header is the same pixels on top of every band
    const tops = grid.images.slice(1).map((i) => pixels(i.png));
    const strip = (t: (typeof tops)[number]) => rowsOf(t, 0, 20);
    for (const t of tops) expect(strip(t).equals(strip(tops[0]!))).toBe(true);
  });

  it("charges bands to the tile and image budgets before rendering anything, with the overview", async () => {
    CONFIG.bands = true;
    const calls: Call[] = [];
    await readOf(tablePdf(), calls);
    const n = calls.find((c) => c.name === "grid")!.images.filter((i) => i.label.includes("band")).length;
    CONFIG.maxTilesPerExtraction = n - 1;
    const none: Call[] = [];
    await expect(readOf(tablePdf(), none)).rejects.toThrow(new RegExp(`more than ${n - 1} grid image tiles`));
    expect(none.map((c) => c.name)).toEqual(["classify"]); // nothing was read after the cap tripped
    CONFIG.maxTilesPerExtraction = saved.tiles;
    CONFIG.maxImagesPerExtraction = 1 + 1 + n; // classification, the terms page; the overview is the one over
    await expect(readOf(tablePdf(), [])).rejects.toThrow(ExtractionLimitError);
  });

  it("falls back to tiles for a page with no words, and says so in a warning", async () => {
    CONFIG.bands = true;
    const calls: Call[] = [];
    const out = await readOf(blankPdf(1, [1500, 1500]), calls);
    const grid = calls.find((c) => c.name === "grid")!;
    expect(grid.images.some((i) => i.label.includes("tile"))).toBe(true);
    expect(grid.images.some((i) => i.label.includes("band"))).toBe(false);
    const w = out.warnings.find((x) => x.kind === "bands_fallback")!;
    expect(w.kind === "bands_fallback" && w.pages).toEqual([{ documentId: "d1", filename: "table.pdf", page: 1, why: "rows" }]);
    expect(JSON.stringify(w)).not.toMatch(/Item|V1/);
  });
});

describe("tile limits", () => {
  it("allow a 45-page document with 20 grid pages (120 tiles + 20 overviews inside the 300-image budget)", async () => {
    const path = blankPdf(45);
    const calls: Call[] = [];
    const client = mock(makeRulebook(), calls);
    const call = client.call.bind(client);
    // pages 1, 3, ..., 39 are grids (never consecutive, so each is its own grid); the rest are terms
    client.call = (req) =>
      req.name === "classify"
        ? Promise.resolve(req.schema.parse({ pages: Array.from({ length: 45 }, (_, i) => ({ page: i + 1, kind: i < 40 && i % 2 === 0 ? "budget_grid" : "terms", readable: true, rotation: 0, gridGroup: i < 40 && i % 2 === 0 ? `Arm ${i}` : null })) }) as never)
        : call(req);
    await extractWith({ documents: [{ id: "d1", filename: "big.pdf", path, kind: null }] }, { primary: client, cross: null });
    const grids = calls.filter((c) => c.name === "grid");
    expect(grids).toHaveLength(20);
    expect(grids.flatMap((g) => g.images).filter((i) => i.label.includes("tile"))).toHaveLength(120);
    expect(45 + 45 + 120 + 20).toBeLessThanOrEqual(CONFIG.maxImagesPerExtraction);
  }, 180_000);

  it("refuse the 121st tile in plain words", async () => {
    CONFIG.maxTilesPerExtraction = 5;
    await expect(readOf(blankPdf(1), [])).rejects.toThrow(/This read needs more than 5 grid image tiles, the limit for one read\. Split the upload into smaller PDFs\./);
  });
});

describe("token map (EXTRACTION_TOKEN_MAP=1)", () => {
  const ids = (calls: Call[], name: string) => calls.filter((c) => c.name === name).flatMap((c) => c.images.flatMap((i) => i.tokens ?? []));

  it("goes with the grid images only, never a terms page, without the bank details, and its prompts say the image is the truth", async () => {
    CONFIG.tokenMap = true;
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls);
    expect(ids(calls, "terms")).toEqual([]);
    const all = ids(calls, "grid");
    expect(all.length).toBeGreaterThan(100);
    const texts = all.map((t) => t.text);
    expect(texts).toContain("V1");
    expect(texts.some((t) => /021000021|123456789/.test(t))).toBe(false);
    expect(texts).toContain("account"); // the words around them stay, as they do in the image
    expect(ids(calls, "classify")).toEqual([]);
    for (const t of all) expect(t.id).toMatch(/^0\.1\.\d+$/);
    const grid = calls.find((c) => c.name === "grid")!;
    expect(grid.prompt).toMatch(/TOKEN MAP/);
    expect(grid.prompt).toMatch(/image is the truth/);
    expect(grid.prompt).toMatch(/source_token_id/);
    expect(grid.schema).toBe(AiGridsAnchored);
    for (const c of calls.filter((x) => x.name.startsWith("terms"))) expect(c.prompt).not.toMatch(/TOKEN MAP|source_token_id/);
    expect(out.anchors).toEqual([]); // the mock named none
  });

  it("keeps a cell's token id that is in that call's map and drops one that is not; the rulebook is unchanged", async () => {
    CONFIG.tokenMap = true;
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls, (req) => {
      const known = req.images.flatMap((i) => i.tokens ?? []);
      const real = known.find((t) => /^\d+\.\d\d$/.test(t.text))!.id;
      const g = makeRulebook().budgetGrids[0]!;
      const cells = (p: (typeof g.procedures)[number]) => Object.entries(p.cells).map(([visit, value], k) => ({ visit, value, ...(p.code === "99205" ? { source_token_id: k === 0 ? real : "9.9.9" } : {}) }));
      return { grids: [{ ...g, id: undefined, procedures: g.procedures.map((p) => ({ ...p, cells: cells(p) })), visitTokens: [{ visit: "V1", field: "total", source_token_id: real }, { visit: "V2", field: "total", source_token_id: "nope" }] }] };
    });
    const real = out.anchors!;
    expect(real.map((a) => [a.field, a.visit, a.procedure])).toEqual([["cell", "V1", 0], ["total", "V1", null]]);
    expect(real.every((a) => /^0\.1\.\d+$/.test(a.tokenId))).toBe(true);
    expect(Rulebook.parse(out.rulebook).budgetGrids[0]!.procedures[0]!.cells).toEqual({ V1: 30000, V2: 30000 });
    expect(JSON.stringify(out.rulebook)).not.toMatch(/source_token_id|visitTokens/);
  });

  it("puts a band's header tokens on every band and each row's tokens on one band only", async () => {
    CONFIG.tokenMap = true;
    CONFIG.bands = true;
    const calls: Call[] = [];
    await readOf(tablePdf(), calls);
    const bands = calls.find((c) => c.name === "grid")!.images.filter((i) => i.label.includes("band"));
    const idOf = (i: Image, text: string) => i.tokens!.filter((t) => t.text === text).map((t) => t.id);
    const v1 = bands.map((b) => idOf(b, "V1"));
    expect(v1.every((x) => x.length === 1 && x[0] === v1[0]![0])).toBe(true); // same id, in each band's header strip
    for (const t of bands.flatMap((b) => b.tokens!.filter((x) => x.text === "V1"))) expect(t.box[1]).toBeLessThan(150);
    const row = bands.flatMap((b) => idOf(b, "Item")); // one "Item" word per row: rows + one header-free copy of each
    expect(new Set(row).size).toBe(ROWS);
    expect(row).toHaveLength(ROWS);
    // every token's box is inside its image
    for (const b of bands) {
      const [w, h] = [b.png.readUInt32BE(16), b.png.readUInt32BE(20)];
      for (const t of b.tokens!) expect(t.box[0] >= -2 && t.box[1] >= -2 && t.box[2] <= w + 2 && t.box[3] <= h + 2).toBe(true);
    }
  });

  it("never puts token text in a warning", async () => {
    CONFIG.tokenMap = true;
    CONFIG.bands = true;
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls);
    const words = new Set(ids(calls, "grid").map((t) => t.text).filter((t) => /\d/.test(t)));
    const said = JSON.stringify(out.warnings);
    for (const w of words) expect(said).not.toContain(w);
  });
});
