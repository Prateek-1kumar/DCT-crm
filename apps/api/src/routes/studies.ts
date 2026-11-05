import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { findQuote, pdfReader } from "@dct/harness";
import { rm } from "node:fs/promises";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { documents, type PageInfo, parties, studies, studyDocuments, versions } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { By } from "../lib/by.js";
import { queueOcr } from "../jobs/ocr.js";
import { loadStored, pageInfos } from "../lib/docs.js";
import { HttpError } from "../lib/http.js";
import { norm } from "../lib/parties.js";
import { parse } from "../lib/parse.js";
import { pdfPath, savePdf, sha256 } from "../lib/storage.js";

const MAX_PAGES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["sponsor", "cro", "site"] as const;

const label = z.string({ error: "Give a name." }).trim().min(1, { error: "Give a name." }).max(200, { error: "That name is too long." }).refine((s) => norm(s) !== "", { error: "A name needs at least one letter or digit." });

const NewParty = z.object({
  kind: z.enum(KINDS, { error: "Say whether this is a sponsor, a CRO or a site." }),
  name: label,
  aliases: z.array(label).max(50, { error: "That's too many aliases." }).default([]),
  by: By,
});
const NewAlias = z.object({ alias: label, by: By });
const NewStudy = z.object({ by: By });
const PartySearch = z.object({ kind: z.enum(KINDS, { error: "Kind must be sponsor, cro or site." }).optional(), q: z.string().optional() });
const ByQuery = z.object({ by: By });
const FindQuery = z.object({ q: z.string({ error: "Say which words to find." }).min(1, { error: "Say which words to find." }).max(1000, { error: "Those words are too long to find." }) });
const ImageQuery = z.object({ dpi: z.coerce.number({ error: "dpi must be a whole number from 1 to 200." }).int({ error: "dpi must be a whole number from 1 to 200." }).min(1, { error: "dpi must be a whole number from 1 to 200." }).max(200, { error: "dpi must be a whole number from 1 to 200." }).default(110) });

const uniqueNormalised = (names: string[]) => [...new Map(names.map((n) => [norm(n), n])).values()];

const LOW_CONFIDENCE = 80;

const scannedOf = (pages: PageInfo[]) => pages.filter((p) => p.kind !== "text").map((p) => p.page);
const lowConfidenceOf = (pages: PageInfo[]) => pages.filter((p) => p.kind === "ocr" && (p.confidence ?? 100) < LOW_CONFIDENCE).map((p) => p.page);
const awaitsOcr = (d: { pages: PageInfo[]; ocrStatus: string }) => d.pages.some((p) => p.kind === "image") && d.ocrStatus !== "queued" && d.ocrStatus !== "running";

export async function studiesRoutes(api: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const requireStudy = async (studyId: string) => {
    const [study] = await db.select().from(studies).where(eq(studies.id, studyId));
    if (!study) throw new HttpError(404, "That study doesn't exist. Go back to the study list and pick it again.");
    return study;
  };

  const requireDocument = async (documentId: string) => {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) throw new HttpError(404, "That document doesn't exist.");
    return doc;
  };

  api.post("/parties", async (req, reply) => {
    const { by, kind, name, aliases } = parse(NewParty, req.body);
    const own = norm(name);
    const [party] = await db.transaction(async (tx) => {
      const rows = await tx.insert(parties).values({ kind, name, aliases: uniqueNormalised(aliases).filter((a) => norm(a) !== own), createdBy: by }).returning();
      await audit(tx, { by, action: "party.create", entity: "party", entityId: rows[0]!.id, detail: { kind, name } });
      return rows;
    });
    return reply.status(201).send(party);
  });

  api.get("/parties", async (req) => {
    const { kind, q } = parse(PartySearch, req.query);
    const rows = await db.select().from(parties).where(kind ? eq(parties.kind, kind) : undefined).orderBy(parties.name);
    const needle = norm(q ?? "");
    return needle ? rows.filter((p) => [p.name, ...p.aliases].some((n) => norm(n).includes(needle))) : rows;
  });

  api.post<{ Params: { id: string } }>("/parties/:id/aliases", async (req) => {
    const { by, alias: name } = parse(NewAlias, req.body);
    return db.transaction(async (tx) => {
      const [party] = await tx.select().from(parties).where(eq(parties.id, req.params.id)).for("update");
      if (!party) throw new HttpError(404, "That party doesn't exist.");
      if ([party.name, ...party.aliases].some((n) => norm(n) === norm(name))) throw new HttpError(409, `${party.name} is already known as "${name}".`);
      const [updated] = await tx.update(parties).set({ aliases: [...party.aliases, name] }).where(eq(parties.id, party.id)).returning();
      await audit(tx, { by, action: "party.alias", entity: "party", entityId: party.id, detail: { alias: name } });
      return updated;
    });
  });

  api.post("/studies", async (req, reply) => {
    const { by } = parse(NewStudy, req.body);
    const [study] = await db.transaction(async (tx) => {
      const rows = await tx.insert(studies).values({ createdBy: by }).returning({ id: studies.id });
      await audit(tx, { by, action: "study.create", entity: "study", entityId: rows[0]!.id });
      return rows;
    });
    return reply.status(201).send(study);
  });

  api.get("/studies", async () => {
    const sponsor = alias(parties, "sponsor");
    const payer = alias(parties, "payer");
    const site = alias(parties, "site");
    const rows = await db
      .select({ study: studies, sponsor: sponsor.name, payer: payer.name, site: site.name })
      .from(studies)
      .leftJoin(sponsor, eq(sponsor.id, studies.sponsorId))
      .leftJoin(payer, eq(payer.id, studies.payerId))
      .leftJoin(site, eq(site.id, studies.siteId))
      .orderBy(desc(studies.createdAt));
    const latest = await db
      .selectDistinctOn([versions.studyId], { studyId: versions.studyId, number: versions.number, status: versions.status })
      .from(versions)
      .orderBy(versions.studyId, desc(versions.number));
    const byStudy = new Map(latest.map((v) => [v.studyId, { number: v.number, status: v.status }]));
    const firsts = await db
      .selectDistinctOn([studyDocuments.studyId], { studyId: studyDocuments.studyId, name: documents.name })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .orderBy(studyDocuments.studyId, studyDocuments.addedAt, documents.name);
    const firstDocument = new Map(firsts.map((d) => [d.studyId, d.name]));
    return rows.map(({ study, ...names }) => ({ ...study, ...names, firstDocument: firstDocument.get(study.id) ?? null, latestVersion: byStudy.get(study.id) ?? null }));
  });

  api.get<{ Params: { id: string } }>("/studies/:id", async (req) => {
    const study = await requireStudy(req.params.id);
    const partyRows = await db.select().from(parties).where(inArray(parties.id, [study.sponsorId, study.payerId, study.siteId].filter((id) => id !== null)));
    const party = (id: string | null) => partyRows.find((p) => p.id === id) ?? null;
    const docs = await db
      .select({ doc: documents })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .where(eq(studyDocuments.studyId, study.id))
      .orderBy(studyDocuments.addedAt);
    const versionRows = await db
      .select({ id: versions.id, number: versions.number, status: versions.status, createdAt: versions.createdAt, createdBy: versions.createdBy, approvedAt: versions.approvedAt, approvedBy: versions.approvedBy })
      .from(versions)
      .where(eq(versions.studyId, study.id))
      .orderBy(desc(versions.number));
    return {
      ...study,
      sponsor: party(study.sponsorId),
      payer: party(study.payerId),
      site: party(study.siteId),
      documents: docs.map(({ doc }) => ({
        id: doc.id,
        name: doc.name,
        bytes: doc.bytes,
        pageCount: doc.pages.length,
        scannedPages: scannedOf(doc.pages),
        lowConfidencePages: lowConfidenceOf(doc.pages),
        ocr: { status: doc.ocrStatus, pagesDone: doc.ocrPagesDone, pagesTotal: scannedOf(doc.pages).length, error: doc.ocrError },
      })),
      versions: versionRows,
    };
  });

  api.post<{ Params: { id: string } }>("/studies/:id/documents", async (req) => {
    if (!req.isMultipart()) throw new HttpError(400, "Choose the PDF files to upload.");
    const files: { name: string; data: Buffer }[] = [];
    let by: unknown;
    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "by") by = part.value;
        continue;
      }
      const name = (part.filename ?? "").replaceAll("\\", "/").split("/").pop()!.trim();
      if (!name) throw new HttpError(400, "A file in this upload has no name. Rename it and try again.");
      files.push({ name, data: await part.toBuffer() });
    }
    const actor = parse(ByQuery, { by }).by;
    if (!files.length) throw new HttpError(400, "Choose at least one PDF to upload.");
    const study = await requireStudy(req.params.id);

    const prepared: { name: string; hash: string; bytes: number; pages: PageInfo[] }[] = [];
    for (const { name, data } of files) {
      if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, `"${name}" isn't a PDF. Upload PDF files only.`);
      const hash = sha256(data);
      const [known] = await db.select().from(documents).where(eq(documents.sha256, hash));
      if (known) {
        prepared.push({ name, hash, bytes: known.bytes, pages: known.pages });
        continue;
      }
      await savePdf(data);
      const doc = await loadStored(hash).catch(async (err: Error) => {
        await rm(pdfPath(hash), { force: true });
        throw new HttpError(400, `"${name}": ${err.message} Open it, save a fresh copy as PDF, and upload that.`);
      });
      if (doc.pages.length > MAX_PAGES) throw new HttpError(400, `"${name}" has ${doc.pages.length} pages; the limit is ${MAX_PAGES}. Split it into parts and upload each.`);
      prepared.push({ name, hash, bytes: data.length, pages: pageInfos(doc) });
    }

    const toOcr: string[] = [];
    const results = await db.transaction(async (tx) => {
      const inStudy = await tx.select({ id: documents.id, name: documents.name }).from(studyDocuments).innerJoin(documents, eq(documents.id, studyDocuments.documentId)).where(eq(studyDocuments.studyId, study.id));
      const results = [];
      for (const file of prepared) {
        const [created] = await tx.insert(documents).values({ sha256: file.hash, name: file.name, bytes: file.bytes, pages: file.pages, createdBy: actor }).onConflictDoNothing().returning();
        const [doc] = created ? [created] : await tx.select().from(documents).where(eq(documents.sha256, file.hash));
        if (created) await audit(tx, { by: actor, action: "document.upload", entity: "document", entityId: doc!.id, detail: { name: doc!.name, bytes: doc!.bytes } });
        const result = { id: doc!.id, name: doc!.name, pages: doc!.pages.length, scannedPages: scannedOf(doc!.pages), alreadyInStudy: inStudy.some((d) => d.id === doc!.id) };
        if (awaitsOcr(doc!)) toOcr.push(doc!.id);
        if (!result.alreadyInStudy) {
          if (inStudy.some((d) => d.name === doc!.name)) throw new HttpError(409, `This study already has a different file called "${doc!.name}". Rename the new one so the two can be told apart, or remove the old one first.`);
          await tx.insert(studyDocuments).values({ studyId: study.id, documentId: doc!.id, addedBy: actor });
          await audit(tx, { by: actor, action: "study.document.add", entity: "study", entityId: study.id, detail: { documentId: doc!.id, name: doc!.name } });
          inStudy.push({ id: doc!.id, name: doc!.name });
        }
        results.push(result);
      }
      return results;
    });
    for (const id of new Set(toOcr)) await queueOcr(ctx, id);
    return results;
  });

  api.delete<{ Params: { id: string; documentId: string } }>("/studies/:id/documents/:documentId", async (req) => {
    const { by } = parse(ByQuery, req.query);
    if (!UUID.test(req.params.documentId)) throw new HttpError(400, "Malformed id");
    const study = await requireStudy(req.params.id);
    return db.transaction(async (tx) => {
      const [gone] = await tx.delete(studyDocuments).where(and(eq(studyDocuments.studyId, study.id), eq(studyDocuments.documentId, req.params.documentId))).returning();
      if (!gone) throw new HttpError(404, "That document isn't in this study.");
      await audit(tx, { by, action: "study.document.remove", entity: "study", entityId: study.id, detail: { documentId: gone.documentId } });
      return { ok: true };
    });
  });

  const pageOf = async (documentId: string, raw: string) => {
    const doc = await requireDocument(documentId);
    if (!/^[1-9]\d{0,5}$/.test(raw)) throw new HttpError(400, "The page must be a whole number, starting at 1.");
    const page = Number(raw);
    if (page > doc.pages.length) throw new HttpError(404, `This document has ${doc.pages.length} ${doc.pages.length === 1 ? "page" : "pages"}, so there is no page ${page}.`);
    return { doc: await loadStored(doc.sha256), page };
  };

  api.get<{ Params: { id: string; page: string } }>("/documents/:id/pages/:page/image", async (req, reply) => {
    const { dpi } = parse(ImageQuery, req.query);
    const { doc, page } = await pageOf(req.params.id, req.params.page);
    const png = await pdfReader.render(doc, page, { dpi });
    return reply.type("image/png").header("cache-control", "private, max-age=31536000, immutable").send(png);
  });

  api.get<{ Params: { id: string; page: string } }>("/documents/:id/pages/:page/text", async (req) => {
    const { doc, page } = await pageOf(req.params.id, req.params.page);
    const { kind, layout, words } = doc.pages[page - 1]!;
    return { page, kind, layout, words };
  });

  api.get<{ Params: { id: string; page: string } }>("/documents/:id/pages/:page/find", async (req) => {
    const { q } = parse(FindQuery, req.query);
    const { doc, page } = await pageOf(req.params.id, req.params.page);
    return { boxes: findQuote(doc.pages[page - 1]!.words, q) };
  });
}
