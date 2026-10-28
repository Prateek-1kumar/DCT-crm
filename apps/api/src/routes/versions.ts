import {
  amountOf,
  appliesFromOf,
  ByHandBody,
  CorrectValueBody,
  diffRulebooks,
  followUps,
  labelFor,
  type MasterSearch,
  pickRetype,
  ProofreadBody,
  proofreadMarks,
  ReportValueBody,
  type ReviewItem,
  Rulebook,
  SendBackBody,
  SignOffBody,
  searchMaster,
  signOffRefusal,
  type ValueEvidence,
} from "@dct/shared";
import { buildWorkbook } from "@dct/shared/xlsx";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { isDeepStrictEqual } from "node:util";
import type { Ctx } from "../app.js";
import { rulebookVersions, settings } from "../db/schema.js";
import { audit, CORRECTION_OPENED, loadVersion, raiseAlert, refreshStudyStatus, versionDto } from "../domain.js";
import { getExtraction } from "../extraction/port.js";
import { HttpError, notFound, parse } from "../lib/http.js";
import { write } from "../lib/idempotency.js";
import { parsePointer, setAt } from "../lib/pointer.js";
import { answer, askAbout, at, byHandQuestions, empty, hiddenPaths, leaf, mask, sampling } from "../review.js";

type P = { Params: { id: string; v: string } };
const versionNo = (v: unknown) => {
  if (typeof v !== "string" || !/^[1-9]\d{0,8}$/.test(v)) throw new HttpError(400, `Invalid version "${v}"`);
  return Number(v);
};
const text = (q: unknown, max = 200) => (typeof q === "string" ? q.slice(0, max) : "");

export const versionRoutes =
  ({ db }: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.get<P>("/studies/:id/versions/:v", async (req) => versionDto(await loadVersion(db, req.params.id, versionNo(req.params.v))));

    async function withRulebook(id: string, v: string) {
      const row = await loadVersion(db, id, versionNo(v));
      if (!row.rulebook) throw notFound(`Invoicing master of version ${row.version}`);
      return row as typeof row & { rulebook: Rulebook };
    }

    /** One document, so searched in the app with the same matcher the in-browser sample server uses. */
    app.get<P & { Querystring: { q?: string } }>("/studies/:id/versions/:v/search", async (req): Promise<MasterSearch> => {
      const row = await withRulebook(req.params.id, req.params.v);
      const q = text(req.query.q);
      // On a draft, a value still hidden for someone to type blind must not be findable: amounts match values, and a
      // term's words include its values. Names and codes of grid rows and fees don't, so those still match.
      // A row's fixed-list words (a fee's trigger) can be withheld too, so the search reads the master as it's shown.
      const hidden = hiddenPaths(row);
      const byValue = (h: MasterSearch["hits"][number]) => amountOf(q) !== null || h.section === "terms";
      const shown = hidden.length ? mask(row.rulebook, hidden, row) : row.rulebook;
      return { q, hits: searchMaster(shown, q).filter((h) => !(byValue(h) && hidden.some((p) => p === h.path || p.startsWith(`${h.path}/`)))) };
    });

    app.get<P & { Querystring: { by?: string } }>("/studies/:id/versions/:v/export.xlsx", async (req, reply) => {
      const row = await withRulebook(req.params.id, req.params.v);
      // Billing works only from approved terms; a draft also still hides values someone has to type blind.
      if (row.status !== "signed" && row.status !== "superseded") throw new HttpError(409, "Only an approved version can be exported.");
      // What was approved, not the editable study row.
      const st = row.rulebook.study;
      const xlsx = await buildWorkbook(row.rulebook, {
        protocol: st.protocol.value,
        sponsor: st.sponsor.value,
        site: st.siteName.value,
        investigator: st.investigator.value,
        version: row.version,
        status: row.status,
        approvedBy: row.signedBy,
        approvedAt: row.signedAt?.toISOString() ?? null,
      });
      await audit(db, text(req.query.by, 100) || "system", row.studyId, "version.exported", { version: row.version, format: "xlsx" });
      const protocol = st.protocol.value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "contract";
      const name = `${protocol}-v${row.version}-invoicing-master.xlsx`;
      return reply
        .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("content-disposition", `attachment; filename="${name}"`)
        .send(Buffer.from(xlsx));
    });

    app.get<P & { Querystring: { against?: string } }>("/studies/:id/versions/:v/diff", async (req) => {
      const against = req.query.against;
      if (!against) throw new HttpError(400, "Query parameter `against` (version number) is required");
      const [v, a] = [versionNo(req.params.v), versionNo(against)];
      const after = await loadVersion(db, req.params.id, v);
      const before = await loadVersion(db, req.params.id, a);
      if (!after.rulebook || !before.rulebook) throw new HttpError(409, "Both versions need an extracted rulebook to diff");
      // Blind entry: a withheld value isn't shown as changed either. Both sides are masked alike, so the words blanked
      // around it on one side don't show up as changed against the other.
      const hidden = [...new Set([...hiddenPaths(before), ...hiddenPaths(after)])];
      const where = { evidence: [...before.evidence, ...after.evidence], review: [...before.review, ...after.review] };
      const view = (rb: Rulebook) => (hidden.length ? mask(rb, hidden, where) : rb);
      return diffRulebooks(view(before.rulebook), view(after.rulebook)).filter((e) => !hidden.includes(e.path));
    });

    /**
     * Typing a contract in by hand, one value at a time, until typing is marked done. Every typed value is attested;
     * after removing one row or visit the evidence of the ones below moves up. The result must stay a valid master.
     */
    app.patch<P>("/studies/:id/versions/:v/values", async (req, reply) =>
      write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        if (row.status !== "draft" || !row.byHand || !row.rulebook) throw new HttpError(409, "Values can only be typed on a contract being typed in by hand. Use “This looks wrong” instead.");
        if (row.review.length) throw new HttpError(409, "Typing is marked done. Use “This looks wrong” to change a value.");
        const body = CorrectValueBody.safeParse(req.body);
        if (!body.success) throw new HttpError(400, "Say who is typing.");
        const { path, value, by } = body.data;
        const tokens = parsePointer(path);
        const before = at(row.rulebook, path);
        if (before === undefined && tokens.at(-2) !== "cells") throw new HttpError(400, `Unknown field ${path}`);
        const next = structuredClone(row.rulebook);
        setAt(next, tokens, value);
        const checked = Rulebook.safeParse(next);
        if (!checked.success) throw new HttpError(400, "That field can't be left empty or take that value.");
        const rb = checked.data;
        const after = at(rb, path);
        // typed again as it is, by whoever typed it: nothing changes, nothing is logged
        if (isDeepStrictEqual(before, after) && (!leaf(after) || empty(after) || row.evidence.some((e) => e.path === path && e.note === `Typed by hand by ${by}`))) return versionDto(row);
        const removed =
          Array.isArray(before) && Array.isArray(after) && after.length === before.length - 1
            ? ((i: number) => (i === -1 ? after.length : i))(after.findIndex((x, i) => !isDeepStrictEqual(x, before[i])))
            : -1;
        const evidence: ValueEvidence[] = row.evidence
          .flatMap((e) => {
            if (!e.path.startsWith(`${path}/`)) return [e];
            const [k, ...tail] = e.path.slice(path.length + 1).split("/");
            if (removed >= 0 && Number(k) === removed) return [];
            const moved = removed >= 0 && Number(k) > removed ? `${path}/${[Number(k) - 1, ...tail].join("/")}` : e.path;
            // a typed value keeps its mark only if it's still there, unchanged
            return isDeepStrictEqual(at(row.rulebook, e.path), at(rb, moved)) ? [{ ...e, path: moved }] : [];
          })
          .filter((e) => e.path !== path && at(rb, e.path) !== undefined);
        if (leaf(after) && !empty(after)) evidence.push({ path, status: "attested", where: [], printed: null, note: `Typed by hand by ${by}` });
        const editors = row.editors.includes(by) ? row.editors : [...row.editors, by];
        const [updated] = await tx
          .update(rulebookVersions)
          .set({ rulebook: rb, evidence, editors, appliesFrom: appliesFromOf(rb), updatedAt: new Date() })
          .where(eq(rulebookVersions.id, row.id))
          .returning();
        await refreshStudyStatus(tx, row.studyId, by);
        // A row or visit added or removed is logged too, by its size: the master changed shape.
        await audit(tx, by, row.studyId, "value.typed", { version: row.version, path, value: labelFor(rb, path), ...(leaf(after) ? { before: before ?? null, after } : { items: Array.isArray(after) ? after.length : null }) });
        return versionDto(updated!);
      }),
    );

    /**
     * Typing is done: someone else re-types up to 10 randomly chosen typed values (all of them if fewer), blind. The
     * contract's checks run on what was typed, as after a read, and every number nobody typed (a placeholder of the blank
     * form) is asked as a missing value.
     */
    app.post<P>("/studies/:id/versions/:v/by-hand/done", async (req, reply) => {
      const body = ByHandBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, "Say who is typing.");
      const port = await getExtraction();
      return write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        if (row.status !== "draft" || !row.byHand || !row.rulebook) throw new HttpError(409, "Only a contract typed by hand can be marked done.");
        if (row.review.length) throw new HttpError(409, "Typing is already marked done.");
        const rb = row.rulebook;
        const { typed, sample } = pickRetype(rb, row.evidence, sampling.random);
        if (!typed.length) throw new HttpError(400, "Type at least one value first.");
        const spots = sample.map((p) => askAbout(rb, row.evidence, p, `spot:${p}`, "spot_check"));
        const anomalies = port.runContractChecks(rb);
        const review = [...spots, ...byHandQuestions(rb, row.evidence, anomalies, new Set(sample))];
        const [updated] = await tx.update(rulebookVersions).set({ review, anomalies, updatedAt: new Date() }).where(eq(rulebookVersions.id, row.id)).returning();
        await refreshStudyStatus(tx, row.studyId, body.data.by);
        await audit(tx, body.data.by, row.studyId, "byhand.done", { version: row.version, typed: typed.length, "re-type": sample.length, questions: review.length - spots.length });
        return versionDto(updated!);
      });
    });

    /** One answer to one question (AnswerReviewBody); answering again changes it while the version is a draft. */
    app.post<{ Params: { id: string; v: string; itemId: string } }>("/studies/:id/versions/:v/review/:itemId", async (req, reply) => {
      const port = await getExtraction();
      return write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        if (row.status !== "draft" || !row.rulebook) throw new HttpError(409, `Version ${row.version} is ${row.status}; only a draft takes answers.`);
        const draft = {
          version: row.version, byHand: row.byHand, rulebook: row.rulebook, review: structuredClone(row.review), evidence: structuredClone(row.evidence), editors: [...row.editors],
          proofread: row.proofread, anomalies: row.anomalies,
        };
        const answered = answer(draft, req.params.itemId, req.body, port.isoDate);
        // a repeat that changes nothing writes nothing and logs nothing
        if (answered.unchanged) return versionDto(row);
        const { by, action, detail } = answered.log;
        followUps(draft, answered, (rb) => port.runContractChecks(rb), (p, id, reason) => askAbout(draft.rulebook, draft.evidence, p, id, reason));
        const [updated] = await tx
          .update(rulebookVersions)
          .set({ rulebook: draft.rulebook, review: draft.review, evidence: draft.evidence, editors: draft.editors, appliesFrom: appliesFromOf(draft.rulebook), updatedAt: new Date() })
          .where(eq(rulebookVersions.id, row.id))
          .returning();
        await refreshStudyStatus(tx, row.studyId, by);
        await audit(tx, by, row.studyId, action, detail);
        // a sample miss, an incident: in the log and told to everyone
        if (answered.incident) {
          await audit(tx, by, row.studyId, "sample.missed", answered.incident.detail);
          await raiseAlert(tx, { kind: "sample_missed", studyId: row.studyId, version: row.version, by, count: answered.incident.count });
        }
        return versionDto(updated!);
      });
    });

    /**
     * "This looks wrong". On a draft: a blocking blind question about the value. On the live version: a correction draft
     * (a copy of it plus that question); the live version stays live until the draft is approved.
     */
    app.post<P>("/studies/:id/versions/:v/report", async (req, reply) => {
      const body = ReportValueBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, "Add a short note and say who is reporting.");
      const { path, note, by } = body.data;
      return write(db, req, reply, async (tx) => {
        // the study's lock (taken first, by loadVersion) also serialises version creation
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        const value = row.rulebook ? at(row.rulebook, path) : undefined;
        if (value === undefined || !leaf(value)) throw new HttpError(400, "Pick a single value to report.");
        let draft = row;
        if (row.status === "signed") {
          const [newest] = await tx.select({ version: rulebookVersions.version, status: rulebookVersions.status }).from(rulebookVersions).where(eq(rulebookVersions.studyId, row.studyId)).orderBy(desc(rulebookVersions.version)).limit(1);
          // A newer version holds the amendment: report it there once it's a draft. One that couldn't be read is read again
          // first (POST /extract reuses its version), never replaced by a correction: the amendment's terms would be lost.
          if (newest!.status === "failed")
            throw new HttpError(409, `The amendment in version ${newest!.version} couldn't be read. Read it again, or type it in by hand, then report this on that version.`);
          if (newest!.status === "extracting") throw new HttpError(409, `Version ${newest!.version} is being read right now. When it's ready, report this there.`);
          if (newest!.version !== row.version) throw new HttpError(409, `Version ${newest!.version} is already in progress. Report it there.`);
          draft = (
            await tx
            .insert(rulebookVersions)
            .values({ studyId: row.studyId, version: row.version + 1, status: "draft", rulebook: row.rulebook, crossRead: row.crossRead, anomalies: row.anomalies, pages: row.pages, notes: row.notes, evidence: row.evidence, pdfCheck: row.pdfCheck, appliesFrom: row.appliesFrom })
            .returning()
          )[0]!;
          await audit(tx, by, row.studyId, CORRECTION_OPENED, { version: draft.version, seededFromVersion: row.version });
        } else if (row.status !== "draft" || row.byHand) throw new HttpError(409, `Version ${row.version} is ${row.status}; report a value on the live version or a draft.`);
        // asked already, or withheld with a question (a cap's limit while its kind is asked: its question would name the kind)
        if (hiddenPaths(draft).includes(path)) throw new HttpError(409, "There's already an open question about this value.");
        // the note goes with the question, so whoever answers it sees why (its numbers blanked until it's settled)
        const item = { ...askAbout(draft.rulebook!, draft.evidence, path, `reported:${draft.review.length + 1}`, "reported"), reported: { by, note, at: new Date().toISOString() } };
        const [updated] = await tx.update(rulebookVersions).set({ review: [...draft.review, item], updatedAt: new Date() }).where(eq(rulebookVersions.id, draft.id)).returning();
        await refreshStudyStatus(tx, row.studyId, by);
        await audit(tx, by, row.studyId, typeof value === "number" ? "number.reported" : "value.reported", { version: draft.version, path, value: labelFor(draft.rulebook, path), note });
        return versionDto(updated!);
      });
    });

    /** Values that looked right to someone proofreading. Any version with a master, live ones too: marks never change its numbers. */
    app.post<P>("/studies/:id/versions/:v/proofread", async (req, reply) => {
      const body = ProofreadBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, "Say who is proofreading and which values.");
      const { paths, by } = body.data;
      return write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        if (!row.rulebook || row.status === "superseded") throw new HttpError(409, `Version ${row.version} can't be proofread.`);
        const rb = row.rulebook;
        if (paths.some((p) => at(rb, p) === undefined)) throw new HttpError(400, "One of those values isn't in the invoicing master.");
        const proofread = proofreadMarks(row.proofread, paths, by, new Date().toISOString());
        // marked by them already: nothing changes, nothing is logged
        if (!proofread) return versionDto(row);
        const [updated] = await tx.update(rulebookVersions).set({ proofread, updatedAt: new Date() }).where(eq(rulebookVersions.id, row.id)).returning();
        await audit(tx, by, row.studyId, "values.proofread", { version: row.version, values: paths.length });
        return versionDto(updated!);
      });
    });

    /** The approver reopens answered questions with a note; they're answered again, blind, and the contract goes back to Needs you. */
    app.post<P>("/studies/:id/versions/:v/send-back", async (req, reply) => {
      const body = SendBackBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, "Pick the answers to send back and add a note.");
      const { note, by } = body.data;
      return write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        if (row.status !== "draft") throw new HttpError(409, `Version ${row.version} is ${row.status}; only a draft's answers can be sent back.`);
        const review = structuredClone(row.review);
        const evidence = structuredClone(row.evidence);
        const items = [...new Set(body.data.itemIds)].map((id) => review.find((i) => i.id === id));
        if (items.some((i) => !i)) throw new HttpError(400, "One of those questions isn't on this version.");
        // an unanswered one (sent back already, or never answered): the state has moved on, as with any repeat
        if (items.some((i) => i!.outcome === null)) throw new HttpError(409, "Only answered questions can be sent back.");
        const now = new Date().toISOString();
        for (const i of items as ReviewItem[]) {
          Object.assign(i, { outcome: null, answer: null, compare: null, sentBack: { by, note, at: now } });
          const ev = i.path ? evidence.find((e) => e.path === i.path) : undefined;
          if (ev?.status === "attested") Object.assign(ev, { status: "conflict", note: `Sent back by ${by}` });
        }
        // a term listed to bill by hand comes off the list while its answer is reopened
        const reopened = new Set(items.map((i) => i!.id));
        const rulebook = row.rulebook && { ...row.rulebook, unclassified: row.rulebook.unclassified.filter((u) => !u.itemId || !reopened.has(u.itemId)) };
        const [updated] = await tx.update(rulebookVersions).set({ review, evidence, rulebook, updatedAt: new Date() }).where(eq(rulebookVersions.id, row.id)).returning();
        // Its own alert, with the note; no "questions ready" on top.
        await refreshStudyStatus(tx, row.studyId, by, { alert: false });
        await raiseAlert(tx, { kind: "sent_back", studyId: row.studyId, version: row.version, by, count: items.length, note });
        // which questions, so the log can blank the note while they're open again
        await audit(tx, by, row.studyId, "review.sent_back", { version: row.version, questions: items.length, itemIds: items.map((i) => i!.id), note });
        return versionDto(updated!);
      });
    });

    /** Approval (ADR-001 I1–I6): refused, with what to do, by the gate the approve page explains (signOffRefusal). */
    app.post<P>("/studies/:id/versions/:v/sign-off", async (req, reply) => {
      const body = parse(SignOffBody, req.body);
      return write(db, req, reply, async (tx) => {
        const row = await loadVersion(tx, req.params.id, versionNo(req.params.v), true);
        const [cfg] = await tx.select().from(settings).where(eq(settings.id, 1));
        const refusal = signOffRefusal({ ...row, updatedAt: row.updatedAt.toISOString() }, { asOf: body.asOf, by: body.by, makerChecker: cfg?.makerChecker ?? true });
        if (refusal) throw new HttpError(409, refusal);
        // the previous live version stays live until this moment
        await tx
          .update(rulebookVersions)
          .set({ status: "superseded", updatedAt: new Date() })
          .where(and(eq(rulebookVersions.studyId, row.studyId), eq(rulebookVersions.status, "signed")));
        const [updated] = await tx
          .update(rulebookVersions)
          .set({ status: "signed", signedBy: body.by, signedAt: new Date(), signNote: body.note ?? null, updatedAt: new Date() })
          .where(eq(rulebookVersions.id, row.id))
          .returning();
        await refreshStudyStatus(tx, row.studyId, body.by);
        await audit(tx, body.by, row.studyId, "version.signed", { version: row.version, note: body.note ?? null, appliesFrom: row.appliesFrom });
        return versionDto(updated!);
      });
    });
  };
