import type { JobDto } from "@dct/shared";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { buildApp } from "../src/app.js";

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

/** A real (tiny) PDF. `seed` makes the bytes, and so the sha256, distinct. */
export async function makePdf(seed: string, pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(seed);
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
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
  return app.inject({ method: "POST", url: "/api/uploads", payload, headers });
}

export async function waitJob(app: App, id: string, timeoutMs = 20_000): Promise<JobDto> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const job = (await app.inject({ url: `/api/jobs/${id}` })).json<JobDto>();
    if (job.state === "succeeded" || job.state === "failed") return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} did not finish`);
}
