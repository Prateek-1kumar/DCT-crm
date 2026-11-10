import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pdfReader } from "../src/pdf";
import { LOCATE_DPI, LOCATE_MAX_PIXELS, detectWords, stopDetector } from "../src/scan/detect";
import { cellsOf } from "../src/scan/cells";
import { locate } from "../src/scan/match";
import { parseTranscription } from "../src/scan/transcribe";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-locate-"));
});
afterAll(async () => {
  await stopDetector();
  await rm(dir, { recursive: true, force: true });
});

const overlap = (a: number[], b: number[]) => {
  const w = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!);
  const h = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
  return w > 0 && h > 0 ? (w * h) / Math.min((a[2]! - a[0]!) * (a[3]! - a[1]!), (b[2]! - b[0]!) * (b[3]! - b[1]!)) : 0;
};

it("finds, with real OCR on a drawn page, the boxes the text layer says the words have", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  // lines drawn at known places; y is from the page's top as a fraction
  const draw = (text: string, x: number, top: number) => page.drawText(text, { x, y: 792 * (1 - top) - 10, size: 12, font });
  draw("Site payment schedule", 60, 0.05);
  draw("Fees", 60, 0.1);
  [["Item", "Visit 1", "Visit 2", 0.13], ["Screening", "$50.00", "$50.00", 0.16], ["Follow-up", "$75.00", "$75.00", 0.19]].forEach(([a, b, c, top]) => {
    draw(a as string, 60, top as number);
    draw(b as string, 260, top as number);
    draw(c as string, 400, top as number);
  });
  draw("Invoices are paid within forty-five days of receipt", 60, 0.4);
  const path = join(dir, "drawn.pdf");
  await writeFile(path, await pdf.save());

  const doc = await pdfReader.load(path);
  const truth = doc.pages[0]!.words;
  const png = await pdfReader.render(doc, 1, { dpi: LOCATE_DPI, maxPixels: LOCATE_MAX_PIXELS });
  // the model's vertical guesses are a little off, as on a real scan
  const t = parseTranscription({
    rotation: 0,
    text: [
      "L 0.060-0.075 | Site payment schedule",
      "T 0.100-0.300 | Fees",
      "H | Item | Visit 1 | Visit 2",
      "R 0.150-0.165 | Screening | $50.00 | $50.00",
      "R 0.185-0.200 | Follow-up | $75.00 | $75.00",
      "L 0.420-0.435 | Invoices are paid within forty-five days of receipt",
    ].join("\n"),
  });
  const found = locate(1, t, await detectWords(png));

  const cells = cellsOf(1, t);
  let words = 0;
  let exact = 0;
  for (const cell of cells) {
    cell.text.split(/\s+/).filter(Boolean).forEach((text, i) => {
      const box = found.words[cell.id]?.[i];
      words++;
      if (!box) return;
      exact++;
      // the located box sits on a word of the text layer with the same text
      const same = truth.filter((w) => w.text === text);
      expect(same.some((w) => overlap(box, [w.x0, w.y0, w.x1, w.y1]) > 0.5), `${cell.id} word ${i}`).toBe(true);
    });
  }
  expect(exact / words).toBeGreaterThan(0.9);
  // the repeated amounts are told apart by column
  const xs = ["p1.t1.r1.c1", "p1.t1.r1.c2"].map((id) => found.words[id]![0]![0]);
  expect(xs[0]).toBeLessThan(xs[1]!);
  // the model's guess put the first row near the second's; the real box is on the row it is printed on
  expect(found.rows["p1.t1.r1"]![1]).toBeCloseTo(0.16, 1);
}, 60_000);
