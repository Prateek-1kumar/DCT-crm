import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ask, Budget, Reader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { groupLines, rawLine } from "../src/pdf/lines";
import { fileScanStore, scanDocs, scanVersion, untranscribed, withScans } from "../src/scan";
import { parseTranscription, type Transcription } from "../src/scan/transcribe";
import { toWords } from "../src/scan/words";
import { ReadFailed } from "../src/read";
import type { LoadedDoc, ScanPage, ScanStore } from "../src/types";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-scan-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const line = (text: string, top: number, bottom: number, over: Partial<Transcription["lines"][number]> = {}) => ({ text, top, bottom, unsure: false, marks: [], ...over });
const cell = (text: string, unsure = false) => ({ text, unsure, marks: [] });
const transcription = (over: Partial<Transcription> = {}): Transcription => ({ rotation: 0, lines: [line("Startup fee $1,234.56", 0.1, 0.12)], tables: [], ...over });

describe("toWords", () => {
  const table = (rows: { label: string; cells: ReturnType<typeof cell>[]; top: number; bottom: number }[]): Transcription =>
    transcription({ lines: [], tables: [{ title: "Budget", top: 0.2, bottom: 0.6, columns: ["Visit", "Fee", "Extra", "Total"], rows }] });

  it("keeps a table row on one line in column order", () => {
    const words = toWords(table([{ label: "Visit 1", cells: [cell("$1,200.00"), cell("$300.00")], top: 0.3, bottom: 0.32 }]));
    expect(groupLines(words).map(rawLine).at(-1)).toBe("Visit 1 $1,200.00 $300.00");
  });

  it("leaves the slot of a blank cell empty, so the next value stays under its own column", () => {
    const words = groupLines(toWords(table([{ label: "Visit 1", cells: [cell("$1,200.00"), cell(""), cell("$300.00")], top: 0.3, bottom: 0.32 }]))).at(-1)!;
    expect(words.map((w) => w.text)).toEqual(["Visit", "1", "$1,200.00", "$300.00"]);
    const [label, first, third] = [words[0]!, words[2]!, words[3]!];
    const slot = first.x0 - label.x0;
    expect(third.x0 - first.x0).toBeCloseTo(2 * slot);
  });

  it("emits a table's title and column headings above its rows", () => {
    const t = table([{ label: "Visit 1", cells: [cell("$1,200.00"), cell("$300.00")], top: 0.3, bottom: 0.32 }]);
    const lines = groupLines(toWords({ ...t, lines: [line("Before the table", 0.05, 0.07)] })).map(rawLine);
    expect(lines).toEqual(["Before the table", "Budget", "Visit Fee Extra Total", "Visit 1 $1,200.00 $300.00"]);
    const heading = groupLines(toWords(t))[1]!;
    const row = groupLines(toWords(t))[2]!;
    expect(heading[1]!.x0).toBeCloseTo(row[2]!.x0);
  });

  it("masks every cell under a bank heading, not the amount column beside it", () => {
    const t = transcription({
      lines: [],
      tables: [{
        title: "Payments", top: 0.2, bottom: 0.6, columns: ["Site", "Account Number", "Fee"],
        rows: [["900765432", "$100.00"], ["000333444", "$200.00"], ["12-3456-78", "$300.00"]].map(([account, fee], i) => ({ label: `Site ${i + 1}`, top: 0.3 + i * 0.03, bottom: 0.32 + i * 0.03, cells: [cell(account!), cell(fee!)] })),
      }],
    });
    const lines = groupLines(toWords(t)).map(rawLine);
    expect(lines.slice(2)).toEqual(["Site 1 ######### $100.00", "Site 2 ######### $200.00", "Site 3 ##-####-## $300.00"]);
    expect(lines[1]).toBe("Site Account Number Fee");
  });

  it("two zero-height lines on the same band among normal lines stay two lines in order", () => {
    const t = transcription({
      lines: [line("Startup fee", 0.3, 0.3), line("Visit fee", 0.3, 0.3), line("Intro", 0.1, 0.12), line("Closing words", 0.5, 0.52), line("Payment $200.00", 0.6, 0.62), line("Total $1,000.00", 0.7, 0.72)],
    });
    expect(groupLines(toWords(t)).map(rawLine)).toEqual(["Intro", "Startup fee", "Visit fee", "Closing words", "Payment $200.00", "Total $1,000.00"]);
  });

  it("toWords keeps a dense table's rows at their reported heights", () => {
    const rows = Array.from({ length: 44 }, (_, i) => {
      const centre = 0.02 + i * 0.015;
      return { label: `Row ${i}`, cells: [cell(`$${i}.00`)], top: centre - 0.01, bottom: centre + 0.01 };
    });
    const words = toWords(transcription({ lines: [], tables: [{ title: "", top: 0.01, bottom: 0.7, columns: ["Item", "Fee"], rows }] }));

    rows.forEach((r, i) => {
      const amount = words.find((w) => w.text === `$${i}.00`)!;
      expect(Math.abs((amount.y0 + amount.y1) / 2 - (r.top + r.bottom) / 2)).toBeLessThan(0.002);
    });
    expect(Math.max(...words.map((w) => w.y1))).toBeLessThanOrEqual(1);
    expect(Math.min(...words.map((w) => w.y0))).toBeGreaterThanOrEqual(0);
    expect(groupLines(words).map(rawLine)).toEqual(["Item Fee", ...rows.map((_, i) => `Row ${i} $${i}.00`)]);
  });

  it("keeps two lines with the same band as two lines in order", () => {
    const t = transcription({ lines: [line("First clause $100.00", 0.4, 0.42), line("Second clause $200.00", 0.4, 0.42)] });
    const lines = groupLines(toWords(t));
    expect(lines).toHaveLength(2);
    expect(rawLine(lines[0]!)).toBe("First clause $100.00");
    expect(rawLine(lines[1]!)).toBe("Second clause $200.00");
  });

  it("marks doubtful words, and a mark wins over unsure", () => {
    const t = transcription({
      lines: [line("Handwritten $5.00", 0.1, 0.12, { marks: ["handwritten"], unsure: true }), line("Plain line", 0.3, 0.32)],
      tables: [{ title: "", top: 0.5, bottom: 0.6, columns: ["", "Fee"], rows: [{ label: "Visit", top: 0.5, bottom: 0.52, cells: [cell("$1.00", true)] }] }],
    });
    const by = (text: string) => toWords(t).find((w) => w.text === text)!;
    expect(by("$1.00").doubt).toBe("unsure");
    expect(by("$5.00").doubt).toBe("handwritten");
    expect(by("Plain").doubt).toBeUndefined();
    expect(by("Visit").doubt).toBeUndefined();
  });
});

async function imagePdf(name: string, sizes: [number, number][]): Promise<LoadedDoc> {
  const pdf = await PDFDocument.create();
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 40, 40);
  const image = await pdf.embedPng(await canvas.encode("png"));
  for (const [w, h] of sizes) pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
  const path = join(dir, name);
  await writeFile(path, await pdf.save());
  return pdfReader.load(path);
}

const memoryStore = (): ScanStore & { pages: Map<string, ScanPage[]> } => {
  const pages = new Map<string, ScanPage[]>();
  return {
    pages,
    get: async (sha) => pages.get(sha) ?? [],
    put: async (sha, page) => void pages.set(sha, [...(pages.get(sha) ?? []).filter((p) => p.page !== page.page), page]),
  };
};

const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const compact = (rotation = 0, text = "L 0.100-0.120 | Startup fee $1,234.56") => ({ rotation, text });

function fakeReader(answer: (call: number, png: Buffer) => { rotation: number; text: string }, price = { input: 0, output: 25, cacheWrite: 0, cacheRead: 0 }) {
  const sent: Buffer[] = [];
  const reader: Reader = {
    model: "gpt-test",
    // 4,000 output tokens at $25 a million: every call is estimated at $0.10
    price,
    async ask<T>(req: Ask<T>) {
      const first = req.parts[0];
      if (first?.type !== "image") throw new Error("the page image comes first");
      sent.push(first.png);
      return { value: answer(sent.length, first.png) as T, model: "gpt-test", usd: 0.1 };
    },
  };
  return { reader, sent };
}

const budgetOf = (limit: number): Budget => ({ limit, spent: 0 });

describe("scanDocs", () => {
  it("transcribes an image page once", async () => {
    const doc = await imagePdf("once.pdf", [[612, 792]]);
    expect(doc.pages[0]!.kind).toBe("image");
    const { reader, sent } = fakeReader(() => compact());
    const store = memoryStore();
    const progress: string[] = [];

    const [scanned] = await scanDocs([doc], { reader, store, budget: budgetOf(3), onProgress: (l) => progress.push(l) });
    expect(sent).toHaveLength(1);
    expect(scanned!.pages[0]).toMatchObject({ kind: "scan", rotation: 0, firstLine: "Startup fee $1,234.56" });
    expect(store.pages.get(doc.sha256)).toEqual([expect.objectContaining({ page: 1, version: scanVersion(reader), rotation: 0 })]);
    expect(progress.at(-1)).toBe("Reading scanned pages: 1 of 1");

    const budget = budgetOf(3);
    const [again] = await scanDocs([doc], { reader, store, budget });
    expect(sent).toHaveLength(1);
    expect(budget.spent).toBe(0);
    expect(again!.pages[0]!.kind).toBe("scan");
    expect(await untranscribed([doc], store, reader)).toBe(0);
  });

  it("counts the pages still to pay for, and treats a page saved by another model as not read", async () => {
    const doc = await imagePdf("count.pdf", [[612, 792], [612, 792]]);
    const { reader } = fakeReader(() => compact());
    const store = memoryStore();
    expect(await untranscribed([doc], store, reader)).toBe(2);
    await store.put(doc.sha256, { page: 1, version: `transcribe-2 ${reader.model}`, rotation: 0, transcription: transcription() });
    expect(await untranscribed([doc], store, reader)).toBe(2);
    await store.put(doc.sha256, { page: 1, version: scanVersion(reader), rotation: 0, transcription: transcription() });
    expect(await untranscribed([doc], store, reader)).toBe(1);
  });

  it("a page saved in the old format is read again", async () => {
    const doc = await imagePdf("old-format.pdf", [[612, 792]]);
    const { reader, sent } = fakeReader(() => compact());
    const store = fileScanStore(join(dir, "scans-old"));
    await mkdir(join(dir, "scans-old"), { recursive: true });
    await writeFile(join(dir, "scans-old", `${doc.sha256}.scan.json`), JSON.stringify([{ page: 1, version: `transcribe-1 ${reader.model}`, rotation: 0, words: [] }]));
    expect(await untranscribed([doc], store, reader)).toBe(1);

    const [scanned] = await scanDocs([doc], { reader, store, budget: budgetOf(3) });
    expect(sent).toHaveLength(1);
    expect(scanned!.pages[0]!.kind).toBe("scan");
    expect(await untranscribed([doc], store, reader)).toBe(0);
  });

  it("turns a sideways page and reads it again", async () => {
    const doc = await imagePdf("sideways.pdf", [[612, 792]]);
    const { reader, sent } = fakeReader((call) => compact(call === 1 ? 90 : 0));
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(3) });
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map(sizeOf) as [ReturnType<typeof sizeOf>, ReturnType<typeof sizeOf>];
    expect(first.width).toBeLessThan(first.height);
    expect(second.width).toBeGreaterThan(second.height);
    expect(scanned!.pages[0]!.rotation).toBe(90);
  });

  it("a page still reported turned after the second read is turned again and read a third time", async () => {
    const doc = await imagePdf("upside.pdf", [[612, 792]]);
    const { reader, sent } = fakeReader((call) => compact([270, 180, 0][call - 1]!));
    const budget = budgetOf(3);
    const progress: string[] = [];
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget, onProgress: (l) => progress.push(l) });

    expect(sent).toHaveLength(3);
    expect(sent.map((png) => sizeOf(png).width > sizeOf(png).height)).toEqual([false, true, true]);
    expect(scanned!.pages[0]!.rotation).toBe(90);
    expect(budget.spent).toBeCloseTo(0.3);
    expect(progress.join("\n")).not.toContain("turned the wrong way");

    const stuck = fakeReader(() => compact(90));
    const [kept] = await scanDocs([doc], { reader: stuck.reader, store: memoryStore(), budget: budgetOf(3), onProgress: (l) => progress.push(l) });
    expect(stuck.sent).toHaveLength(3);
    expect(kept!.pages[0]!.rotation).toBe(180);
    expect(progress).toContain("p.1 of upside.pdf may still be turned the wrong way");
  });

  it("keeps finished pages when the budget runs out", async () => {
    const doc = await imagePdf("budget.pdf", [[612, 792], [612, 792], [612, 792]]);
    const { reader, sent } = fakeReader(() => compact());
    const store = memoryStore();
    const stopped = await scanDocs([doc], { reader, store, budget: budgetOf(0.1 + 0.05) }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(ReadFailed);
    expect((stopped as ReadFailed).message).toContain("1 of 3");
    expect((stopped as ReadFailed).message).toContain("$0.15 limit");
    expect(store.pages.get(doc.sha256)).toHaveLength(1);

    const before = sent.length;
    await scanDocs([doc], { reader, store, budget: budgetOf(3) });
    expect(sent.length - before).toBe(2);
    expect(store.pages.get(doc.sha256)).toHaveLength(3);
  });

  it("holds a realistic cost per page, so $0.60 lets pages start in parallel at OpenAI's price", async () => {
    const doc = await imagePdf("parallel.pdf", [[612, 792], [612, 792], [612, 792], [612, 792]]);
    const { reader } = fakeReader(() => compact(), { input: 5, output: 30, cacheWrite: 0, cacheRead: 0 });
    const ask = reader.ask.bind(reader);
    let running = 0;
    let most = 0;
    reader.ask = async (req) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return ask(req);
    };
    await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(0.6) });
    expect(most).toBeGreaterThanOrEqual(3);
  });

  it("stops on a failed page and keeps the others", async () => {
    const doc = await imagePdf("failing.pdf", [[612, 792], [300, 792]]);
    const { reader } = fakeReader((_, png) => {
      const { width, height } = sizeOf(png);
      if (width / height < 0.5) throw new Error("secret model detail");
      return compact();
    });
    const store = memoryStore();
    const stopped = await scanDocs([doc], { reader, store, budget: budgetOf(3) }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(ReadFailed);
    expect((stopped as ReadFailed).message).toContain("failing.pdf p.2");
    expect((stopped as ReadFailed).message).not.toContain("secret");
    expect(store.pages.get(doc.sha256)).toMatchObject([{ page: 1 }]);
  });

  it("says when a page looked blank when read from the image, and keeps going", async () => {
    const doc = await imagePdf("backs.pdf", [[612, 792], [612, 792]]);
    const { reader } = fakeReader((call) => (call === 1 ? compact(0, "") : compact()));
    const progress: string[] = [];
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(3), onProgress: (l) => progress.push(l) });

    const blank = progress.filter((l) => l.includes("blank"));
    expect(blank).toHaveLength(1);
    expect(blank[0]).toMatch(/^p\.[12] of backs\.pdf looked blank when read from the image$/);
    expect(scanned!.pages.map((p) => p.kind)).toEqual(["scan", "scan"]);
  });

  it("masks bank numbers in the text and paints nothing", async () => {
    const doc = await imagePdf("bank.pdf", [[612, 792]]);
    const { reader } = fakeReader(() => compact(0, "L 0.100-0.120 | Account number 123456789\nL 0.200-0.220 | Startup fee $1,234.56"));
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(3) });
    const page = scanned!.pages[0]!;
    expect(page.words.map((w) => w.text)).toContain("#########");
    expect(page.raw).not.toContain("123456789");
    expect(page.raw).toContain("$1,234.56");
    expect(page.maskBoxes).toEqual([]);
  });
});

describe("parseTranscription", () => {
  const parse = (text: string, rotation = 0) => parseTranscription({ rotation, text });

  it("the compact form parses into lines and tables with positions, blank cells and doubts", () => {
    const t = parse(
      [
        "L 0.050-0.062 | Study ABC-123 budget",
        "L 0.070-0.082 | Rates are fixed{x}",
        "T 0.300-0.620 | Visit fees",
        "H | Visit | Fee | Extra | Total",
        "R 0.312-0.326 | Visit 1 | $1,200.00 | | $1,500.00",
        "R 0.330-0.344 | Visit 2 | $900.00{hw}{?} | $50.00 | $950.00",
      ].join("\n"),
      90,
    );
    expect(t.rotation).toBe(90);
    expect(t.lines).toEqual([
      line("Study ABC-123 budget", 0.05, 0.062),
      line("Rates are fixed", 0.07, 0.082, { marks: ["struck_out"] }),
    ]);
    expect(t.tables).toEqual([
      {
        title: "Visit fees", top: 0.3, bottom: 0.62, columns: ["Visit", "Fee", "Extra", "Total"],
        rows: [
          { label: "Visit 1", top: 0.312, bottom: 0.326, cells: [cell("$1,200.00"), cell(""), cell("$1,500.00")] },
          { label: "Visit 2", top: 0.33, bottom: 0.344, cells: [{ text: "$900.00", unsure: true, marks: ["handwritten"] }, cell("$50.00"), cell("$950.00")] },
        ],
      },
    ]);
  });

  it("a struck value with its handwritten replacement in one cell keeps both, each with its mark", () => {
    const t = parse("T 0.3-0.4 | Fees\nH | Item | Fee | Total\nR 0.31-0.32 | Visit 1 | $900.00{x} $1,050.00{hw}{?} | $1,050.00");
    const [fee, total] = t.tables[0]!.rows[0]!.cells;
    expect(fee).toMatchObject({ text: "$900.00 $1,050.00", unsure: true, marks: ["struck_out", "handwritten"] });
    expect(fee!.parts).toEqual([
      { text: "$900.00", unsure: false, marks: ["struck_out"] },
      { text: "$1,050.00", unsure: true, marks: ["handwritten"] },
    ]);
    expect(total).toEqual(cell("$1,050.00"));

    const words = toWords(t);
    expect(words.filter((w) => w.text.startsWith("$")).map((w) => [w.text, w.doubt])).toEqual([["$900.00", "struck_out"], ["$1,050.00", "handwritten"], ["$1,050.00", undefined]]);
    expect(groupLines(words).map(rawLine)).toContain("Visit 1 $900.00 $1,050.00 $1,050.00");
  });

  it("a line the parser can't read is kept as an unsure line at the previous element's position", () => {
    const t = parse("L 0.100-0.120 | First\nSomething the model wrote freely $5.00\nT 0.3-0.4 | Fees");
    expect(t.lines).toEqual([line("First", 0.1, 0.12), line("Something the model wrote freely $5.00", 0.1, 0.12, { unsure: true })]);
    expect(parse("Total: $5.00").lines).toEqual([line("Total: $5.00", 0, 0, { unsure: true })]);
  });

  it("positions outside the page are clamped, and a missing position comes from the neighbour", () => {
    const t = parse("L 1.200-1.500 | Past the end\nL 0.9-0.4 | Backwards\nL | No position\nR 0.5- | Row | $1.00");
    expect(t.lines.map((l) => [l.top, l.bottom])).toEqual([[1, 1], [0.4, 0.9], [0.4, 0.9]]);
    expect(t.tables[0]!.rows[0]).toMatchObject({ top: 0.4, bottom: 0.9 });
  });

  it("keeps every field of a row longer than its headings, and rows with no table above them", () => {
    const t = parse("H | Item | Fee\nR 0.2-0.21 | A | $1.00 | $2.00 | $3.00\nT 0.4-0.5 |\nH | Only headings");
    expect(t.tables[0]!.rows[0]!.cells.map((c) => c.text)).toEqual(["$1.00", "$2.00", "$3.00"]);
    expect(t.lines.map((l) => l.text)).toEqual(["Only headings"]);
    expect(groupLines(toWords(parse("R 0.2-0.21 | A | $1.00 | $2.00"))).map(rawLine)).toEqual(["A $1.00 $2.00"]);
  });
});

describe("withScans", () => {
  it("a saved transcription is turned into words when loaded, so a later fix to toWords applies without reading the page again", async () => {
    const doc = await imagePdf("load.pdf", [[612, 792]]);
    const saved = transcription();
    const loaded = withScans(doc, [{ page: 1, version: "v", rotation: 0, transcription: saved }]);
    expect(loaded.pages[0]).toMatchObject({ kind: "scan", words: toWords(saved) });
    expect(loaded.pages[0]!.words.length).toBeGreaterThan(0);
  });
});

describe("fileScanStore", () => {
  it("keeps every page under parallel puts, one file per document", async () => {
    const store = fileScanStore(join(dir, "scans"));
    const sha = "a".repeat(64);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.put(sha, { page: i + 1, version: "v", rotation: 0, transcription: transcription() })));
    expect((await store.get(sha)).map((p) => p.page).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await readdir(join(dir, "scans"))).toEqual([`${sha}.scan.json`]);
    expect(await store.get("b".repeat(64))).toEqual([]);
  });

  it("replaces a page put again", async () => {
    const store = fileScanStore(join(dir, "scans-again"));
    await store.put("c", { page: 1, version: "old", rotation: 0, transcription: transcription() });
    await store.put("c", { page: 1, version: "new", rotation: 0, transcription: transcription() });
    expect(await store.get("c")).toMatchObject([{ page: 1, version: "new" }]);
  });
});
