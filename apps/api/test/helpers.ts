import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import type { Ocr } from "../src/jobs/ocr.js";

export type Built = Awaited<ReturnType<typeof buildApp>>;
export type App = Built["app"];

/** Routes only tests need, under /api/v1, beside the real ones. */
const testRoutes: NonNullable<Parameters<typeof buildApp>[0]>["routes"] = (api, { db }) => {
  api.get("/ping", async () => ({ ok: true }));
  api.post("/ping", async () => ({ ok: true }));
  api.get("/things/:id", async () => ({ ok: true }));
  api.get("/things/:id/versions/:v", async () => ({ ok: true }));
  // a query that fails with its values in the message, and one a malformed value fails
  api.get("/db-error", async () => db.execute(sql`SELECT ${"hunter2"} FROM no_such_table`));
  api.get("/db-bad-input", async () => db.execute(sql`SELECT ${"not-a-uuid"}::uuid`));
  api.post("/upload", async (req) => {
    for await (const part of req.files()) await part.toBuffer();
    return { ok: true };
  });
};

/** OCR that always fails, so a test that doesn't care about OCR never runs the real one. */
export const noOcr: Ocr = async () => {
  throw new Error("OCR is off in this test");
};

export async function testApp(): Promise<Built> {
  // the database's own name, as global-setup checks it: "_test" anywhere else in the URL must not pass
  if (!new URL(process.env.DATABASE_URL ?? "postgres://x/").pathname.slice(1).endsWith("_test")) throw new Error("tests must use the _test database");
  return buildApp({ routes: testRoutes, ocr: noOcr });
}

/** Serialise multipart/form-data with the platform FormData encoder. */
export async function multipart(files: { name: string; data: Buffer }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files[]", new Blob([new Uint8Array(f.data)]), f.name);
  const req = new Request("http://local/", { method: "POST", body: fd });
  return { payload: Buffer.from(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } };
}
