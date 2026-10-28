import { type DocumentDto, type JobDto, type RulebookVersionDto, settled } from "@dct/shared";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildApp } from "../src/app.js";
import { rulebookVersions } from "../src/db/schema.js";
import { at, empty } from "../src/review.js";

export type Built = Awaited<ReturnType<typeof buildApp>>;
export type App = Built["app"];

/** `workers: false`: nothing runs the queued jobs, so a test can run (or strand) them itself. */
export async function testApp(opts: { workers?: boolean } = {}): Promise<Built> {
  if (!process.env.DATABASE_URL?.includes("_test")) throw new Error("tests must use the _test database");
  return buildApp(opts);
}

export async function resetDb({ ctx }: Built) {
  // TRUNCATE bypasses the row-level append-only trigger; fine for a test database.
  await ctx.db.execute(sql`TRUNCATE audit_log, jobs, rulebook_versions, study_documents, documents, studies, idempotency_keys RESTART IDENTITY CASCADE`);
  await ctx.db.execute(sql`UPDATE settings SET people = '[]', maker_checker = false`);
  // queued jobs of rows just deleted would run first, ahead of the next test's
  await ctx.db.execute(sql`DELETE FROM pgboss.job WHERE name IN ('identify', 'extract', 'stranded') AND state <> 'active'`);
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
 * terms on page 1 (the fee's due days, the effective date and the screen-fail cap in the sentences the read quotes), the
 * budget grids on page 2 (each overhead % in its row label). Each fake grid has its own titled table, as a contract
 * prints two grids: one printed row confirms one grid's cells at most. Both print the same numbers; "Exhibit A
 * (revised)" reads its Week 0 total as 8,488.00, which its table doesn't print. Parking at $12.00 is a money term the read
 * doesn't hold. Overhead %, net days and the deadline have no quote, so nothing on the page backs them.
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
    [40, 80, "SC003 Administrative fee $12,000.00 due within 45 days of study initiation."],
    [40, 100, "Each screen failure is paid at $7,455.00 per subject"],
    [40, 120, "Sponsor will reimburse parking at $12.00 per subject visit."],
    [40, 140, "This Work Order is effective as of August 22, 2025."],
    [40, 160, "Screen failures are paid up to a maximum of 7 before the Sponsor approves more."],
  ]);
  const rows = [
    ["Code", "Procedure", "Unit", "V1", "V2"],
    ["36415", "Blood draw", "55.00", "55.00", "55.00"],
    ["", "Procedure subtotal", "", "3,801.00", "4,047.00"],
    ["", "Overhead 40%", "", "2,130.00", "2,425.00"],
    ["", "Non-procedure subtotal", "", "1,524.00", "2,016.00"],
    ["", "Visit total", "", "7,455.00", "8,489.00"],
  ];
  const cols = [40, 90, 220, 280, 340];
  // the per-patient total sits outside the visit columns, so it isn't read as a visit row
  const table = (title: string, top: number): [number, number, string][] => [
    [40, top - 16, title],
    ...rows.flatMap((r, i) => r.flatMap((text, c) => (text ? [[cols[c]!, top + 14 * i, text] as [number, number, string]] : []))),
    [90, top + 84, "Total"],
    [480, top + 84, "$15,943.00"],
  ];
  page([...table("Exhibit A", 80), ...table("Exhibit A (revised)", 240)]);
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
 * again with a note), and then any an answer raised (a grid's totals checked again). `n` stops after that many.
 */
export async function settleAll(built: Built, studyId: string, version: number, by = "Asha", n = Infinity): Promise<void> {
  const row = await storedVersion(built, studyId, version);
  const open = row.review.filter((x) => !settled(x));
  if (!open.length || n <= 0) return;
  for (const i of open.slice(0, n)) {
    const current = i.path ? at(row.rulebook, i.path) : undefined;
    const body = i.options.length ? { optionId: i.options[0]!.id, note: "checked" } : { value: empty(current) ? (i.input === "date" ? "2026-01-01" : i.input === "text" ? "x" : 1) : current, note: "checked" };
    for (let tries = 0; tries < 2; tries++) {
      const res = await built.app.inject({ method: "POST", url: `/api/v1/studies/${studyId}/versions/${version}/review/${encodeURIComponent(i.id)}`, payload: { ...body, by } });
      if (res.statusCode !== 200) throw new Error(`${i.id}: ${res.body}`);
      if (res.json<RulebookVersionDto>().review.find((x) => x.id === i.id)!.outcome !== "differs") break;
    }
  }
  await settleAll(built, studyId, version, by, n - open.length);
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
