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

/** "text" when any page carries real text (its numbers can be checked against it), else "scan"; null when mupdf can't read it (extraction will say why). */
async function textSource(file: string): Promise<"text" | "scan" | null> {
  try {
    return (await (await getExtraction()).readTextLayer(file, "")).some((p) => p.source === "text") ? "text" : "scan";
  } catch {
    return null;
  }
}

const DPI_STEPS = [72, 150, 220, 300, 400];

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
        const filename = (part.filename || "upload.pdf").slice(0, 255);
        const pages = await pageCount(buf, filename);
        if (pages > config.maxUploadPages) throw new HttpError(422, `${filename} has ${pages} pages; the limit is ${config.maxUploadPages} per document. Split it into smaller PDFs and upload those.`);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const storagePath = path.join(config.uploadDir, `${sha256}.pdf`);
        const [existing] = await db.select().from(documents).where(eq(documents.sha256, sha256));
        if (existing) {
          out.push(documentDto(existing, existing.id));
          continue;
        }
        if (!existsSync(storagePath)) await writeAtomic(storagePath, buf);
        const text = await textSource(storagePath);
        const row = await db.transaction(async (tx) => {
          const [r] = await tx.insert(documents).values({ sha256, filename, pageCount: pages, storagePath, textSource: text }).onConflictDoNothing().returning();
          if (r) await audit(tx, by, null, "document.uploaded", { documentId: r.id, filename, sha256, pageCount: pages, text: r.textSource });
          return r;
        });
        if (row) out.push(documentDto(row));
        else {
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
    // Rounded up to a few sizes, so a page has at most that many renders on disk.
    app.get<{ Params: { id: string; n: string }; Querystring: { dpi?: string } }>("/documents/:id/pages/:n(^\\d+).png", async (req, reply) => {
      const [doc] = await db.select().from(documents).where(eq(documents.id, req.params.id));
      if (!doc) throw notFound("Document");
      const n = Number(req.params.n);
      if (n < 1 || n > doc.pageCount) throw notFound(`Page ${n}`);
      const asked = Number(req.query.dpi) || 150;
      const dpi = DPI_STEPS.find((d) => d >= asked) ?? DPI_STEPS.at(-1)!;
      const file = path.join(config.uploadDir, "pages", `${doc.sha256}-${n}${dpi === 150 ? "" : `@${dpi}`}.png`);
      // Contract pages (payee bank details too) don't stay in the browser's disk cache for long.
      const image = () => reply.type("image/png").header("cache-control", "private, max-age=3600");
      if (existsSync(file)) return image().send(createReadStream(file));
      let png: Buffer;
      try {
        png = await (await getExtraction()).renderPage(doc.storagePath, n, dpi);
      } catch (e) {
        // the PDF has fewer pages than counted at upload
        if ((e as Error).name === "RangeError") throw notFound(`Page ${n}`);
        if ((e as Error).name === "RenderTimeoutError") throw new HttpError(422, (e as Error).message);
        throw e;
      }
      await writeAtomic(file, png);
      return image().send(png);
    });
  };
