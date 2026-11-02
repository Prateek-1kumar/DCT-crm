import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rulebook } from "@dct/shared";
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG, ExtractionLimitError, extractWith, type InputDoc } from "../src/extract";
import { type Image, type LlmClient, type LlmRequest, tokenText } from "../src/llm";
import { AiGrids, AiGridsAnchored, type AiGrid, type AiTerms, gridPrompt, termsPrompt } from "../src/prompts";
import { renderPng, uprightFrame } from "../src/render";
import { readTextLayer } from "../src/textlayer";
import { makeRulebook } from "./helpers";

// ADR-002 PR 3 (EXTRACTION_TOKEN_MAP; the row bands were removed, ADR-003 C3): synthetic PDFs, mocked clients, no AI.

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

// ---------------------------------------------------------------- the read

type Call = { name: string; prompt: string; images: Image[]; schema: unknown };
function mock(rb: Rulebook, calls: Call[], grid?: (req: LlmRequest<unknown>) => unknown): LlmClient {
  let n = 0;
  const gridOf = (): AiGrid => {
    const { id, ...g } = rb.budgetGrids[0]!;
    return { ...g, procedures: g.procedures.map((p) => ({ ...p, cells: Object.entries(p.cells).map(([visit, value]) => ({ visit, value, source_token_id: null })) })) };
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
const saved = { maxUsd: CONFIG.maxUsd, tokenMap: CONFIG.tokenMap, tiles: CONFIG.maxTilesPerExtraction, images: CONFIG.maxImagesPerExtraction };
beforeEach(() => Object.assign(CONFIG, { maxUsd: 100 }));
afterEach(() => Object.assign(CONFIG, { maxUsd: saved.maxUsd, tokenMap: saved.tokenMap, maxTilesPerExtraction: saved.tiles, maxImagesPerExtraction: saved.images }));
const readOf = async (path: string, calls: Call[], grid?: Parameters<typeof mock>[2]) => extractWith({ documents: input(path) }, { primary: mock(makeRulebook(), calls, grid), cross: null });

describe("the switches are off by default, and then nothing changes", () => {
  it("defaults off, with the tile limit at 120", () => {
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
    // a number goes as its shape (every digit a "#"), a word without one as it is; a line of the image is one entry, left to right
    const map = tokenText([{ id: "0.1.2", text: "$1.00", box: [50, 2, 80, 14] }, { id: "0.1.3", text: "Visit", box: [10, 3, 40, 15] }, { id: "0.1.4", text: "V2", box: [90, 2, 100, 14] }, { id: "0.1.5", text: "$12.50", box: [50, 40, 80, 52] }]);
    expect(map).toContain('[[2,15,["0.1.3","Visit",10,40],["0.1.2","$#.##",50,80],["0.1.4","V#",90,100]],[40,52,["0.1.5","$##.##",50,80]]]');
    expect(map).not.toMatch(/1\.00|12\.50/);
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

  it("goes with the grid images only, never a terms page, without the bank details, and its prompts say to read every figure from the image", async () => {
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
    expect(grid.prompt).toMatch(/never from the map/);
    expect(grid.prompt).toMatch(/nonFee/);
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
      const cells = (p: (typeof g.procedures)[number]) => Object.entries(p.cells).map(([visit, value], k) => ({ visit, value, source_token_id: p.code === "99205" ? (k === 0 ? real : "9.9.9") : null }));
      return { grids: [{ ...g, id: undefined, procedures: g.procedures.map((p) => ({ ...p, cells: cells(p) })), visitTokens: [{ visit: "V1", field: "total", source_token_id: real }, { visit: "V2", field: "total", source_token_id: "nope" }] }] };
    });
    const real = out.anchors!;
    expect(real.map((a) => [a.field, a.visit, a.procedure])).toEqual([["cell", "V1", 0], ["total", "V1", null]]);
    expect(real.every((a) => a.documentId === "0" || a.page === 1)).toBe(true);
    expect(Rulebook.parse(out.rulebook).budgetGrids[0]!.procedures[0]!.cells).toEqual({ V1: 30000, V2: 30000 });
    expect(JSON.stringify(out.rulebook)).not.toMatch(/source_token_id|visitTokens/);
  });

  it("never puts token text in a warning", async () => {
    CONFIG.tokenMap = true;
    const calls: Call[] = [];
    const out = await readOf(tablePdf(), calls);
    const words = new Set(ids(calls, "grid").map((t) => t.text).filter((t) => /\d/.test(t)));
    const said = JSON.stringify(out.warnings);
    for (const w of words) expect(said).not.toContain(w);
  });
});
