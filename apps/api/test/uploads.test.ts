import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DocumentDto } from "@dct/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { type App, type Built, makePdf, makeTextPdf, resetDb, testApp, upload } from "./helpers.js";

let app: App;
let built: Built;
beforeAll(async () => {
  built = await testApp();
  app = built.app;
});
afterAll(() => app.close());
beforeEach(() => resetDb(built));

describe("POST /api/v1/uploads", () => {
  it("stores a PDF by sha256 with its page count", async () => {
    const pdf = await makePdf("wo", 3);
    const res = await upload(app, [{ name: "Work Order.pdf", data: pdf }]);
    expect(res.statusCode).toBe(201);
    const [doc] = res.json<DocumentDto[]>();
    const sha = createHash("sha256").update(pdf).digest("hex");
    expect(doc).toMatchObject({ filename: "Work Order.pdf", sha256: sha, kind: "other", pageCount: 3, duplicateOf: null, text: "scan" }); // no text layer
    const [typed] = (await upload(app, [{ name: "e-signed.pdf", data: await makeTextPdf("wo") }])).json<DocumentDto[]>();
    expect(typed!.text).toBe("text");
    expect(existsSync(path.join(config.uploadDir, `${sha}.pdf`))).toBe(true);
  });

  it("returns the existing document for a duplicate, never a second copy", async () => {
    const pdf = await makePdf("dup");
    const [first] = (await upload(app, [{ name: "a.pdf", data: pdf }])).json<DocumentDto[]>();
    const res = await upload(app, [
      { name: "renamed copy.pdf", data: pdf },
      { name: "again.pdf", data: pdf },
    ]);
    const docs = res.json<DocumentDto[]>();
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d).toMatchObject({ id: first!.id, duplicateOf: first!.id, filename: "a.pdf" });
    const sha = first!.sha256;
    expect(readdirSync(config.uploadDir).filter((f) => f.startsWith(sha))).toEqual([`${sha}.pdf`]);
  });

  it("rejects non-PDF files", async () => {
    const res = await upload(app, [{ name: "notes.pdf", data: Buffer.from("hello, not a pdf") }]);
    expect(res.statusCode).toBe(415);
  });

  it("rejects a request without files", async () => {
    const res = await upload(app, []);
    expect(res.statusCode).toBe(400);
  });

  it("serves a page image and caches it on disk", async () => {
    const [doc] = (await upload(app, [{ name: "p.pdf", data: await makePdf("pages", 2) }])).json<DocumentDto[]>();
    const res = await app.inject({ url: `/api/v1/documents/${doc!.id}/pages/2.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    // a real render even in fake mode (200 pt page at 150 dpi), not a 1×1 placeholder
    expect(res.rawPayload.readUInt32BE(16)).toBeGreaterThan(400);
    expect(existsSync(path.join(config.uploadDir, "pages", `${doc!.sha256}-2.png`))).toBe(true);
    const cached = await app.inject({ url: `/api/v1/documents/${doc!.id}/pages/2.png` });
    expect(cached.rawPayload.equals(res.rawPayload)).toBe(true);
    expect((await app.inject({ url: `/api/v1/documents/${doc!.id}/pages/3.png` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/documents/not-a-uuid/pages/1.png` })).statusCode).toBe(400);
  });

  it("sets a document's kind and audits it", async () => {
    const [doc] = (await upload(app, [{ name: "x.pdf", data: await makePdf("kind") }])).json<DocumentDto[]>();
    const res = await app.inject({ method: "PATCH", url: `/api/v1/documents/${doc!.id}`, payload: { kind: "budget", by: "Asha" } });
    expect(res.json()).toMatchObject({ kind: "budget" });
    expect((await app.inject({ method: "PATCH", url: `/api/v1/documents/${doc!.id}`, payload: { kind: "nope", by: "Asha" } })).statusCode).toBe(400);
    const audit = (await app.inject({ url: "/api/v1/audit" })).json<{ action: string; by: string }[]>();
    expect(audit.map((a) => a.action)).toEqual(["document.kind_set", "document.uploaded"]); // newest first
    expect(audit[0]!.by).toBe("Asha");
  });
});
