import { SetDocumentKindBody } from "@dct/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Ctx } from "../app.js";
import { config } from "../config.js";
import { documents, studyDocuments } from "../db/schema.js";
import { audit, documentDto } from "../domain.js";
import { getExtraction } from "../extraction/port.js";
import { HttpError, notFound, parse } from "../lib/http.js";

/** Write via temp file + rename so a crash never leaves a half-written file under its final name. */
async function writeAtomic(file: string, data: Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function pageCount(buf: Buffer, filename: string): Promise<number> {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(415, `${filename} is not a PDF`);
  try {
    return (await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    throw new HttpError(400, `${filename} could not be read as a PDF`);
  }
}

export const documentRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.post("/uploads", async (req, reply) => {
      if (!req.isMultipart()) throw new HttpError(415, "Expected multipart/form-data with files[]");
      let by = "system";
      const out = [];
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "by" && typeof part.value === "string" && part.value) by = part.value;
          continue;
        }
        const buf = await part.toBuffer(); // throws 413 past the 50 MB limit
        const filename = part.filename || "upload.pdf";
        const pages = await pageCount(buf, filename);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const storagePath = path.join(config.uploadDir, `${sha256}.pdf`);
        const [existing] = await db.select().from(documents).where(eq(documents.sha256, sha256));
        if (existing) {
          out.push(documentDto(existing, existing.id));
          continue;
        }
        if (!existsSync(storagePath)) await writeAtomic(storagePath, buf);
        const [row] = await db.insert(documents).values({ sha256, filename, pageCount: pages, storagePath }).onConflictDoNothing().returning();
        if (row) {
          await audit(db, by, null, "document.uploaded", { documentId: row.id, filename, sha256, pageCount: pages });
          out.push(documentDto(row));
        } else {
          // lost a race with a concurrent upload of the same file
          const [dup] = await db.select().from(documents).where(eq(documents.sha256, sha256));
          out.push(documentDto(dup!, dup!.id));
        }
      }
      if (!out.length) throw new HttpError(400, "No files in upload (field files[])");
      return reply.status(201).send(out);
    });

    app.patch<{ Params: { id: string } }>("/documents/:id", async (req) => {
      const body = parse(SetDocumentKindBody, req.body);
      return db.transaction(async (tx) => {
        const [doc] = await tx.select().from(documents).where(eq(documents.id, req.params.id)).for("update");
        if (!doc) throw notFound("Document");
        const [row] = await tx.update(documents).set({ kind: body.kind }).where(eq(documents.id, doc.id)).returning();
        const [link] = await tx.select().from(studyDocuments).where(eq(studyDocuments.documentId, doc.id)).limit(1);
        await audit(tx, body.by, link?.studyId ?? null, "document.kind_set", { documentId: doc.id, from: doc.kind, to: body.kind });
        return documentDto(row!);
      });
    });

    // ?dpi= (72–400, default 150): the review close-up asks for a sharper page so tiny budget print stays readable.
    app.get<{ Params: { id: string; n: string }; Querystring: { dpi?: string } }>("/documents/:id/pages/:n(^\\d+).png", async (req, reply) => {
      const [doc] = await db.select().from(documents).where(eq(documents.id, req.params.id));
      if (!doc) throw notFound("Document");
      const n = Number(req.params.n);
      if (n < 1 || n > doc.pageCount) throw notFound(`Page ${n}`);
      const dpi = Math.round(Math.min(400, Math.max(72, Number(req.query.dpi) || 150)));
      const file = path.join(config.uploadDir, "pages", `${doc.sha256}-${n}${dpi === 150 ? "" : `@${dpi}`}.png`);
      reply.type("image/png").header("cache-control", "private, max-age=31536000, immutable");
      if (existsSync(file)) return reply.send(createReadStream(file));
      const png = await (await getExtraction()).renderPage(doc.storagePath, n, dpi);
      await writeAtomic(file, png);
      return reply.send(png);
    });
  };
