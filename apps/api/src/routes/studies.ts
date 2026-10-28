import {
  amountOf,
  ConfirmStudyBody,
  CreateStudyBody,
  ENUM_LABELS,
  ExtractBody,
  type JobDto,
  type RateHit,
  type SearchResults,
  type StudyCounts,
  type StudyDetailDto,
  StudyListQuery,
  type StudyPage,
  type StudyView,
} from "@dct/shared";
import { and, count, desc, eq, getTableColumns, ilike, inArray, ne, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import { documents, jobs, listKey, rulebookVersions, studies, studyDocuments } from "../db/schema.js";
import { appliesFromOf, audit, documentDto, manualRulebook, refreshStudyStatus, studySummaryDto, versionSummaryDto } from "../domain.js";
import { getExtraction } from "../extraction/port.js";
import { createJob, sendJob } from "../jobs.js";
import { HttpError, notFound, parse } from "../lib/http.js";

/** POST /studies/:id/versions: manual entry when extraction failed. Not in @dct/shared yet (proposed). */
const CreateVersionBody = z.object({ manual: z.literal(true), by: z.string().min(1) });
const SearchQuery = z.object({ q: z.string().default(""), limit: z.coerce.number().int().min(1).max(50).default(8) });

/** Each list view is one `stage` (see the column). */
const VIEW_STAGE = { "needs-you": 0, failed: 1, approval: 3, live: 5 } as const satisfies Record<StudyView, number>;

const wordsOf = (q = "") => q.trim().split(/\s+/).filter(Boolean);
const like = (w: string) => `%${w.replace(/[\\%_]/g, "\\$&")}%`;
/** Every word of `q` in protocol, sponsor, site or investigator. */
const matchesQ = (q?: string) =>
  and(...wordsOf(q).map((w) => or(...[studies.protocol, studies.sponsor, studies.siteName, studies.investigator].map((c) => ilike(c, like(w))))));

/** A study row plus what a summary and the cursor need; never the rulebook. */
const summaryCols = {
  ...getTableColumns(studies),
  // drizzle renders ${studies.id} unqualified here, which would bind to v.id
  liveVersion: sql<number | null>`(SELECT max(v.version) FROM rulebook_versions v WHERE v.study_id = studies.id AND v.status = 'signed')`,
  key: sql<string>`${listKey}::text`,
};
const listOrder = [studies.stage, listKey, studies.id];

/** Keyset cursor: the last row's (stage, listKey, id), base64url JSON. */
const Cursor = z.tuple([z.number().int(), z.string().regex(/^-?\d+(\.\d+)?$/), z.uuid()]);
const encodeCursor = (r: { stage: number; key: string; id: string }) => Buffer.from(JSON.stringify([r.stage, r.key, r.id])).toString("base64url");
function decodeCursor(c: string) {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(c, "base64url").toString()));
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

export const studyRoutes =
  ({ db, boss }: Ctx): FastifyPluginAsync =>
  async (app) => {
    async function assertDocsExist(ids: string[]) {
      const found = await db.select({ id: documents.id }).from(documents).where(inArray(documents.id, ids));
      const missing = ids.filter((id) => !found.some((f) => f.id === id));
      if (missing.length) throw new HttpError(400, `Unknown document ids: ${missing.join(", ")}`);
    }

    app.post("/studies", async (req, reply) => {
      const body = parse(CreateStudyBody, req.body);
      const ids = [...new Set(body.documentIds)];
      await assertDocsExist(ids);
      const { studyId, jobId } = await db.transaction(async (tx) => {
        // A double-click or a retried request must not create a second study from the same files:
        // serialise creates for this file set, and hand back a study still being set up with exactly these files.
        const key = [...ids].sort().join(",");
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        const links = await tx
          .select({ studyId: studyDocuments.studyId, documentId: studyDocuments.documentId })
          .from(studyDocuments)
          .innerJoin(studies, eq(studies.id, studyDocuments.studyId))
          .where(eq(studies.status, "setting_up"));
        const sets = new Map<string, string[]>();
        for (const l of links) sets.set(l.studyId, [...(sets.get(l.studyId) ?? []), l.documentId]);
        const same = [...sets].find(([, docIds]) => docIds.sort().join(",") === key)?.[0];
        if (same) {
          const [job] = await tx.select().from(jobs).where(and(eq(jobs.studyId, same), eq(jobs.kind, "identify"))).orderBy(desc(jobs.createdAt)).limit(1);
          if (job) return { studyId: same, jobId: job.id };
        }
        const [study] = await tx.insert(studies).values({}).returning();
        await tx.insert(studyDocuments).values(ids.map((documentId) => ({ studyId: study!.id, documentId })));
        await audit(tx, body.by ?? "system", study!.id, "study.created", { documentIds: ids });
        return { studyId: study!.id, jobId: await createJob(tx, "identify", study!.id, null) };
      });
      await sendJob(boss, "identify", { jobId, studyId });
      return reply.status(201).send({ studyId, jobId });
    });

    app.get("/studies", async (req): Promise<StudyPage> => {
      const { view, site, q, cursor, limit } = parse(StudyListQuery, req.query);
      const where = and(view && eq(studies.stage, VIEW_STAGE[view]), site ? eq(studies.siteName, site) : undefined, matchesQ(q));
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await db
        .select(summaryCols)
        .from(studies)
        .where(and(where, after ? sql`(${studies.stage}, ${listKey}, ${studies.id}) > (${after[0]}, ${after[1]}::numeric, ${after[2]}::uuid)` : undefined))
        .orderBy(...listOrder)
        .limit(limit + 1);
      const [{ total }] = (await db.select({ total: count() }).from(studies).where(where)) as [{ total: number }];
      const page = rows.slice(0, limit);
      return { items: page.map((r) => studySummaryDto(r, r.liveVersion)), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null, total };
    });

    /** Per view and per site, for tabs and the sidebar. `site` narrows the view counts, never the site list. */
    app.get<{ Querystring: { site?: string } }>("/studies/counts", async (req): Promise<StudyCounts> => {
      const site = req.query.site || undefined;
      const byStage = await db.select({ stage: studies.stage, n: count() }).from(studies).where(site ? eq(studies.siteName, site) : undefined).groupBy(studies.stage);
      // <> '' also drops NULL
      const sites = await db.select({ name: studies.siteName, count: count() }).from(studies).where(ne(studies.siteName, "")).groupBy(studies.siteName).orderBy(studies.siteName);
      const n = (stage: number) => byStage.find((r) => r.stage === stage)?.n ?? 0;
      return {
        all: byStage.reduce((sum, r) => sum + r.n, 0),
        views: Object.fromEntries(Object.entries(VIEW_STAGE).map(([v, stage]) => [v, n(stage)])) as StudyCounts["views"],
        sites: sites.map((r) => ({ name: r.name!, count: r.count })),
      };
    });

    /** ⌘K: contracts as the list matches them, and rates in each study's live version. */
    app.get("/search", async (req): Promise<SearchResults> => {
      const { q, limit } = parse(SearchQuery, req.query);
      const words = wordsOf(q);
      if (!words.length) return { contracts: [], rates: [] };
      const contracts = await db.select(summaryCols).from(studies).where(matchesQ(q)).orderBy(...listOrder).limit(limit);
      const cents = amountOf(q);
      const hit = cents !== null ? sql`cents = ${cents}` : sql.join(words.map((w) => sql`(name ILIKE ${like(w)} OR code ILIKE ${like(w)})`), sql` AND `);
      // ponytail: expands every live rulebook's JSONB per search, fine for hundreds of contracts. If it gets slow, keep rates in a
      // table (filled at sign-off) with a pg_trgm GIN index on name and code.
      // cents as float8 so node-pg hands back a number (exact below 2^53).
      const { rows: rates } = await db.execute<RateHit>(sql`
        WITH live AS (
          SELECT DISTINCT ON (v.study_id) v.study_id, v.version, v.rulebook AS rb, s.protocol, s.sponsor
          FROM rulebook_versions v JOIN studies s ON s.id = v.study_id
          WHERE v.status = 'signed' AND v.rulebook IS NOT NULL
          ORDER BY v.study_id, v.version DESC
        ), rates AS (
          SELECT l.study_id, l.protocol, l.sponsor, l.version, 'procedure' AS kind, ARRAY[0, g.i, p.i] AS ord,
            format('/budgetGrids/%s/procedures/%s', g.i - 1, p.i - 1) AS path,
            p.x->>'name' AS name, p.x->>'code' AS code, (p.x->>'unitCents')::float8 AS cents, coalesce(g.x->>'label', '') AS detail
          FROM live l, jsonb_array_elements(l.rb->'budgetGrids') WITH ORDINALITY g(x, i), jsonb_array_elements(g.x->'procedures') WITH ORDINALITY p(x, i)
          UNION ALL
          SELECT l.study_id, l.protocol, l.sponsor, l.version, 'fee', ARRAY[1, f.i, 0], format('/siteFees/%s', f.i - 1),
            f.x->>'name', f.x->>'code', (f.x->>'amountCents')::float8, coalesce(${JSON.stringify(ENUM_LABELS.trigger)}::jsonb->>(f.x->>'trigger'), f.x->>'trigger', '')
          FROM live l, jsonb_array_elements(l.rb->'siteFees') WITH ORDINALITY f(x, i)
          UNION ALL
          SELECT l.study_id, l.protocol, l.sponsor, l.version, 'invoiceable', ARRAY[2, n.i, 0], format('/invoiceables/%s', n.i - 1),
            n.x->>'name', n.x->>'code', (n.x->>'amountCents')::float8, coalesce(n.x->>'frequency', '')
          FROM live l, jsonb_array_elements(l.rb->'invoiceables') WITH ORDINALITY n(x, i)
        )
        SELECT study_id AS "studyId", protocol, sponsor, version, path, kind, name, code, cents, detail
        FROM rates WHERE ${hit}
        ORDER BY protocol NULLS LAST, study_id, ord
        LIMIT ${limit}`);
      return { contracts: contracts.map((r) => studySummaryDto(r, r.liveVersion)), rates };
    });

    async function detail(id: string): Promise<StudyDetailDto> {
      const [s] = await db.select().from(studies).where(eq(studies.id, id));
      if (!s) throw notFound("Study");
      const versions = await db.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, id)).orderBy(desc(rulebookVersions.version));
      const docs = await db
        .select({ d: documents })
        .from(studyDocuments)
        .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
        .where(eq(studyDocuments.studyId, id))
        .orderBy(studyDocuments.addedAt, documents.filename);
      const live = versions.find((v) => v.status === "signed")?.version ?? null;
      return { ...studySummaryDto(s, live), documents: docs.map((r) => documentDto(r.d)), versions: versions.map(versionSummaryDto) };
    }

    app.get<{ Params: { id: string } }>("/studies/:id", async (req) => detail(req.params.id));

    app.patch<{ Params: { id: string } }>("/studies/:id", async (req) => {
      const { by, ...fields } = parse(ConfirmStudyBody, req.body);
      await db.transaction(async (tx) => {
        const [s] = await tx.select().from(studies).where(eq(studies.id, req.params.id)).for("update");
        if (!s) throw notFound("Study");
        await tx.update(studies).set({ ...fields, updatedAt: new Date() }).where(eq(studies.id, s.id));
        const before = { sponsor: s.sponsor, protocol: s.protocol, siteName: s.siteName, investigator: s.investigator };
        await audit(tx, by, s.id, "study.confirmed", { before, after: fields });
      });
      return detail(req.params.id);
    });

    app.post<{ Params: { id: string } }>("/studies/:id/extract", async (req, reply) => {
      const body = parse(ExtractBody, req.body ?? {});
      const studyId = req.params.id;
      const newDocs = [...new Set(body.documentIds ?? [])];
      if (newDocs.length) await assertDocsExist(newDocs);
      const res = await db.transaction(async (tx) => {
        const [s] = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update"); // serialises version creation
        if (!s) throw notFound("Study");
        if (newDocs.length) await tx.insert(studyDocuments).values(newDocs.map((documentId) => ({ studyId, documentId }))).onConflictDoNothing();
        const [latest] = await tx.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, studyId)).orderBy(desc(rulebookVersions.version)).limit(1);

        if (latest?.status === "extracting") {
          // already running: idempotent, hand back the same job
          const [job] = await tx
            .select()
            .from(jobs)
            .where(and(eq(jobs.studyId, studyId), eq(jobs.version, latest.version), eq(jobs.kind, "extract")))
            .orderBy(desc(jobs.createdAt))
            .limit(1);
          if (job) return { jobId: job.id, version: latest.version };
        }
        if (latest?.status === "draft") throw new HttpError(409, `Version ${latest.version} is a draft under review; sign it off before extracting again`);

        let version: number;
        if (latest && (latest.status === "failed" || latest.status === "extracting")) {
          // retry reuses the same version row: never a duplicate version
          version = latest.version;
          await tx.update(rulebookVersions).set({ status: "extracting", error: null, updatedAt: new Date() }).where(eq(rulebookVersions.id, latest.id));
        } else {
          version = (latest?.version ?? 0) + 1;
          await tx.insert(rulebookVersions).values({ studyId, version, status: "extracting" });
        }
        await refreshStudyStatus(tx, studyId, body.by);
        const jobId = await createJob(tx, "extract", studyId, version);
        await audit(tx, body.by ?? "system", studyId, "extraction.queued", { version, jobId, addedDocumentIds: newDocs });
        return { jobId, version };
      });
      await sendJob(boss, "extract", { jobId: res.jobId, studyId, version: res.version });
      return reply.status(202).send({ jobId: res.jobId, version: res.version });
    });

    /**
     * Manual entry: a draft seeded from the live rulebook (amendment) or a blank one prefilled with the
     * confirmed study details. Values are tagged manual and go through the same checks and sign-off.
     */
    app.post<{ Params: { id: string } }>("/studies/:id/versions", async (req, reply) => {
      const { by } = parse(CreateVersionBody, req.body);
      const studyId = req.params.id;
      const port = await getExtraction();
      const version = await db.transaction(async (tx) => {
        const [s] = await tx.select().from(studies).where(eq(studies.id, studyId)).for("update");
        if (!s) throw notFound("Study");
        const versions = await tx.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, studyId)).orderBy(desc(rulebookVersions.version));
        const latest = versions[0];
        if (latest?.status === "draft") throw new HttpError(409, `Version ${latest.version} is already a draft under review; correct its values there`);
        if (latest?.status === "extracting") throw new HttpError(409, `Version ${latest.version} is still being extracted; wait for it to finish or fail`);
        const docs = await tx
          .select({ d: documents })
          .from(studyDocuments)
          .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
          .where(eq(studyDocuments.studyId, studyId))
          .orderBy(studyDocuments.addedAt, documents.filename);
        const liveRow = versions.find((v) => v.status === "signed");
        const live = liveRow?.rulebook;
        const rulebook = manualRulebook(s, docs.map((r) => r.d), live ?? null);
        const anomalies = port.runContractChecks(rulebook, { crossRead: null, pages: [], notes: [] });
        const fields = { status: "draft", rulebook, crossRead: null, anomalies, pages: [], notes: [], cost: [], costUsd: 0, inputTokens: 0, outputTokens: 0, appliesFrom: appliesFromOf(rulebook), error: null, updatedAt: new Date() };
        let v: number;
        if (latest?.status === "failed") {
          // replaces the failed attempt: same version number, never a gap
          v = latest.version;
          await tx.update(rulebookVersions).set(fields).where(eq(rulebookVersions.id, latest.id));
        } else {
          v = (latest?.version ?? 0) + 1;
          await tx.insert(rulebookVersions).values({ studyId, version: v, ...fields });
        }
        await refreshStudyStatus(tx, studyId, by);
        await audit(tx, by, studyId, "version.manual_created", { version: v, seededFrom: live ? "live version" : "blank", seededFromVersion: live ? liveRow!.version : null });
        return v;
      });
      return reply.status(201).send({ version });
    });

    app.get<{ Params: { id: string } }>("/jobs/:id", async (req): Promise<JobDto> => {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, req.params.id));
      if (!job) throw notFound("Job");
      return { id: job.id, state: job.state as JobDto["state"], progress: job.progress, step: job.step, error: job.error };
    });
  };
