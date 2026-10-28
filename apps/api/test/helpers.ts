import { type DocumentDto, type JobDto, type RulebookVersionDto, settled } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildApp } from "../src/app.js";
import { rulebookVersions } from "../src/db/schema.js";
import { at, empty } from "../src/review.js";

export type Built = Awaited<ReturnType<typeof buildApp>>;
export type App = Built["app"];

export async function testApp(): Promise<Built> {
  if (!process.env.DATABASE_URL?.includes("_test")) throw new Error("tests must use the _test database");
  return buildApp();
}

export async function resetDb({ ctx }: Built) {
  // TRUNCATE bypasses the row-level append-only trigger; fine for a test database.
  await ctx.db.execute(sql`TRUNCATE audit_log, jobs, rulebook_versions, study_documents, documents, studies RESTART IDENTITY CASCADE`);
  await ctx.db.execute(sql`UPDATE settings SET people = '[]', maker_checker = false`);
}

/** A real (tiny) PDF with no text layer, so it reads as a scan. `seed` makes the bytes, and so the sha256, distinct. */
export async function makePdf(seed: string, pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(seed);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

/**
 * A born-digital work order printing what the fake read says (src/extraction/fake.ts), so the PDF checks run for real:
 * terms on page 1, the budget grid on page 2. Printed once, the grid backs both fake grids; "Exhibit A (revised)" reads
 * its Week 0 total as 8,488.00, which the page doesn't print. Parking at $12.00 is a money term the read doesn't hold.
 */
export async function makeTextPdf(seed: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(seed);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const filler = "This page continues the agreement between the parties and the site, as set out above in full detail.";
  const page = (lines: [number, number, string][]) => {
    const p = doc.addPage([612, 792]);
    for (const [x, y, text] of [...lines, [40, 700, filler], [40, 720, filler]] as const) p.drawText(text, { x, y: 792 - y, size: 8, font });
  };
  page([
    [40, 60, "UNSCH Unscheduled visit $572.00 $800.00 per occurrence"],
    [40, 80, "SC003 Administrative fee $12,000.00 due at study initiation."],
    [40, 100, "Each screen failure is paid at $7,455.00 per subject"],
    [40, 120, "Sponsor will reimburse parking at $12.00 per subject visit."],
  ]);
  const rows = [
    ["Code", "Procedure", "Unit", "V1", "V2"],
    ["36415", "Blood draw", "55.00", "55.00", "55.00"],
    ["", "Procedure subtotal", "", "3,801.00", "4,047.00"],
    ["", "Overhead", "", "2,130.00", "2,425.00"],
    ["", "Non-procedure subtotal", "", "1,524.00", "2,016.00"],
    ["", "Visit total", "", "7,455.00", "8,489.00"],
  ];
  const cols = [40, 90, 220, 280, 340];
  // the per-patient total sits outside the visit columns, so it isn't read as a visit row
  page([...rows.flatMap((r, i) => r.flatMap((text, c) => (text ? [[cols[c]!, 80 + 14 * i, text] as [number, number, string]] : []))), [90, 164, "Total"], [480, 164, "$15,943.00"]]);
  return Buffer.from(await doc.save());
}

/** Serialise multipart/form-data with the platform FormData encoder. */
export async function multipart(files: { name: string; data: Buffer }[], fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files[]", new Blob([new Uint8Array(f.data)], { type: "application/pdf" }), f.name);
  const req = new Request("http://local/", { method: "POST", body: fd });
  return { payload: Buffer.from(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } };
}

export async function upload(app: App, files: { name: string; data: Buffer }[], fields?: Record<string, string>) {
  const { payload, headers } = await multipart(files, fields);
  return app.inject({ method: "POST", url: "/api/v1/uploads", payload, headers });
}

export async function waitJob(app: App, id: string, timeoutMs = 20_000): Promise<JobDto> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = (await app.inject({ url: `/api/v1/jobs/${id}` })).json<JobDto>();
    if (job.state === "succeeded" || job.state === "failed") return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

// ---- the workflow, through the API (fake extraction) ----

/** Uploads one file, creates the study and waits for the documents to be identified. A text PDF unless `scan`. */
export async function newStudy(app: App, seed: string, { scan = false, name = "Work Order.pdf" } = {}) {
  const [doc] = (await upload(app, [{ name, data: scan ? await makePdf(seed) : await makeTextPdf(seed) }])).json<DocumentDto[]>();
  const res = await app.inject({ method: "POST", url: "/api/v1/studies", payload: { documentIds: [doc!.id] } });
  const { studyId, jobId } = res.json<{ studyId: string; jobId: string }>();
  await waitJob(app, jobId);
  return { studyId, doc: doc! };
}

export async function extract(app: App, studyId: string, body: object = {}) {
  const res = await app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/extract`, payload: body });
  const { jobId, version } = res.json<{ jobId: string; version: number }>();
  return { job: await waitJob(app, jobId), v: version };
}

/** The stored version, hidden values and all: only a test may look. */
export async function storedVersion({ ctx }: Built, studyId: string, version: number) {
  const [row] = await ctx.db.select().from(rulebookVersions).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, version)));
  return row!;
}

/**
 * Answers every question not settled yet: the first option, or the value the master holds (on a differs, the same value
 * again with a note). `n` stops after that many.
 */
export async function settleAll(built: Built, studyId: string, version: number, by = "Asha", n = Infinity) {
  const row = await storedVersion(built, studyId, version);
  for (const i of row.review.filter((x) => !settled(x)).slice(0, n)) {
    const current = i.path ? at(row.rulebook, i.path) : undefined;
    const body = i.options.length ? { optionId: i.options[0]!.id } : { value: empty(current) ? (i.input === "date" ? "2026-01-01" : i.input === "text" ? "x" : 1) : current, note: "checked" };
    for (let tries = 0; tries < 2; tries++) {
      const res = await built.app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/versions/${version}/review/${encodeURIComponent(i.id)}`, payload: { ...body, by } });
      if (res.statusCode !== 200) throw new Error(`${i.id}: ${res.body}`);
      if (res.json<RulebookVersionDto>().review.find((x) => x.id === i.id)!.outcome !== "differs") break;
    }
  }
}

/** A study whose first version is approved by Ben after Asha answered everything. */
export async function liveStudy(built: Built, seed = "live", opts?: { scan?: boolean }) {
  const s = await newStudy(built.app, seed, opts);
  await extract(built.app, s.studyId);
  await settleAll(built, s.studyId, 1);
  const res = await built.app.inject({ method: "POST", url: `/api/v1/studies/${s.studyId}/versions/1/sign-off`, payload: { by: "Ben" } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return s;
}
