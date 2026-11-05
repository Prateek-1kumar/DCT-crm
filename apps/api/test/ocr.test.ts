import { OCR_VERSION, type OcrPage } from "@dct/harness";
import { eq } from "drizzle-orm";
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { documents, type PageInfo } from "../src/db/schema.js";
import type { Ocr } from "../src/jobs/ocr.js";
import { forgetStored, loadStored } from "../src/lib/docs.js";
import { ocrPath, readOcr, savePdf } from "../src/lib/storage.js";
import type { Built } from "./helpers.js";

// OCR as a background job, with a fake engine: nothing here runs real OCR.

const unique = () => Math.random().toString(36).slice(2, 10);

/** A PDF with one page per entry: a page of text, or a blank one (no text layer, so a scan). Each call makes different bytes. */
async function pdf(...pages: ("text" | "blank")[]) {
  const doc = await PDFDocument.create();
  doc.setTitle(unique());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const kind of pages) {
    const page = doc.addPage([612, 792]);
    if (kind === "text") for (let i = 0; i < 4; i++) page.drawText("Sponsor pays the Institution within forty-five days of an itemized invoice for work done under this budget. ", { x: 50, y: 700 - i * 20, size: 7, font });
  }
  return Buffer.from(await doc.save());
}

const word = (text: string, confidence: number) => ({ text, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.12, confidence });

type Engine = (sha256: string, scans: number[], onPage: (done: number, total: number) => void) => Promise<OcrPage[]>;
const readsOk = (confidence: number): Engine => async (_sha, scans, onPage) => {
  scans.forEach((_, i) => onPage(i + 1, scans.length));
  return scans.map((page) => ({ page, words: [word("Startup", confidence), word("fee", confidence)], confidence, rotation: 0 }));
};

let engine: Engine = readsOk(90);
const calls = new Map<string, number>();
const ocr: Ocr = async (doc, opts) => {
  calls.set(doc.sha256, (calls.get(doc.sha256) ?? 0) + 1);
  return engine(doc.sha256, doc.pages.filter((p) => p.kind === "image").map((p) => p.page), (done, total) => opts?.onPage?.(done, total));
};
const callsFor = (sha256: string) => calls.get(sha256) ?? 0;

let built: Built;
const extra: Built[] = [];
const start = async () => {
  const b = await buildApp({ ocr });
  extra.push(b);
  return b;
};
beforeAll(async () => {
  built = await buildApp({ ocr });
});
afterEach(async () => {
  engine = readsOk(90);
  await Promise.all(extra.splice(0).map((b) => b.app.close()));
});
afterAll(() => built.app.close());

const db = () => built.ctx.db;
const call = (method: "GET" | "POST", url: string, payload?: object) => built.app.inject({ method, url: `/api/v1${url}`, payload });
const row = async (id: string) => (await db().select().from(documents).where(eq(documents.id, id)))[0]!;

async function upload(studyId: string, data: Buffer, name = `${unique()}.pdf`) {
  const fd = new FormData();
  fd.append("by", "Asha");
  fd.append("files[]", new Blob([new Uint8Array(data)]), name);
  const req = new Request("http://local/", { method: "POST", body: fd });
  const res = await built.app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/documents`, payload: Buffer.from(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } });
  expect(res.statusCode).toBe(200);
  return res.json()[0] as { id: string };
}
const newStudy = async () => ((await call("POST", "/studies", { by: "Asha" })).json() as { id: string }).id;

async function until<T>(what: string, check: () => Promise<T | false>) {
  for (let i = 0; i < 300; i++) {
    const got = await check();
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`never happened: ${what}`);
}
const status = (id: string, want: string) => until(`${id} is ${want}`, async () => ((await row(id)).ocrStatus === want ? row(id) : false));

/** A stored scan with its row, as if uploaded earlier. */
async function seedScan(ocrStatus: "none" | "queued" | "running" | "done" | "failed", pages: ("text" | "blank")[] = ["blank", "text", "blank"]) {
  const data = await pdf(...pages);
  const sha256 = await savePdf(data);
  const info: PageInfo[] = pages.map((kind, i) => ({ page: i + 1, kind: kind === "text" ? "text" : "image", chars: kind === "text" ? 400 : 0, firstLine: "", confidence: null }));
  const [doc] = await db().insert(documents).values({ sha256, name: `${unique()}.pdf`, bytes: data.length, pages: info, ocrStatus, createdBy: "test" }).returning();
  return doc!;
}

describe("OCR at upload", () => {
  it("queues a scan, reads it in the background, keeps the result by the file's hash and updates its pages", async () => {
    const study = await newStudy();
    const file = await upload(study, await pdf("text", "blank", "blank"));
    const done = await status(file.id, "done");

    expect(done).toMatchObject({ ocrPagesDone: 2, ocrError: null });
    expect(done.pages).toEqual([
      expect.objectContaining({ page: 1, kind: "text", confidence: null }),
      { page: 2, kind: "ocr", chars: 10, firstLine: expect.any(String), confidence: 90 },
      { page: 3, kind: "ocr", chars: 10, firstLine: expect.any(String), confidence: 90 },
    ]);
    expect(JSON.parse(await readFile(ocrPath(done.sha256), "utf8"))).toMatchObject({ version: OCR_VERSION, pages: [{ page: 2 }, { page: 3 }] });
    expect(callsFor(done.sha256)).toBe(1);
  });

  it("leaves a document with a text layer alone", async () => {
    const file = await upload(await newStudy(), await pdf("text", "text"));
    expect(await row(file.id)).toMatchObject({ ocrStatus: "none", ocrPagesDone: 0 });
  });

  it("doesn't read the same file again when it is uploaded to another study", async () => {
    const data = await pdf("blank");
    const first = await upload(await newStudy(), data);
    const { sha256 } = await status(first.id, "done");
    const second = await upload(await newStudy(), data);
    expect(second.id).toBe(first.id);
    expect(await row(first.id)).toMatchObject({ ocrStatus: "done" });
    expect(callsFor(sha256)).toBe(1);
  });

  it("shows the study page the OCR state, the scanned pages and the ones that were hard to read", async () => {
    engine = async (_sha, scans, onPage) => {
      onPage(scans.length, scans.length);
      return scans.map((page) => ({ page, words: [word("x", page === 3 ? 60 : 95)], confidence: page === 3 ? 60 : 95, rotation: 0 }));
    };
    const study = await newStudy();
    const file = await upload(study, await pdf("text", "blank", "blank"));
    await status(file.id, "done");
    const [doc] = (await call("GET", `/studies/${study}`)).json().documents;
    expect(doc).toMatchObject({ id: file.id, pageCount: 3, scannedPages: [2, 3], lowConfidencePages: [3], ocr: { status: "done", pagesDone: 2, pagesTotal: 2, error: null } });
  });
});

describe("progress", () => {
  it("saves how many scanned pages are done while the job runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    engine = async (_sha, scans, onPage) => {
      onPage(1, scans.length);
      await gate;
      onPage(scans.length, scans.length);
      return scans.map((page) => ({ page, words: [word("x", 90)], confidence: 90, rotation: 0 }));
    };
    const study = await newStudy();
    const file = await upload(study, await pdf("blank", "blank", "blank"));
    await until("one page done", async () => (await row(file.id)).ocrPagesDone === 1);
    expect(await row(file.id)).toMatchObject({ ocrStatus: "running" });
    expect((await call("GET", `/studies/${study}`)).json().documents[0].ocr).toEqual({ status: "running", pagesDone: 1, pagesTotal: 3, error: null });
    release();
    expect(await status(file.id, "done")).toMatchObject({ ocrPagesDone: 3 });
  });
});

describe("failure and retry", () => {
  it("tries again by itself when the first attempt fails", async () => {
    let attempts = 0;
    engine = async (sha, scans, onPage) => {
      if (++attempts === 1) throw new Error("the engine stopped");
      return readsOk(90)(sha, scans, onPage);
    };
    const file = await upload(await newStudy(), await pdf("blank"));
    const done = await status(file.id, "done");
    expect([attempts, done.ocrError]).toEqual([2, null]);
  });

  it("gives up after three attempts with a plain reason, and uploading the file again tries once more", async () => {
    engine = async () => {
      throw new Error("the engine stopped: secret contract text");
    };
    const study = await newStudy();
    const data = await pdf("blank");
    const file = await upload(study, data);
    const failed = await status(file.id, "failed");
    expect(callsFor(failed.sha256)).toBe(3);
    expect(failed.ocrError).toBe("The scanned pages couldn't be read. Upload the file again to try once more, or upload a clearer scan.");
    expect(failed.ocrError).not.toContain("secret");
    expect(failed.pages.every((p) => p.kind === "image")).toBe(true);

    engine = readsOk(90);
    await upload(study, data);
    expect(await status(file.id, "done")).toMatchObject({ ocrError: null });
  });
});

describe("restart", () => {
  it.each(["queued", "running", "none"] as const)("queues a scan again at startup when its job was lost (%s)", async (state) => {
    const doc = await seedScan(state);
    await start();
    expect(await status(doc.id, "done")).toMatchObject({ pages: expect.arrayContaining([expect.objectContaining({ page: 1, kind: "ocr" })]) });
    expect(callsFor(doc.sha256)).toBe(1);
  });

  it("leaves a document that already failed alone", async () => {
    const doc = await seedScan("failed");
    await start();
    expect((await row(doc.id)).ocrStatus).toBe("failed");
    expect(callsFor(doc.sha256)).toBe(0);
  });

  it("reads a scan again when its saved result is from another version of OCR", async () => {
    const doc = await seedScan("done");
    await db().update(documents).set({ pages: doc.pages.map((p) => (p.kind === "image" ? { ...p, kind: "ocr" as const, confidence: 90 } : p)) }).where(eq(documents.id, doc.id));
    await writeFile(ocrPath(doc.sha256), JSON.stringify({ version: "an-older-ocr", pages: [] }));
    await start();
    await until("read again", async () => callsFor(doc.sha256) === 1 && (await row(doc.id)).ocrStatus === "done");
    expect(await readOcr(doc.sha256)).toHaveLength(2);
  });
});

describe("loading a stored document", () => {
  it("applies the saved OCR result: the scanned pages come back as OCR pages with their words", async () => {
    const doc = await seedScan("done");
    forgetStored(doc.sha256);
    expect((await loadStored(doc.sha256)).pages.map((p) => p.kind)).toEqual(["image", "text", "image"]);

    await writeFile(ocrPath(doc.sha256), JSON.stringify({ version: OCR_VERSION, pages: [1, 3].map((page) => ({ page, words: [word("Startup", 88)], confidence: 88, rotation: 0 })) }));
    forgetStored(doc.sha256);
    const loaded = await loadStored(doc.sha256);
    expect(loaded.pages.map((p) => p.kind)).toEqual(["ocr", "text", "ocr"]);
    expect(loaded.pages[0]).toMatchObject({ confidence: 88, words: [expect.objectContaining({ text: "Startup" })] });
  });

  it("leaves the scans as images when the saved result is from another version of OCR", async () => {
    const doc = await seedScan("done");
    await writeFile(ocrPath(doc.sha256), JSON.stringify({ version: "an-older-ocr", pages: [1, 3].map((page) => ({ page, words: [], confidence: 90 })) }));
    forgetStored(doc.sha256);
    expect((await loadStored(doc.sha256)).pages.map((p) => p.kind)).toEqual(["image", "text", "image"]);
  });
});
