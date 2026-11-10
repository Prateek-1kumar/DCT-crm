import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { pdfReader, quotePlace } from "@dct/harness";
import type { Region } from "@dct/shared";
import { rm } from "node:fs/promises";
import { z } from "zod";
import type { Ctx } from "../app.js";
import type { Tx } from "../db/index.js";
import { answers, documents, type PageInfo, parties, reads, studies, studyDocuments, versions } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { By } from "../lib/by.js";
import { loadStored, pageInfos } from "../lib/docs.js";
import { HttpError } from "../lib/http.js";
import { norm } from "../lib/parties.js";
import { parse } from "../lib/parse.js";
import { pdfPath, savePdf, sha256 } from "../lib/storage.js";

const MAX_PAGES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["sponsor", "cro", "site"] as const;
const KIND_WORD = { sponsor: "sponsor", cro: "CRO", site: "site" } as const;

const label = z.string({ error: "Give a name." }).trim().min(1, { error: "Give a name." }).max(200, { error: "That name is too long." }).refine((s) => norm(s) !== "", { error: "A name needs at least one letter or digit." });

const NewParty = z.object({
  kind: z.enum(KINDS, { error: "Say whether this is a sponsor, a CRO or a site." }),
  name: label,
  aliases: z.array(label).max(50, { error: "That's too many aliases." }).default([]),
  by: By,
});
const NewAlias = z.object({ alias: label, by: By });
const Rename = z.object({ name: label, by: By });
const Merge = z.object({ into: z.string({ error: "Pick the party to merge into." }).regex(UUID, { error: "Pick the party to merge into." }), by: By });
const slot = (word: string) => z.string({ error: `Pick a ${word} from the list, or leave it empty.` }).regex(UUID, { error: `Pick a ${word} from the list, or leave it empty.` }).nullable().optional();
const StudyParties = z.object({ sponsorId: slot("sponsor"), payerId: slot("CRO"), siteId: slot("site"), by: By });
/** Which kind of party each slot of a study takes, and what to call the slot to a person. */
const SLOTS = [
  { key: "sponsorId", name: "sponsor", word: "sponsor", kind: "sponsor" },
  { key: "payerId", name: "payer", word: "CRO", kind: "cro" },
  { key: "siteId", name: "site", word: "site", kind: "site" },
] as const;
const NewStudy = z.object({ by: By });
const PartySearch = z.object({ kind: z.enum(KINDS, { error: "Kind must be sponsor, cro or site." }).optional(), q: z.string().optional() });
const ByQuery = z.object({ by: By });
const FindQuery = z.object({ q: z.string({ error: "Say which words to find." }).min(1, { error: "Say which words to find." }).max(1000, { error: "Those words are too long to find." }) });
const DPI_ERROR = "dpi must be a whole number from 1 to 300.";
const REGION_ERROR = "region must be four numbers from 0 to 1, separated by commas: left, top, right, bottom.";
const ImageQuery = z.object({
  dpi: z.coerce.number({ error: DPI_ERROR }).int({ error: DPI_ERROR }).min(1, { error: DPI_ERROR }).max(300, { error: DPI_ERROR }).default(110),
  region: z.string({ error: REGION_ERROR }).optional(),
});
// A crop is never refused for being sharp: the picture is made smaller to fit these, and the client reads its real size.
const MAX_SIDE = 4096;
const MAX_PIXELS = 16e6;
const MIN_REGION = 0.01;

function parseRegion(raw: string): Region {
  const parts = raw.split(",");
  const r = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (r.length !== 4 || !r.every(Number.isFinite)) throw new HttpError(400, REGION_ERROR);
  const [x0, y0, x1, y1] = r as Region;
  if (![x0, y0, x1, y1].every((v) => v >= 0 && v <= 1)) throw new HttpError(400, "region must stay inside the page: every number from 0 to 1.");
  if (x1 <= x0 || y1 <= y0) throw new HttpError(400, "region must run from the top left to the bottom right: left must be below right, and top below bottom.");
  // a hair of slack, so 0.01 sent as a rounded 4-digit fraction isn't refused
  if (x1 - x0 < MIN_REGION - 1e-9 || y1 - y0 < MIN_REGION - 1e-9) throw new HttpError(400, "region must be at least 1% of the page wide and tall.");
  return [x0, y0, x1, y1];
}

const uniqueNormalised = (names: string[]) => [...new Map(names.map((n) => [norm(n), n])).values()];

const pagesOf = (pages: PageInfo[], kind: PageInfo["kind"]) => pages.filter((p) => p.kind === kind).map((p) => p.page);

export async function studiesRoutes(api: FastifyInstance, { db }: Ctx) {
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
    const [rows, used] = await Promise.all([
      db.select().from(parties).where(kind ? eq(parties.kind, kind) : undefined).orderBy(parties.name),
      db.select({ sponsorId: studies.sponsorId, payerId: studies.payerId, siteId: studies.siteId }).from(studies),
    ]);
    // each study counts once per party, even when it uses the party in more than one role
    const count = (id: string) => used.filter((s) => s.sponsorId === id || s.payerId === id || s.siteId === id).length;
    const needle = norm(q ?? "");
    return (needle ? rows.filter((p) => [p.name, ...p.aliases].some((n) => norm(n).includes(needle))) : rows).map((p) => ({ ...p, studies: count(p.id) }));
  });

  api.post<{ Params: { id: string } }>("/parties/:id/aliases", async (req) => {
    const { by, alias: name } = parse(NewAlias, req.body);
    return db.transaction(async (tx) => {
      const [party] = await tx.select().from(parties).where(eq(parties.id, req.params.id)).for("update");
      if (!party) throw new HttpError(404, "That party doesn't exist.");
      if ([party.name, ...party.aliases].some((n) => norm(n) === norm(name))) throw new HttpError(409, `${party.name} is already known as "${name}".`);
      const [updated] = await tx.update(parties).set({ aliases: [...party.aliases, name] }).where(eq(parties.id, party.id)).returning();
      await audit(tx, { by, action: "party.alias", entity: "party", entityId: party.id, detail: { alias: name, name: party.name } });
      return updated;
    });
  });

  api.patch<{ Params: { id: string } }>("/parties/:id", async (req) => {
    const { by, name } = parse(Rename, req.body);
    const [found] = await db.select({ kind: parties.kind }).from(parties).where(eq(parties.id, req.params.id));
    if (!found) throw new HttpError(404, "That party doesn't exist.");
    return db.transaction(async (tx) => {
      // every party of the kind, in a stable order: two renames to the same name can't both pass the check below
      const same = await tx.select().from(parties).where(eq(parties.kind, found.kind)).orderBy(parties.id).for("update");
      const party = same.find((p) => p.id === req.params.id);
      if (!party) throw new HttpError(404, "That party doesn't exist.");
      const clash = same.find((p) => p.id !== party.id && [p.name, ...p.aliases].some((n) => norm(n) === norm(name)));
      if (clash) throw new HttpError(409, `"${clash.name}" is already ${norm(clash.name) === norm(name) ? "the name of" : "another name for"} a different ${KIND_WORD[party.kind]} in your list. Merge the two instead of renaming.`);
      // the old wording stays as an alias so a later read of a contract that uses it still finds this party
      const aliases = party.aliases.filter((a) => norm(a) !== norm(name));
      if (norm(party.name) !== norm(name)) aliases.push(party.name);
      const [updated] = await tx.update(parties).set({ name, aliases }).where(eq(parties.id, party.id)).returning();
      await audit(tx, { by, action: "party.rename", entity: "party", entityId: party.id, detail: { from: party.name, to: name } });
      return updated;
    });
  });

  api.post<{ Params: { id: string } }>("/parties/:id/merge", async (req) => {
    const { by, into } = parse(Merge, req.body);
    const { id } = req.params;
    if (into.toLowerCase() === id.toLowerCase()) throw new HttpError(400, "A party can't be merged into itself. Pick a different one.");
    return db.transaction(async (tx) => {
      // both rows locked in id order, so two merges the opposite way round can't deadlock
      const locked = await tx.select().from(parties).where(inArray(parties.id, [id, into])).orderBy(parties.id).for("update");
      const from = locked.find((p) => p.id === id);
      const target = locked.find((p) => p.id === into);
      if (!from) throw new HttpError(404, "That party doesn't exist.");
      if (!target) throw new HttpError(404, "The party to merge into doesn't exist.");
      if (from.kind !== target.kind) throw new HttpError(400, `"${from.name}" is a ${KIND_WORD[from.kind]} and "${target.name}" is a ${KIND_WORD[target.kind]}. Only two of the same kind can be merged.`);

      const moved = new Set<string>();
      for (const { key } of SLOTS) {
        const rows = await tx.update(studies).set({ [key]: target.id }).where(eq(studies[key], from.id)).returning({ id: studies.id });
        for (const r of rows) moved.add(r.id);
      }
      // the old names stay as aliases so a later read of a contract that uses them still finds the survivor
      const own = norm(target.name);
      const seen = new Set([own]);
      const aliases = [...target.aliases, from.name, ...from.aliases].filter((a) => !seen.has(norm(a)) && seen.add(norm(a)));
      const [survivor] = await tx.update(parties).set({ aliases }).where(eq(parties.id, target.id)).returning();
      await tx.delete(parties).where(eq(parties.id, from.id));
      await audit(tx, { by, action: "party.merge", entity: "party", entityId: target.id, detail: { from: from.name, into: target.name, studies: moved.size } });
      return survivor;
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
    // light columns only: the rulebooks are read just for what the list shows, by SQL, never loaded whole
    const all = await db.select({ id: versions.id, studyId: versions.studyId, number: versions.number, status: versions.status, createdAt: versions.createdAt, approvedAt: versions.approvedAt }).from(versions);
    const latest = new Map<string, (typeof all)[number]>();
    const live = new Map<string, number>();
    const stamps = new Map<string, Date[]>();
    const unfinished = all.filter((v) => v.status === "reading" || v.status === "draft");
    for (const v of all) {
      if (v.number > (latest.get(v.studyId)?.number ?? 0)) latest.set(v.studyId, v);
      if (v.status === "approved") live.set(v.studyId, v.number);
      stamps.set(v.studyId, [...(stamps.get(v.studyId) ?? []), v.createdAt, ...(v.approvedAt ? [v.approvedAt] : [])]);
    }
    const drafts = [...latest.values()].filter((v) => v.status === "draft").map((v) => v.id);
    const [decisions, answered, pis, finished] = await Promise.all([
      drafts.length
        ? db
            .select({
              id: versions.id,
              blocking: sql<number>`(SELECT count(*)::int FROM jsonb_array_elements(${versions.rulebook}->'questions') q WHERE q->>'state' = 'open' AND q->>'blocking' = 'true')`,
              failing: sql<number>`jsonb_array_length(${versions.problems})`,
            })
            .from(versions)
            .where(inArray(versions.id, drafts))
        : [],
      drafts.length ? db.selectDistinct({ versionId: answers.versionId, by: answers.by }).from(answers).where(inArray(answers.versionId, drafts)).orderBy(answers.by) : [],
      db
        .selectDistinctOn([versions.studyId], { studyId: versions.studyId, pi: sql<string | null>`${versions.rulebook}->'study'->>'pi'` })
        .from(versions)
        .where(isNotNull(versions.rulebook))
        .orderBy(versions.studyId, desc(versions.number)),
      db.select({ studyId: versions.studyId, at: max(reads.finishedAt) }).from(reads).innerJoin(versions, eq(versions.id, reads.versionId)).groupBy(versions.studyId),
    ]);
    const open = new Map(decisions.map((d) => [d.id, d.blocking || (d.failing ? 1 : 0)]));
    const piOf = new Map(pis.map((p) => [p.studyId, p.pi]));
    for (const f of finished) if (f.at) stamps.set(f.studyId, [...(stamps.get(f.studyId) ?? []), f.at]);
    const firsts = await db
      .selectDistinctOn([studyDocuments.studyId], { studyId: studyDocuments.studyId, name: documents.name })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .orderBy(studyDocuments.studyId, studyDocuments.addedAt, documents.name);
    const firstDocument = new Map(firsts.map((d) => [d.studyId, d.name]));
    return rows.map(({ study, ...names }) => {
      const last = latest.get(study.id);
      const liveNumber = live.get(study.id) ?? null;
      return {
        ...study,
        ...names,
        firstDocument: firstDocument.get(study.id) ?? null,
        latestVersion: last ? { id: last.id, number: last.number, status: last.status } : null,
        pi: piOf.get(study.id) ?? null,
        updatedAt: new Date(Math.max(study.createdAt.getTime(), ...(stamps.get(study.id) ?? []).map((d) => d.getTime()))).toISOString(),
        liveVersion: liveNumber,
        // the latest version only: older drafts have been replaced, and reading, failed or live ones have nothing to decide
        openDecisions: last ? (open.get(last.id) ?? 0) : 0,
        newVersionInProgress: liveNumber !== null && unfinished.some((v) => v.studyId === study.id && v.number > liveNumber),
        answeredBy: last?.status === "draft" ? answered.filter((a) => a.versionId === last.id).map((a) => a.by) : [],
      };
    });
  });

  /** The study as GET /studies/:id shows it; the parties route returns it too. */
  const studyDetail = async (q: Tx, study: typeof studies.$inferSelect) => {
    const ids = [study.sponsorId, study.payerId, study.siteId].filter((id) => id !== null);
    const partyRows = ids.length ? await q.select().from(parties).where(inArray(parties.id, ids)) : [];
    const party = (id: string | null) => partyRows.find((p) => p.id === id) ?? null;
    const docs = await q
      .select({ doc: documents })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .where(eq(studyDocuments.studyId, study.id))
      .orderBy(studyDocuments.addedAt);
    const versionRows = await q
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
        scannedPages: pagesOf(doc.pages, "image"),
        scansRead: pagesOf(doc.pages, "scan"),
      })),
      versions: versionRows,
    };
  };

  api.get<{ Params: { id: string } }>("/studies/:id", async (req) => studyDetail(db, await requireStudy(req.params.id)));

  api.patch<{ Params: { id: string } }>("/studies/:id/parties", async (req) => {
    const body = parse(StudyParties, req.body);
    return db.transaction(async (tx) => {
      const [study] = await tx.select().from(studies).where(eq(studies.id, req.params.id)).for("update");
      if (!study) throw new HttpError(404, "That study doesn't exist. Go back to the study list and pick it again.");
      const wanted = SLOTS.flatMap((s) => (body[s.key] === undefined ? [] : [{ ...s, id: body[s.key]! }])).filter((s) => s.id !== study[s.key]);
      const ids = wanted.flatMap((s) => (s.id ? [s.id] : []));
      const found = ids.length ? await tx.select().from(parties).where(inArray(parties.id, ids)) : [];
      for (const s of wanted) {
        const p = s.id ? found.find((f) => f.id === s.id) : null;
        if (s.id && !p) throw new HttpError(400, `That ${s.word} doesn't exist. Pick one from the list.`);
        if (p && p.kind !== s.kind) throw new HttpError(400, `"${p.name}" is a ${KIND_WORD[p.kind]}, so it can't be this contract's ${s.word}. Pick a ${s.word} from the list.`);
      }
      if (!wanted.length) return studyDetail(tx, study);
      const [updated] = await tx.update(studies).set(Object.fromEntries(wanted.map((s) => [s.key, s.id]))).where(eq(studies.id, study.id)).returning();
      const set = Object.fromEntries(wanted.map((s) => [s.name, found.find((f) => f.id === s.id)?.name ?? null]));
      await audit(tx, { by: body.by, action: "study.parties", entity: "study", entityId: study.id, detail: { studyId: study.id, set } });
      return studyDetail(tx, updated!);
    });
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

    const results = await db.transaction(async (tx) => {
      const inStudy = await tx.select({ id: documents.id, name: documents.name }).from(studyDocuments).innerJoin(documents, eq(documents.id, studyDocuments.documentId)).where(eq(studyDocuments.studyId, study.id));
      const results = [];
      for (const file of prepared) {
        const [created] = await tx.insert(documents).values({ sha256: file.hash, name: file.name, bytes: file.bytes, pages: file.pages, createdBy: actor }).onConflictDoNothing().returning();
        const [doc] = created ? [created] : await tx.select().from(documents).where(eq(documents.sha256, file.hash));
        if (created) await audit(tx, { by: actor, action: "document.upload", entity: "document", entityId: doc!.id, detail: { name: doc!.name, bytes: doc!.bytes } });
        const result = { id: doc!.id, name: doc!.name, pages: doc!.pages.length, scannedPages: pagesOf(doc!.pages, "image"), alreadyInStudy: inStudy.some((d) => d.id === doc!.id) };
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
    return results;
  });

  api.delete<{ Params: { id: string; documentId: string } }>("/studies/:id/documents/:documentId", async (req) => {
    const { by } = parse(ByQuery, req.query);
    if (!UUID.test(req.params.documentId)) throw new HttpError(400, "Malformed id");
    const study = await requireStudy(req.params.id);
    return db.transaction(async (tx) => {
      const [gone] = await tx.delete(studyDocuments).where(and(eq(studyDocuments.studyId, study.id), eq(studyDocuments.documentId, req.params.documentId))).returning();
      if (!gone) throw new HttpError(404, "That document isn't in this study.");
      const [doc] = await tx.select({ name: documents.name }).from(documents).where(eq(documents.id, gone.documentId));
      await audit(tx, { by, action: "study.document.remove", entity: "study", entityId: study.id, detail: { documentId: gone.documentId, name: doc?.name } });
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
    const { dpi, region: raw } = parse(ImageQuery, req.query);
    const region = raw === undefined ? undefined : parseRegion(raw);
    const { doc, page } = await pageOf(req.params.id, req.params.page);
    // render draws only the region (its canvas is the crop's size), paints the page's bank-detail boxes over it, and caps the area
    let png = await pdfReader.render(doc, page, { dpi, region, maxPixels: MAX_PIXELS });
    // the page's size in points is only known inside render, so the long side is read off the PNG header (IHDR); only a page far larger than a letter sheet needs the second render
    const side = Math.max(png.readUInt32BE(16), png.readUInt32BE(20));
    if (side > MAX_SIDE) png = await pdfReader.render(doc, page, { dpi: (dpi * MAX_SIDE) / side, region, maxPixels: MAX_PIXELS });
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
    // `approx` on a scanned page whose words weren't all found: the boxes then hold the quote rather than sit on it
    const { boxes, approx } = quotePlace(doc.pages[page - 1]!, q);
    return { boxes, ...(approx && { approx }) };
  });
}
