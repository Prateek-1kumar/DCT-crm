import type { Rulebook } from "@dct/shared";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { locateVersion, pdfReader, stopDetector } from "@dct/harness";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { documents, parties, studies, versions } from "../src/db/schema.js";
import { forgetStored } from "../src/lib/docs.js";
import { savePdf, scanStore } from "../src/lib/storage.js";
import type { App, Built } from "./helpers.js";

let built: Built;
let app: App;
beforeAll(async () => {
  built = await buildApp();
  app = built.app;
});
afterAll(async () => {
  config.locateScans = false;
  await app.close();
  await stopDetector();
});

const db = () => built.ctx.db;

/** A scan: the PDF holds only a picture of a drawn page, as a scanner makes, and a transcription of it is saved. */
async function scannedPage() {
  const text = await PDFDocument.create();
  const font = await text.embedFont(StandardFonts.Helvetica);
  const drawn = text.addPage([612, 792]);
  drawn.drawText("Startup fee $1,500.00 due on signing", { x: 60, y: 792 * 0.7, size: 12, font });
  drawn.drawText(randomUUID(), { x: 60, y: 100, size: 6, font });
  const path = `${config.uploadDir}/drawn-${randomUUID()}.pdf`;
  await mkdir(config.uploadDir, { recursive: true });
  await writeFile(path, await text.save());
  const png = await pdfReader.render(await pdfReader.load(path), 1, { dpi: 200 });

  const image = await PDFDocument.create();
  image.addPage([612, 792]).drawImage(await image.embedPng(png), { x: 0, y: 0, width: 612, height: 792 });
  const sha256 = await savePdf(Buffer.from(await image.save()));
  // the model's guess is a row off, as it often is: the real line is at 0.30 from the top
  const lines = [{ text: "Startup fee $1,500.00 due on signing", top: 0.33, bottom: 0.35, unsure: false, marks: [] }];
  await scanStore.put(sha256, { page: 1, version: "test", rotation: 0, transcription: { rotation: 0, lines, tables: [] } });
  const [doc] = await db().insert(documents).values({ sha256, name: "scan.pdf", bytes: 1, pages: [{ page: 1, kind: "scan", chars: 36, firstLine: "Startup fee" }], createdBy: "test" }).returning();
  return { sha256, documentId: doc!.id };
}

async function versionOf(documentId: string) {
  const [sponsor, site] = await db().insert(parties).values([{ kind: "sponsor", name: `Sponsor ${randomUUID()}`, createdBy: "test" }, { kind: "site", name: `Site ${randomUUID()}`, createdBy: "test" }]).returning();
  const [s] = await db().insert(studies).values({ protocol: `P-${randomUUID()}`, sponsorId: sponsor!.id, siteId: site!.id, createdBy: "test" }).returning();
  const rulebook: Rulebook = { study: { protocol: "P", sponsor: "S", payer: null, siteEntity: "E", siteNumber: null, pi: null, effectiveDate: null, documents: [] }, terms: [], grids: [], accounted: [], questions: [] };
  const [v] = await db().insert(versions).values({ studyId: s!.id, number: 1, status: "draft", documentIds: [documentId], rulebook, problems: [], createdBy: "test" }).returning();
  return v!.id;
}

describe("highlights on a scan that was read before OCR located its words", () => {
  it("are approximate at first, then exact on the next load once the background pass has finished, with no re-read", async () => {
    config.locateScans = true;
    const { sha256, documentId } = await scannedPage();
    const id = await versionOf(documentId);
    const coverage = async () => (await app.inject({ url: `/api/v1/versions/${id}/coverage` })).json().pages[0].amounts[0] as { box: number[]; approx?: true };

    const before = await coverage();
    expect(before.approx).toBe(true);
    expect(before.box[0]).toBe(0);
    expect(before.box[2]).toBe(1);

    // the pass runs behind the request; wait for its result to be saved
    for (let n = 0; n < 100 && !(await scanStore.locate!.get(sha256)).length; n++) await new Promise((r) => setTimeout(r, 200));
    const saved = await scanStore.locate!.get(sha256);
    expect(saved).toMatchObject([{ page: 1, version: locateVersion, rotation: 0 }]);
    forgetStored(sha256);

    const after = await coverage();
    expect(after.approx).toBeUndefined();
    // the amount's own words, on the line it is printed on rather than the one the model guessed
    expect(after.box[0]).toBeGreaterThan(0.1);
    expect(after.box[2]).toBeLessThan(0.6);
    expect(after.box[1]).toBeLessThan(0.31);
    expect(after.box[3]).toBeGreaterThan(0.29);
  }, 60_000);

  it("stay approximate, and a request still succeeds, when OCR is off", async () => {
    config.locateScans = false;
    const { documentId } = await scannedPage();
    const id = await versionOf(documentId);
    const res = await app.inject({ url: `/api/v1/versions/${id}/coverage` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pages[0].amounts[0].approx).toBe(true);
  });
});
