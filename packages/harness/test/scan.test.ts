import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ask, Budget, Reader } from "../src/models";
import { pdfReader } from "../src/pdf";
import { groupLines, rawLine } from "../src/pdf/lines";
import { fileScanStore, scanDocs, scanVersion, untranscribed } from "../src/scan";
import type { Transcription } from "../src/scan/transcribe";
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
    const lines = groupLines(words);
    expect(lines).toHaveLength(1);
    expect(rawLine(lines[0]!)).toBe("Visit 1 $1,200.00 $300.00");
  });

  it("leaves the slot of a blank cell empty, so the next value stays under its own column", () => {
    const words = toWords(table([{ label: "Visit 1", cells: [cell("$1,200.00"), cell(""), cell("$300.00")], top: 0.3, bottom: 0.32 }]));
    expect(words.map((w) => w.text)).toEqual(["Visit", "1", "$1,200.00", "$300.00"]);
    const [label, first, third] = [words[0]!, words[2]!, words[3]!];
    const slot = first.x0 - label.x0;
    expect(third.x0 - first.x0).toBeCloseTo(2 * slot);
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

function fakeReader(answer: (call: number, png: Buffer) => Transcription) {
  const sent: Buffer[] = [];
  const reader: Reader = {
    model: "gpt-test",
    // 8,000 output tokens at $12.50 a million: every call is estimated at $0.10
    price: { input: 0, output: 12.5, cacheWrite: 0, cacheRead: 0 },
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
    const { reader, sent } = fakeReader(() => transcription());
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
    const { reader } = fakeReader(() => transcription());
    const store = memoryStore();
    expect(await untranscribed([doc], store, reader)).toBe(2);
    await store.put(doc.sha256, { page: 1, version: "transcribe-1 other-model", rotation: 0, words: [] });
    expect(await untranscribed([doc], store, reader)).toBe(2);
    await store.put(doc.sha256, { page: 1, version: scanVersion(reader), rotation: 0, words: [] });
    expect(await untranscribed([doc], store, reader)).toBe(1);
  });

  it("turns a sideways page and reads it again", async () => {
    const doc = await imagePdf("sideways.pdf", [[612, 792]]);
    const { reader, sent } = fakeReader((call) => transcription({ rotation: call === 1 ? 90 : 0 }));
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(3) });
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map(sizeOf) as [ReturnType<typeof sizeOf>, ReturnType<typeof sizeOf>];
    expect(first.width).toBeLessThan(first.height);
    expect(second.width).toBeGreaterThan(second.height);
    expect(scanned!.pages[0]!.rotation).toBe(90);
  });

  it("keeps finished pages when the budget runs out", async () => {
    const doc = await imagePdf("budget.pdf", [[612, 792], [612, 792], [612, 792]]);
    const { reader, sent } = fakeReader(() => transcription());
    const store = memoryStore();
    const stopped = await scanDocs([doc], { reader, store, budget: budgetOf(0.15) }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(ReadFailed);
    expect((stopped as ReadFailed).message).toContain("1 of 3");
    expect((stopped as ReadFailed).message).toContain("$0.15 limit");
    expect(store.pages.get(doc.sha256)).toHaveLength(1);

    const before = sent.length;
    await scanDocs([doc], { reader, store, budget: budgetOf(3) });
    expect(sent.length - before).toBe(2);
    expect(store.pages.get(doc.sha256)).toHaveLength(3);
  });

  it("stops on a failed page and keeps the others", async () => {
    const doc = await imagePdf("failing.pdf", [[612, 792], [300, 792]]);
    const { reader } = fakeReader((_, png) => {
      const { width, height } = sizeOf(png);
      if (width / height < 0.5) throw new Error("secret model detail");
      return transcription();
    });
    const store = memoryStore();
    const stopped = await scanDocs([doc], { reader, store, budget: budgetOf(3) }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(ReadFailed);
    expect((stopped as ReadFailed).message).toContain("failing.pdf p.2");
    expect((stopped as ReadFailed).message).not.toContain("secret");
    expect(store.pages.get(doc.sha256)).toMatchObject([{ page: 1 }]);
  });

  it("masks bank numbers in the text and paints nothing", async () => {
    const doc = await imagePdf("bank.pdf", [[612, 792]]);
    const { reader } = fakeReader(() => transcription({ lines: [line("Account number 123456789", 0.1, 0.12), line("Startup fee $1,234.56", 0.2, 0.22)] }));
    const [scanned] = await scanDocs([doc], { reader, store: memoryStore(), budget: budgetOf(3) });
    const page = scanned!.pages[0]!;
    expect(page.words.map((w) => w.text)).toContain("#########");
    expect(page.raw).not.toContain("123456789");
    expect(page.raw).toContain("$1,234.56");
    expect(page.maskBoxes).toEqual([]);
  });
});

describe("fileScanStore", () => {
  it("keeps every page under parallel puts, one file per document", async () => {
    const store = fileScanStore(join(dir, "scans"));
    const sha = "a".repeat(64);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.put(sha, { page: i + 1, version: "v", rotation: 0, words: [] })));
    expect((await store.get(sha)).map((p) => p.page).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await readdir(join(dir, "scans"))).toEqual([`${sha}.scan.json`]);
    expect(await store.get("b".repeat(64))).toEqual([]);
  });

  it("replaces a page put again", async () => {
    const store = fileScanStore(join(dir, "scans-again"));
    await store.put("c", { page: 1, version: "old", rotation: 0, words: [] });
    await store.put("c", { page: 1, version: "new", rotation: 0, words: [] });
    expect(await store.get("c")).toMatchObject([{ page: 1, version: "new" }]);
  });
});
