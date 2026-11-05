import { applyPatches, type Question, type Rulebook } from "@dct/shared";
import { checks } from "@dct/harness";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app.js";
import type { Tx } from "../db/index.js";
import { answers, reads, studies, versions } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { By } from "../lib/by.js";
import { loadDocs } from "../lib/docs.js";
import { HttpError } from "../lib/http.js";
import { parse } from "../lib/parse.js";

type Version = typeof versions.$inferSelect;

const ApproveBody = z.object({ by: By });
const AnswerBody = z.object({ option: z.int({ error: "Pick one of the options." }).min(0, "Pick one of the options."), by: By });

const one = (rows: Version[]) => {
  if (!rows[0]) throw new HttpError(404, "There is no such version.");
  return rows[0];
};

const lock = async (tx: Tx, id: string) => one(await tx.select().from(versions).where(eq(versions.id, id)).for("update"));

async function present(tx: Tx, v: Version) {
  const [given, [read]] = await Promise.all([
    tx.select().from(answers).where(eq(answers.versionId, v.id)).orderBy(asc(answers.at), asc(answers.id)),
    tx.select({ id: reads.id, status: reads.status }).from(reads).where(eq(reads.versionId, v.id)),
  ]);
  return {
    id: v.id,
    studyId: v.studyId,
    number: v.number,
    status: v.status,
    documentIds: v.documentIds,
    rulebook: v.rulebook,
    problems: v.problems,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedBy,
    answers: given.map((a) => ({ questionId: a.questionId, option: a.option, by: a.by, at: a.at })),
    read: read ?? null,
  };
}

function requireDraft(v: Version, doing: string) {
  if (v.status !== "draft") throw new HttpError(409, `This version is ${v.status}, so it can't be ${doing}. Only a draft can.`);
}

/** Terms an option changes or adds: a person chose them, whoever wrote the patch (design §5.5a). */
const decided = (option: Question["options"][number]) => new Set(option.patches.filter((p) => p.target === "term").map((p) => p.id));

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export async function versionsRoutes(api: FastifyInstance, { db }: Ctx) {
  api.get<{ Params: { id: string } }>("/versions/:id", async (req) => {
    return present(db, one(await db.select().from(versions).where(eq(versions.id, req.params.id))));
  });

  api.post<{ Params: { id: string; questionId: string } }>("/versions/:id/questions/:questionId/answer", async (req) => {
    const { option, by } = parse(AnswerBody, req.body);
    const { id, questionId } = req.params;
    return db.transaction(async (tx) => {
      const v = await lock(tx, id);
      requireDraft(v, "answered");
      const rulebook = v.rulebook!;
      const question = rulebook.questions.find((q) => q.id === questionId);
      if (!question) throw new HttpError(404, "This version has no such question.");
      if (question.state !== "open") throw new HttpError(409, "This question has already been answered");
      const chosen = question.options[option];
      if (!chosen) throw new HttpError(400, `This question has ${plural(question.options.length, "option")}: pick one of them.`);

      let patched: Rulebook;
      try {
        patched = applyPatches(rulebook, chosen.patches);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      const touched = decided(chosen);
      const next: Rulebook = {
        ...patched,
        terms: patched.terms.map((t) => (touched.has(t.id) ? { ...t, evidence: "person" } : t)),
        questions: patched.questions.map((q) => (q.id === questionId ? { ...q, state: "answered" } : q)),
      };

      const report = checks.runChecks(next, await loadDocs(tx, v.documentIds));
      const known = new Set(next.questions.map((q) => q.id));
      next.questions.push(...report.required.filter((q) => !known.has(q.id)));

      const [updated] = await tx.update(versions).set({ rulebook: next, problems: report.problems }).where(eq(versions.id, id)).returning();
      await tx.insert(answers).values({ versionId: id, questionId, option, by });
      await audit(tx, { by, action: "version.answered", entity: "version", entityId: id, detail: { questionId, option, label: chosen.label } });
      return present(tx, updated!);
    });
  });

  api.post<{ Params: { id: string } }>("/versions/:id/approve", async (req) => {
    const { by } = parse(ApproveBody, req.body);
    const { id } = req.params;
    return db.transaction(async (tx) => {
      const v = await lock(tx, id);
      requireDraft(v, "approved");
      // approvals of the study's versions queue up here, so two can't both become the live one
      await tx.select({ id: studies.id }).from(studies).where(eq(studies.id, v.studyId)).for("update");

      const blocking = v.rulebook!.questions.filter((q) => q.state === "open" && q.blocking);
      if (blocking[0]) throw new HttpError(409, `${plural(blocking.length, "question")} still need${blocking.length === 1 ? "s" : ""} an answer before this can be approved. First: "${blocking[0].question}"`);
      if (v.problems[0]) throw new HttpError(409, `${plural(v.problems.length, "problem")} still to fix before this can be approved. First: ${v.problems[0].message}`);
      const given = await tx.select({ by: answers.by }).from(answers).where(eq(answers.versionId, id));
      if (given.some((a) => a.by.toLowerCase() === by.toLowerCase())) throw new HttpError(409, "Someone who answered this version's questions can't also approve it: ask a colleague.");

      const [previous] = await tx.select().from(versions).where(and(eq(versions.studyId, v.studyId), eq(versions.status, "approved")));
      if (previous) {
        await tx.update(versions).set({ status: "superseded" }).where(eq(versions.id, previous.id));
        await audit(tx, { by, action: "version.superseded", entity: "version", entityId: previous.id, detail: { number: previous.number, supersededBy: id } });
      }
      const [approved] = await tx.update(versions).set({ status: "approved", approvedAt: new Date(), approvedBy: by }).where(eq(versions.id, id)).returning();
      await audit(tx, { by, action: "version.approved", entity: "version", entityId: id, detail: { number: v.number, supersedes: previous?.id ?? null } });
      return present(tx, approved!);
    });
  });
}
