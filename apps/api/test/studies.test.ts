import { eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Region } from "@dct/shared";
import { auditLog } from "../src/db/schema.js";
import { type App, type Built, multipart, testApp } from "./helpers.js";

let built: Built;
let app: App;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api/v1${url}`, payload });
const unique = () => Math.random().toString(36).slice(2, 8);

const SENTENCE = "Sponsor pays the Institution within forty-five days of an itemized invoice for work done under this budget. ";

/** A PDF with one page per entry: a page of text, or a blank one (no text layer, so it reads as a scan). */
async function pdf(...pages: ("text" | "blank")[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const stamp = unique();
  for (const kind of pages) {
    const page = doc.addPage([612, 792]);
    if (kind === "text") {
      page.drawText(`Exhibit ${stamp}`, { x: 50, y: 740, size: 14, font });
      for (let i = 0; i < 3; i++) page.drawText(SENTENCE, { x: 50, y: 700 - i * 20, size: 7, font });
    }
  }
  return Buffer.from(await doc.save());
}

const party = async (kind: string, name: string, aliases?: string[]) => (await call("POST", "/parties", { kind, name, aliases, by: "Asha" })).json();

async function newStudy() {
  const res = await call("POST", "/studies", { by: "Asha" });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function uploadBy(studyId: string, files: { name: string; data: Buffer }[], by = "Asha") {
  const fd = new FormData();
  fd.append("by", by);
  for (const f of files) fd.append("files[]", new Blob([new Uint8Array(f.data)]), f.name);
  const req = new Request("http://local/", { method: "POST", body: fd });
  return app.inject({
    method: "POST",
    url: `/api/v1/studies/${studyId}/documents`,
    payload: Buffer.from(await req.arrayBuffer()),
    headers: { "content-type": req.headers.get("content-type")! },
  });
}

const auditFor = (entityId: string) => built.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);

describe("parties", () => {
  it("finds a party by its name or an alias, ignoring case and punctuation", async () => {
    const tag = unique();
    const merck = await party("sponsor", `Merck Sharp & Dohme LLC ${tag}`, ["MSD"]);
    const other = await party("cro", `Merck Services ${tag}`);
    const names = async (qs: string) => (await call("GET", `/parties?${qs}`)).json().map((p: { id: string }) => p.id);
    expect(await names("q=Merck")).toContain(merck.id);
    expect(await names(`q=sharp%26dohme&kind=sponsor`)).toContain(merck.id);
    expect(await names(`q=msd`)).toContain(merck.id);
    expect(await names(`q=merck&kind=sponsor`)).not.toContain(other.id);
    expect(await names(`q=zzzz${tag}`)).toEqual([]);
  });

  it("adds an alias once, however it is punctuated", async () => {
    const p = await party("site", `Hospital ${unique()}`);
    const added = await call("POST", `/parties/${p.id}/aliases`, { alias: "St. Mary's", by: "Asha" });
    expect(added.json().aliases).toEqual(["St. Mary's"]);
    const again = await call("POST", `/parties/${p.id}/aliases`, { alias: "ST MARYS", by: "Asha" });
    expect([again.statusCode, again.json().message]).toEqual([409, `${p.name} is already known as "ST MARYS".`]);
    expect((await auditFor(p.id)).map((a) => a.action)).toEqual(["party.create", "party.alias"]);
  });

  it("refuses a bad request in plain words", async () => {
    expect((await call("POST", "/parties", { kind: "vendor", name: "X", by: "Asha" })).json().message).toBe("Say whether this is a sponsor, a CRO or a site.");
    expect((await call("POST", "/parties", { kind: "site", name: "X" })).json().message).toBe("Say who is doing this: pick your name first.");
    expect((await call("POST", "/parties", { kind: "site", name: "&&&", by: "Asha" })).statusCode).toBe(400);
  });
});

describe("studies", () => {
  it("starts bare: just who started it, with nothing filled in until the contract is read", async () => {
    const res = await call("POST", "/studies", { by: "Asha" });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect(Object.keys(res.json())).toEqual(["id"]);
    expect((await auditFor(id)).map((a) => [a.action, a.by])).toEqual([["study.create", "Asha"]]);

    const list = (await call("GET", "/studies")).json().find((s: { id: string }) => s.id === id);
    expect(list).toMatchObject({ protocol: null, sponsor: null, payer: null, site: null, firstDocument: null, latestVersion: null });
    expect((await call("GET", `/studies/${id}`)).json()).toMatchObject({ protocol: null, sponsor: null, payer: null, site: null, documents: [], versions: [] });
  });

  it("needs to know who is doing it", async () => {
    const res = await call("POST", "/studies", {});
    expect([res.statusCode, res.json().message]).toEqual([400, "Say who is doing this: pick your name first."]);
  });

  it("lists the first document uploaded as the study's name until it is read", async () => {
    const study = await newStudy();
    await uploadBy(study.id, [{ name: "first.pdf", data: await pdf("text") }]);
    await uploadBy(study.id, [{ name: "second.pdf", data: await pdf("text") }]);
    const list = (await call("GET", "/studies")).json().find((s: { id: string }) => s.id === study.id);
    expect(list.firstDocument).toBe("first.pdf");
  });

  it("says so when a study doesn't exist", async () => {
    const res = await call("GET", "/studies/00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(404);
  });
});

describe("documents", () => {
  it("stores a PDF, reports its scanned pages, and records who added it", async () => {
    const study = await newStudy();
    const res = await uploadBy(study.id, [{ name: "contract.pdf", data: await pdf("text", "blank", "text", "blank") }]);
    expect(res.statusCode).toBe(200);
    const [file] = res.json();
    expect(file).toMatchObject({ name: "contract.pdf", pages: 4, scannedPages: [2, 4], alreadyInStudy: false });

    const detail = (await call("GET", `/studies/${study.id}`)).json();
    expect(detail.documents).toEqual([{ id: file.id, name: "contract.pdf", bytes: expect.any(Number), pageCount: 4, scannedPages: [2, 4], scansRead: [] }]);
    expect((await auditFor(study.id)).map((a) => a.action)).toEqual(["study.create", "study.document.add"]);
    expect((await auditFor(file.id)).map((a) => [a.action, a.by])).toEqual([["document.upload", "Asha"]]);
  });

  it("uploading a scanned PDF queues nothing and lists its scanned pages", async () => {
    const jobs = async () => Number((await built.ctx.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM pgboss.job`)).rows[0]!.n);
    const study = await newStudy();
    const before = await jobs();
    const [file] = (await uploadBy(study.id, [{ name: "scan.pdf", data: await pdf("blank", "text", "blank") }])).json();
    expect(file).toMatchObject({ pages: 3, scannedPages: [1, 3] });

    const [doc] = (await call("GET", `/studies/${study.id}`)).json().documents;
    expect(doc).toEqual({ id: file.id, name: "scan.pdf", bytes: expect.any(Number), pageCount: 3, scannedPages: [1, 3], scansRead: [] });
    expect(await jobs()).toBe(before);
  });

  it("refuses what isn't a PDF, naming the file, and stores nothing", async () => {
    const study = await newStudy();
    const res = await uploadBy(study.id, [{ name: "notes.pdf", data: Buffer.from("just some text") }]);
    expect([res.statusCode, res.json().message]).toEqual([400, `"notes.pdf" isn't a PDF. Upload PDF files only.`]);
    expect((await call("GET", `/studies/${study.id}`)).json().documents).toEqual([]);
  });

  it("refuses a broken PDF, naming the file, and stores nothing", async () => {
    const study = await newStudy();
    const res = await uploadBy(study.id, [{ name: "broken.pdf", data: Buffer.from("%PDF-1.7\nthis is not really a pdf") }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^"broken\.pdf": This file isn't a readable PDF\./);
    expect((await call("GET", `/studies/${study.id}`)).json().documents).toEqual([]);
  });

  it("needs at least one file and a name", async () => {
    const study = await newStudy();
    expect((await uploadBy(study.id, [])).json().message).toBe("Choose at least one PDF to upload.");
    const { payload, headers } = await multipart([{ name: "a.pdf", data: await pdf("text") }]);
    const res = await app.inject({ method: "POST", url: `/api/v1/studies/${study.id}/documents`, payload, headers });
    expect(res.json().message).toBe("Say who is doing this: pick your name first.");
  });

  it("reuses the same content, and says when it is already in the study", async () => {
    const data = await pdf("text");
    const first = await newStudy();
    const second = await newStudy();
    const a = (await uploadBy(first.id, [{ name: "a.pdf", data }])).json()[0];
    const again = (await uploadBy(first.id, [{ name: "a.pdf", data }])).json()[0];
    expect(again).toMatchObject({ id: a.id, alreadyInStudy: true });
    const elsewhere = (await uploadBy(second.id, [{ name: "renamed.pdf", data }])).json()[0];
    expect(elsewhere).toMatchObject({ id: a.id, name: "a.pdf", alreadyInStudy: false });
    expect((await call("GET", `/studies/${first.id}`)).json().documents).toHaveLength(1);
  });

  it("refuses a different file with the same name, and keeps the rest of that upload out too", async () => {
    const study = await newStudy();
    await uploadBy(study.id, [{ name: "budget.pdf", data: await pdf("text") }]);
    const res = await uploadBy(study.id, [
      { name: "other.pdf", data: await pdf("text") },
      { name: "budget.pdf", data: await pdf("text") },
    ]);
    expect([res.statusCode, res.json().message]).toEqual([409, `This study already has a different file called "budget.pdf". Rename the new one so the two can be told apart, or remove the old one first.`]);
    expect((await call("GET", `/studies/${study.id}`)).json().documents.map((d: { name: string }) => d.name)).toEqual(["budget.pdf"]);
  });

  it("unlinks a document without deleting it", async () => {
    const study = await newStudy();
    const doc = (await uploadBy(study.id, [{ name: "a.pdf", data: await pdf("text") }])).json()[0];
    const url = `/studies/${study.id}/documents/${doc.id}`;
    expect((await call("DELETE", url)).json().message).toBe("Say who is doing this: pick your name first.");
    expect((await call("DELETE", `/studies/${study.id}/documents/nope?by=Asha`)).json().message).toBe("Malformed id");
    expect((await call("DELETE", `${url}?by=Asha`)).json()).toEqual({ ok: true });
    expect((await call("GET", `/studies/${study.id}`)).json().documents).toEqual([]);
    expect((await call("DELETE", `${url}?by=Asha`)).json().message).toBe("That document isn't in this study.");
    expect((await call("GET", `/documents/${doc.id}/pages/1/text`)).statusCode).toBe(200);
    expect((await auditFor(study.id)).map((a) => a.action)).toEqual(["study.create", "study.document.add", "study.document.remove"]);
  });
});

/** PNG size from its header, so a test needn't decode the picture. */
const sizeOf = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

/** One page of the given size in points, with the given lines of text (a bank line is masked on load). */
async function sizedPdf(width: number, height: number, lines: string[] = []) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([width, height]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: height - 100 - i * 30, size: 14, font }));
  return Buffer.from(await doc.save());
}

describe("page image regions and sharpness", () => {
  const upload = async (data: Buffer) => (await uploadBy((await newStudy()).id, [{ name: `${unique()}.pdf`, data }])).json()[0].id as string;
  const image = (docId: string, qs: string) => call("GET", `/documents/${docId}/pages/1/image?${qs}`);
  let letter: string;
  let huge: string;
  beforeAll(async () => {
    letter = await upload(await sizedPdf(612, 792));
    huge = await upload(await sizedPdf(2000, 2000));
  });

  it("the uploaded file can be downloaded again as it was, and a document that doesn't exist says so", async () => {
    const res = await call("GET", `/documents/${letter}/file`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment; filename=".+\.pdf"; filename\*=UTF-8''.+\.pdf$/);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await call("GET", "/documents/00000000-0000-4000-8000-000000000000/file")).statusCode).toBe(404);
  });

  it("a crop is the region's size at the dpi of the whole page, and still cached for good", async () => {
    const res = await image(letter, "dpi=72&region=0,0,0.5,0.25");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(sizeOf(res.rawPayload)).toEqual({ w: 306, h: 198 });
    expect(sizeOf((await image(letter, "dpi=144&region=0.5,0.5,1,1")).rawPayload)).toEqual({ w: 612, h: 792 });
    expect(sizeOf((await image(letter, "dpi=300&region=0,0,1,1")).rawPayload)).toEqual({ w: 2550, h: 3300 });
    expect(sizeOf((await image(letter, "dpi=300")).rawPayload)).toEqual({ w: 2550, h: 3300 });
    expect(sizeOf((await image(letter, "")).rawPayload)).toEqual({ w: 934, h: 1210 });
  });

  it("clamps an oversize picture to 4096 px on a side and 16 megapixels instead of refusing it", async () => {
    // 2000 pt square at 300 dpi would be 8333 px: the megapixel cap is what binds
    const square = sizeOf((await image(huge, "dpi=300")).rawPayload);
    expect(square.w * square.h).toBeLessThanOrEqual(16e6);
    expect(square.w).toBeGreaterThan(3900);
    // a thin strip is small in area but 8333 px tall: the 4096 side cap is what binds, and the width follows it down
    const strip = sizeOf((await image(huge, "dpi=300&region=0,0,0.01,1")).rawPayload);
    expect(strip.h).toBeGreaterThan(4000);
    expect(strip.h).toBeLessThanOrEqual(4096);
    expect(strip.w).toBeLessThan(60);
  });

  it("refuses a bad dpi or region in plain words", async () => {
    const dpi = "dpi must be a whole number from 1 to 300.";
    const regionWords = "region must be four numbers from 0 to 1, separated by commas: left, top, right, bottom.";
    const inside = "region must stay inside the page: every number from 0 to 1.";
    const order = "region must run from the top left to the bottom right: left must be below right, and top below bottom.";
    const small = "region must be at least 1% of the page wide and tall.";
    const cases: [string, string][] = [
      ["dpi=0", dpi], ["dpi=301", dpi], ["dpi=1.5", dpi], ["dpi=abc", dpi],
      ["region=", regionWords], ["region=0,0,1", regionWords], ["region=0,0,1,1,1", regionWords], ["region=a,0,1,1", regionWords], ["region=0,,1,1", regionWords], ["region=0,0,1,1&region=0,0,1,1", regionWords],
      ["region=-0.1,0,1,1", inside], ["region=0,0,1.1,1", inside],
      ["region=0.5,0,0.5,1", order], ["region=0.6,0,0.5,1", order], ["region=0,0.9,1,0.1", order],
      ["region=0,0,0.005,1", small], ["region=0,0,1,0.009", small],
    ];
    for (const [qs, message] of cases) {
      const res = await image(letter, qs);
      expect([qs, res.statusCode, res.json().message]).toEqual([qs, 400, message]);
    }
    expect((await image(letter, "region=0,0,0.01,0.01")).statusCode).toBe(200);
    expect((await image(letter, "dpi=1")).statusCode).toBe(200);
    expect((await call("GET", `/documents/${letter}/pages/2/image?region=0,0,1,1`)).statusCode).toBe(404);
  });

  it("a crop of a page with bank details is masked just as the whole page is", async () => {
    const id = await upload(await sizedPdf(612, 792, ["Account number 123456789012", "Ordinary sentence below it."]));
    type Box = { text: string; x0: number; y0: number; x1: number; y1: number };
    const { words } = (await call("GET", `/documents/${id}/pages/1/text`)).json() as { words: Box[] };
    const hidden = words.find((w) => /^#+$/.test(w.text))!;
    expect(hidden).toBeDefined();
    const blackShare = async (qs: string, box: [number, number, number, number]) => {
      const img = await loadImage((await image(id, qs)).rawPayload);
      const canvas = createCanvas(img.width, img.height);
      const g = canvas.getContext("2d");
      g.drawImage(img, 0, 0);
      const [x0, y0, x1, y1] = [Math.round(box[0] * img.width), Math.round(box[1] * img.height), Math.round(box[2] * img.width), Math.round(box[3] * img.height)] as const;
      const { data } = g.getImageData(x0, y0, x1 - x0, y1 - y0);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! < 10 && data[i + 1]! < 10 && data[i + 2]! < 10) dark++;
      return dark / (data.length / 4);
    };
    // the crop's own coordinates: the word's box measured from the crop's top left
    const r: Region = [Math.max(0, hidden.x0 - 0.05), Math.max(0, hidden.y0 - 0.02), Math.min(1, hidden.x1 + 0.05), Math.min(1, hidden.y1 + 0.02)];
    const local = (v: number, lo: number, span: number) => (v - lo) / span;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    const inCrop: [number, number, number, number] = [local(hidden.x0, r[0], w), local(hidden.y0, r[1], h), local(hidden.x1, r[0], w), local(hidden.y1, r[1], h)];
    expect(await blackShare(`dpi=200&region=${r.join(",")}`, inCrop)).toBe(1);
    expect(await blackShare("dpi=200", [hidden.x0, hidden.y0, hidden.x1, hidden.y1])).toBe(1);
    // the ordinary sentence below is not painted over
    const plain = words.find((w) => w.text === "Ordinary")!;
    expect(await blackShare("dpi=200", [plain.x0, plain.y0, plain.x1, plain.y1])).toBeLessThan(0.5);
  });
});

describe("pages", () => {
  let docId: string;
  beforeAll(async () => {
    const study = await newStudy();
    docId = (await uploadBy(study.id, [{ name: "pages.pdf", data: await pdf("text", "blank") }])).json()[0].id;
  });

  it("serves a page image, cached for good", async () => {
    const res = await call("GET", `/documents/${docId}/pages/1/image`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    const small = await call("GET", `/documents/${docId}/pages/1/image?dpi=40`);
    expect(small.rawPayload.length).toBeLessThan(res.rawPayload.length);
    expect((await call("GET", `/documents/${docId}/pages/1/image?dpi=250`)).statusCode).toBe(200);
  });

  it("serves a page's words with their positions", async () => {
    const text = (await call("GET", `/documents/${docId}/pages/1/text`)).json();
    expect(text).toMatchObject({ page: 1, kind: "text", layout: expect.stringContaining("itemized invoice") });
    expect(text.words[0]).toMatchObject({ text: "Exhibit", x0: expect.any(Number), y1: expect.any(Number) });
    expect((await call("GET", `/documents/${docId}/pages/2/text`)).json()).toMatchObject({ page: 2, kind: "image", words: [] });
  });

  it("finds a quote's boxes on a page: one per line, none when it isn't there or the page is a scan", async () => {
    const find = (page: number, q: string) => call("GET", `/documents/${docId}/pages/${page}/find?q=${encodeURIComponent(q)}`);
    const found = await find(1, "itemized INVOICE for work");
    expect(found.statusCode).toBe(200);
    expect(found.json().boxes).toHaveLength(1);
    expect(found.json().boxes[0]).toEqual([expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect((await find(1, "Sponsor pays the Institution within forty-five days of an itemized invoice for work done under this budget. Sponsor pays")).json().boxes).toHaveLength(2);
    expect((await find(1, "no such words")).json()).toEqual({ boxes: [] });
    expect((await find(2, "itemized invoice")).json()).toEqual({ boxes: [] });
  });

  it("needs words to find, at most 1,000 characters of them", async () => {
    for (const [url, message] of [["find", "Say which words to find."], ["find?q=", "Say which words to find."], [`find?q=${"a".repeat(1001)}`, "Those words are too long to find."]] as const) {
      const res = await call("GET", `/documents/${docId}/pages/1/${url}`);
      expect([res.statusCode, res.json().message]).toEqual([400, message]);
    }
    expect((await call("GET", `/documents/${docId}/pages/1/find?q=${"a".repeat(1000)}`)).statusCode).toBe(200);
    expect((await call("GET", `/documents/${docId}/pages/3/find?q=x`)).statusCode).toBe(404);
  });

  it("refuses a page that isn't there, in plain words", async () => {
    const beyond = await call("GET", `/documents/${docId}/pages/3/text`);
    expect([beyond.statusCode, beyond.json().message]).toEqual([404, "This document has 2 pages, so there is no page 3."]);
    for (const page of ["0", "-1", "1.5", "abc"]) {
      const res = await call("GET", `/documents/${docId}/pages/${page}/image`);
      expect([res.statusCode, res.json().message]).toEqual([400, "The page must be a whole number, starting at 1."]);
    }
    expect((await call("GET", "/documents/00000000-0000-4000-8000-000000000000/pages/1/text")).statusCode).toBe(404);
  });
});
