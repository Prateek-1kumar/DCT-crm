import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { bindEvidence } from "../src/binder";
import { ocrPage, withOcr } from "../src/ocr";
import { readTextLayer, type TextPage } from "../src/textlayer";
import { makeRulebook } from "./helpers";

/** Our own OCR of scanned pages (ocr.ts, ocr/worker.py). Synthetic pages only: a text PDF rendered to an image. */

const base: TextPage = { documentId: "d1", page: 1, width: 612, height: 792, source: "image_only", words: [], hidden: 0, largePicture: false };
const word = (text: string, bbox: [number, number, number, number]) => ({ text, conf: 0.99, bbox, line: 0 });

describe("ocrPage", () => {
  // at 72 DPI a pixel is a point, so the boxes can be checked by eye
  it("upright: pixels are points scaled by the DPI", () => {
    const p = ocrPage(base, { dpi: 144, turned: 0, words: [word("Fee", [200, 100, 260, 120])], unread: [[0, 0, 612, 792]] });
    expect(p.source).toBe("ocr");
    expect(p.words[0]).toMatchObject({ text: "Fee", rect: [100, 50, 130, 60], dir: 0, conf: 0.99 });
    expect(p.unread![0]!.box).toEqual([0, 0, 306 / 612, 396 / 792]);
  });

  it("turned 90° (text running bottom to top on the page) and 270° (top to bottom) come back in the page's own frame", () => {
    // the image of a page turned 90° clockwise is 792 wide: its pixel (u, v) was the page's (v, 792 − u)
    expect(ocrPage(base, { dpi: 72, turned: 90, words: [word("Fee", [700, 50, 760, 60])] }).words[0]).toMatchObject({ rect: [50, 32, 60, 92], dir: 3 });
    // turned 270°, its pixel (u, v) was the page's (612 − v, u)
    expect(ocrPage(base, { dpi: 72, turned: 270, words: [word("Fee", [700, 50, 760, 60])] }).words[0]).toMatchObject({ rect: [552, 700, 562, 760], dir: 1 });
  });
});

/** A scan: a page printed with `lines`, rendered to an image at 150 DPI, and that image as the only content of a PDF page. */
function scannedPdf(lines: [x: number, y: number, s: string][]): string {
  const text = new mupdf.PDFDocument();
  const res = { Font: { F1: text.addSimpleFont(new mupdf.Font("Helvetica")) } };
  text.insertPage(-1, text.addPage([0, 0, 612, 792], 0, res, lines.map(([x, y, s]) => `BT /F1 10 Tf ${x} ${792 - y} Td (${s}) Tj ET\n`).join("")));
  const pix = text.loadPage(0).toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceGray, false, true);
  const scan = new mupdf.PDFDocument();
  scan.insertPage(-1, scan.addPage([0, 0, 612, 792], 0, { XObject: { Im1: scan.addImage(new mupdf.Image(pix)) } }, "q 612 0 0 792 0 0 cm /Im1 Do Q\n"));
  const path = join(mkdtempSync(join(tmpdir(), "dct-ocr-")), "scan.pdf");
  writeFileSync(path, scan.saveToBuffer("").asUint8Array());
  return path;
}

describe("withOcr", () => {
  const saved = process.env.SCAN_OCR;
  afterEach(() => (saved === undefined ? delete process.env.SCAN_OCR : (process.env.SCAN_OCR = saved)));

  it("switched off, it reads nothing: the scan stays a scan", async () => {
    process.env.SCAN_OCR = "0";
    const pdf = scannedPdf([[72, 100, "Screening fee 1,500.00"]]);
    const pages = await readTextLayer(pdf, "d1");
    expect(await withOcr(pdf, pages)).toBeNull();
    expect((await readTextLayer(pdf, "d1", { ocr: true }))[0]!.source).toBe("image_only");
    expect(existsSync(`${pdf}.ocr.json`)).toBe(false);
  });

  it("reads a scanned budget table so the binder confirms its cells by position, and caches the reading", async () => {
    const venv = join(dirname(fileURLToPath(import.meta.url)), "../ocr/.venv/bin/python");
    // the OCR is part of the product: a machine without it must say so, not skip
    expect(existsSync(venv), "The local OCR isn't installed: run pnpm run setup (packages/extraction/ocr/setup.sh)").toBe(true);
    process.env.SCAN_OCR = "1";
    const pdf = scannedPdf([
      [90, 100, "Procedure"], [280, 100, "V1"], [340, 100, "V2"],
      [90, 120, "Physical exam"], [280, 120, "300.00"], [340, 120, "300.00"],
      [90, 136, "Blood draw"], [280, 136, "200.00"],
    ]);
    const pages = await readTextLayer(pdf, "d1", { ocr: true });
    expect(pages[0]!.source).toBe("ocr");
    expect(existsSync(`${pdf}.ocr.json`)).toBe(true);
    const rb = makeRulebook();
    const g = rb.budgetGrids[0]!;
    const on = { source: { documentId: "d1", page: 1 }, confidence: 0.9, method: "ai", crossCheck: "not_checked" } as const;
    g.perPatientTotals = [];
    g.visits = g.visits.map((v) => ({ ...v, prov: on, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null }));
    g.procedures = [
      { code: null, name: "Physical exam", unitCents: null, overheadApplied: true, category: "procedure", cells: { V1: 30000, V2: 30000 }, prov: on },
      { code: null, name: "Blood draw", unitCents: null, overheadApplied: true, category: "procedure", cells: { V1: 20000 }, prov: on },
    ];
    const status = (r: typeof rb) => Object.fromEntries(bindEvidence(r, pages).evidence.filter((e) => e.path.includes("/cells/")).map((e) => [e.path, e.status]));
    expect(status(rb)).toEqual({ "/budgetGrids/0/procedures/0/cells/V1": "confirmed", "/budgetGrids/0/procedures/0/cells/V2": "confirmed", "/budgetGrids/0/procedures/1/cells/V1": "confirmed" });
    // a misread is never confirmed, nor a price at a visit the row leaves blank
    const wrong = structuredClone(rb);
    wrong.budgetGrids[0]!.procedures[0]!.cells.V2 = 30800;
    wrong.budgetGrids[0]!.procedures[1]!.cells.V2 = 20000;
    const w = status(wrong);
    expect([w["/budgetGrids/0/procedures/0/cells/V2"], w["/budgetGrids/0/procedures/1/cells/V2"]]).not.toContain("confirmed");
  }, 120_000);
});
