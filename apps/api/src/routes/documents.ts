import { type DocumentDto, SetDocumentKindBody } from "@dct/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Ctx } from "../app.js";
import { config } from "../config.js";
import { documents, studyDocuments } from "../db/schema.js";
import { audit, documentDto } from "../domain.js";
import { getExtraction } from "../extraction/port.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import { fingerprintOf, write } from "../lib/idempotency.js";

/** Write via temp file + rename so a crash never leaves a half-written file under its final name. */
async function writeAtomic(file: string, data: Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** On disk for good before anything refers to it: written, then flushed (a power cut can't leave it empty). */
async function writeDurable(file: string, data: Buffer) {
  const f = await open(file, "wx");
  try {
    await f.writeFile(data);
    await f.sync();
  } finally {
    await f.close();
  }
}

/** Flushes a folder, so a file renamed into it stays there after a power cut. */
async function syncDir(dir: string) {
  const d = await open(dir, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

/**
 * Pages as the read counts them: by mupdf, in its worker, from the staged file (a crafted PDF then costs a 30-second
 * timeout there, never the event loop). One it can't open, or not in time, is refused in words.
 */
async function pageCount(file: string, filename: string): Promise<number> {
  try {
    return await (await getExtraction()).pageCount(file);
  } catch (e) {
    if ((e as Error).name === "RenderTimeoutError")
      throw new HttpError(422, `${filename} took too long to open, so it wasn't uploaded. It may be damaged or unusually complex: save it again as a PDF, or upload a fresh copy.`);
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
/** Each upload's files, one advisory-lock key space (two-int form) per sha256. */
const FILE_LOCKS = 7102;

type Staged = { filename: string; sha256: string; pages: number; tmp: string | null; text: "text" | "scan" | null };

export const documentRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    /**
     * Stores each PDF as `<sha256>.pdf`, all of the request's files or none. A file is staged under a temporary name and
     * moved into place last, inside the transaction that inserts its row (under a lock on its sha256): if anything fails
     * before the commit, no new file is left under its final name. A crash between the move and the commit can leave one
     * with no row; it holds exactly those bytes, so the next upload of them reuses it.
     */
    app.post("/uploads", async (req, reply) => {
      if (!req.isMultipart()) throw new HttpError(415, "Expected multipart/form-data with files[]");
      let by = "system";
      const files: Staged[] = [];
      try {
        await mkdir(config.uploadDir, { recursive: true });
        for await (const part of req.parts()) {
          if (part.type === "field") {
            if (part.fieldname === "by" && typeof part.value === "string" && part.value.trim()) by = part.value.trim();
            continue;
          }
          const buf = await part.toBuffer(); // throws 413 past the 50 MB limit
          const filename = (part.filename || "upload.pdf").slice(0, 255);
          if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(415, `${filename} is not a PDF`);
          const sha256 = createHash("sha256").update(buf).digest("hex");
          const [known] = await db.select({ pages: documents.pageCount }).from(documents).where(eq(documents.sha256, sha256));
          const f: Staged = { filename, sha256, pages: known?.pages ?? 0, tmp: known ? null : path.join(config.uploadDir, `${sha256}.pdf.${randomUUID()}.tmp`), text: null };
          files.push(f); // listed before it's written, so the finally below removes its temporary file whatever fails
          if (f.tmp) {
            await writeDurable(f.tmp, buf);
            f.pages = await pageCount(f.tmp, filename);
          }
          if (f.pages > config.maxUploadPages) throw new HttpError(422, `${filename} has ${f.pages} pages; the limit is ${config.maxUploadPages} per document. Split it into smaller PDFs and upload those.`);
        }
        if (!files.length) throw new HttpError(400, "No files in upload (field files[])");
        for (const f of files) if (f.tmp) f.text = await textSource(f.tmp);

        const placed: string[] = [];
        const moves: { from: string; to: string }[] = [];
        const print = fingerprintOf(req, { by, files: files.map((f) => [f.filename, f.sha256]) });
        return await write(
          db,
          req,
          reply,
          async (tx) => {
            const out: DocumentDto[] = [];
            // Every file's lock first, in sha256 order: two uploads sharing files then take them in the same order and
            // queue up, where taking them in upload order ([A, B] against [B, A]) deadlocked.
            for (const sha of [...new Set(files.map((f) => f.sha256))].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(${FILE_LOCKS}, hashtext(${sha}))`);
            for (const f of files) {
              const [existing] = await tx.select().from(documents).where(eq(documents.sha256, f.sha256));
              if (existing) {
                out.push(documentDto(existing, existing.id));
                continue;
              }
              if (!f.tmp) throw new Error("a document known when the upload was read is gone"); // rows are never deleted
              const storagePath = path.join(config.uploadDir, `${f.sha256}.pdf`);
              const [r] = await tx.insert(documents).values({ sha256: f.sha256, filename: f.filename, pageCount: f.pages, storagePath, textSource: f.text }).returning();
              await audit(tx, by, null, "document.uploaded", { documentId: r!.id, filename: f.filename, sha256: f.sha256, pageCount: f.pages, text: r!.textSource });
              out.push(documentDto(r!));
              moves.push({ from: f.tmp, to: storagePath });
            }
            return out;
          },
          {
            status: 201,
            fingerprint: print,
            // last, while this transaction still holds each file's lock: a failure here takes back what it placed
            after: async () => {
              try {
                for (const m of moves) {
                  const had = existsSync(m.to);
                  await rename(m.from, m.to);
                  if (!had) placed.push(m.to);
                }
                if (moves.length) await syncDir(config.uploadDir);
              } catch (err) {
                await Promise.all(placed.map((p) => rm(p, { force: true })));
                throw err;
              }
            },
          },
        );
      } finally {
        // whatever wasn't moved into place
        await Promise.all(files.flatMap((f) => (f.tmp ? [rm(f.tmp, { force: true })] : [])));
      }
    });

    app.patch<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
      const body = parse(SetDocumentKindBody, req.body);
      return write(db, req, reply, async (tx) => {
        const [doc] = await tx.select().from(documents).where(eq(documents.id, req.params.id)).for("no key update");
        if (!doc) throw notFound("Document");
        // the same kind again changes nothing, so it logs nothing
        if (doc.kind === body.kind) return documentDto(doc);
        const [row] = await tx.update(documents).set({ kind: body.kind }).where(eq(documents.id, doc.id)).returning();
        // A file can be shared (one master agreement for several studies): every study that uses it logs the change, so
        // each contract's Activity shows it. Approved versions keep the kind they were read with (their rulebook's documents).
        const links = await tx.select({ studyId: studyDocuments.studyId }).from(studyDocuments).where(eq(studyDocuments.documentId, doc.id)).orderBy(studyDocuments.studyId);
        for (const studyId of links.length ? links.map((l) => l.studyId) : [null]) await audit(tx, body.by, studyId, "document.kind_set", { documentId: doc.id, from: doc.kind, to: body.kind });
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
