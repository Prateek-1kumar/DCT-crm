import { amountsIn, ocrAmounts } from "../src/checks/text";
import { ocrPages, pdfReader, withOcr } from "../src/pdf";
import { bankLabels, groupLines } from "../src/pdf/lines";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("usage: ocr-bench.ts <file.pdf>...");

const compare = (inText: number[], inOcr: number[]) => {
  const pool = new Map<number, number>();
  for (const a of inOcr) pool.set(a, (pool.get(a) ?? 0) + 1);
  let exact = 0;
  for (const a of inText) {
    const left = pool.get(a) ?? 0;
    if (left > 0) {
      exact++;
      pool.set(a, left - 1);
    }
  }
  return { exact, missed: inText.length - exact, extra: inOcr.length - exact };
};

// what the reader takes from an OCR page: amounts read with OCR's usual slips forgiven
const ocrRead = (words: Parameters<typeof groupLines>[0]) => groupLines(words).flatMap((line) => ocrAmounts(line.map((w) => w.text), () => false).map((a) => a.cents));

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const t = { text: { pages: 0, amounts: 0, exact: 0, missed: 0, extra: 0, tolerantExact: 0, tolerantMissed: 0, labels: 0, masked: 0, ocrLabels: 0, ocrMasked: 0 }, scan: { pages: 0, words: 0, amounts: 0, labels: 0, masked: 0 } };
const confidences: number[] = [];
let seconds = 0;

for (const [i, path] of paths.entries()) {
  const doc = await pdfReader.load(path);
  const started = performance.now();
  const ocr = await ocrPages({ ...doc, pages: doc.pages.map((p) => ({ ...p, kind: "image" as const })) });
  seconds += (performance.now() - started) / 1000;
  const ocrDoc = withOcr(doc, ocr);

  for (const [n, original] of doc.pages.entries()) {
    const read = ocrDoc.pages[n]!;
    const found = ocr[n]!;
    const ocrLabels = bankLabels(groupLines(found.words), true).length;
    const label = `file ${i + 1} page ${original.page}`;
    if (original.kind === "text") {
      const inText = amountsIn(original.layout);
      const diff = compare(inText, amountsIn(read.layout));
      const tolerant = compare(inText, ocrRead(read.words));
      const labels = bankLabels(groupLines(original.words)).length;
      console.log(`${label} text: amounts=${inText.length} exact=${diff.exact} missed=${diff.missed} extra=${diff.extra} tolerantExact=${tolerant.exact} tolerantMissed=${tolerant.missed} labels=${labels} masked=${original.maskBoxes.length} ocrLabels=${ocrLabels} ocrMasked=${read.maskBoxes.length} confidence=${found.confidence.toFixed(1)}`);
      t.text.pages++;
      t.text.amounts += inText.length;
      t.text.exact += diff.exact;
      t.text.missed += diff.missed;
      t.text.extra += diff.extra;
      t.text.tolerantExact += tolerant.exact;
      t.text.tolerantMissed += tolerant.missed;
      t.text.labels += labels;
      t.text.masked += original.maskBoxes.length;
      t.text.ocrLabels += ocrLabels;
      t.text.ocrMasked += read.maskBoxes.length;
    } else {
      const amounts = ocrRead(read.words).length;
      console.log(`${label} scan: confidence=${found.confidence.toFixed(1)} words=${found.words.length} amounts=${amounts} labels=${ocrLabels} masked=${read.maskBoxes.length} turned=${found.rotation}`);
      t.scan.pages++;
      t.scan.words += found.words.length;
      t.scan.amounts += amounts;
      t.scan.labels += ocrLabels;
      t.scan.masked += read.maskBoxes.length;
      confidences.push(found.confidence);
    }
  }
}

console.log(`totals text pages: ${JSON.stringify(t.text)}`);
console.log(`totals scan pages: ${JSON.stringify(t.scan)} meanConfidence=${confidences.length ? (sum(confidences) / confidences.length).toFixed(1) : 0}`);
const pages = t.text.pages + t.scan.pages;
console.log(`seconds per page: ${pages ? (seconds / pages).toFixed(2) : 0} (${pages} pages, ${seconds.toFixed(1)} s)`);
