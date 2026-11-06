import type { Rulebook } from "@dct/shared";
import { sql } from "drizzle-orm";
import { bigserial, check, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at("created_at").notNull().defaultNow();

export const partyKind = pgEnum("party_kind", ["sponsor", "cro", "site"]);

/** Sponsors, CROs and site entities. House rules attach to these records, so matching is exact on the record (design §6). */
export const parties = pgTable("parties", {
  id: id(),
  kind: partyKind("kind").notNull(),
  name: text("name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  createdBy: text("created_by").notNull(),
});

export const studies = pgTable("studies", {
  id: id(),
  /** Empty until the first read of the contract finishes. */
  protocol: text("protocol"),
  sponsorId: uuid("sponsor_id").references(() => parties.id),
  payerId: uuid("payer_id").references(() => parties.id),
  siteId: uuid("site_id").references(() => parties.id),
  createdAt: createdAt(),
  createdBy: text("created_by").notNull(),
});

export interface PageInfo {
  page: number;
  /** "image" until a read has transcribed a scanned page, then "scan". */
  kind: "text" | "scan" | "image";
  chars: number;
  firstLine: string;
}

/** A PDF, stored once by its sha256 (the file lives in the upload folder under that name). */
export const documents = pgTable("documents", {
  id: id(),
  sha256: text("sha256").notNull().unique(),
  name: text("name").notNull(),
  bytes: integer("bytes").notNull(),
  pages: jsonb("pages").$type<PageInfo[]>().notNull(),
  createdAt: createdAt(),
  createdBy: text("created_by").notNull(),
});

export const studyDocuments = pgTable(
  "study_documents",
  {
    studyId: uuid("study_id").notNull().references(() => studies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    addedAt: createdAt(),
    addedBy: text("added_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.studyId, t.documentId] })],
);

export const versionStatus = pgEnum("version_status", ["reading", "draft", "failed", "approved", "superseded"]);

export interface Problem {
  check: string;
  id?: string;
  doc?: string;
  page?: number;
  message: string;
}

/** One rulebook per version. Once approved its rulebook can't change, enforced by a trigger (migration 0002). */
export const versions = pgTable(
  "versions",
  {
    id: id(),
    studyId: uuid("study_id").notNull().references(() => studies.id),
    number: integer("number").notNull(),
    status: versionStatus("status").notNull(),
    /** The documents this version was read from, fixed when the read starts. */
    documentIds: uuid("document_ids").array().notNull(),
    rulebook: jsonb("rulebook").$type<Rulebook>(),
    /** What the checks still find wrong, recomputed after every answer; approval needs none. */
    problems: jsonb("problems").$type<Problem[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    createdBy: text("created_by").notNull(),
    approvedAt: at("approved_at"),
    approvedBy: text("approved_by"),
  },
  (t) => [
    uniqueIndex("versions_study_number").on(t.studyId, t.number),
    // one read at a time per study
    uniqueIndex("versions_one_reading").on(t.studyId).where(sql`${t.status} = 'reading'`),
    uniqueIndex("versions_one_live").on(t.studyId).where(sql`${t.status} = 'approved'`),
  ],
);

export const readStatus = pgEnum("read_status", ["queued", "running", "done", "failed"]);

export const reads = pgTable(
  "reads",
  {
    id: id(),
    versionId: uuid("version_id").notNull().unique().references(() => versions.id),
    status: readStatus("status").notNull().default("queued"),
    budgetUsd: doublePrecision("budget_usd").notNull(),
    spentUsd: doublePrecision("spent_usd").notNull().default(0),
    /** Plain-English progress lines, appended as the read goes: the live feed. */
    progress: jsonb("progress").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    trace: jsonb("trace"),
    /** Why it failed, in plain English. */
    error: text("error"),
    createdAt: createdAt(),
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
  },
  (t) => [check("reads_spend", sql`${t.spentUsd} >= 0 AND ${t.budgetUsd} > 0`)],
);

/** Who answered which question of a version, with what. The rulebook carries the result; this is the record of who chose it. */
export const answers = pgTable("answers", {
  id: id(),
  versionId: uuid("version_id").notNull().references(() => versions.id),
  questionId: text("question_id").notNull(),
  option: integer("option").notNull(),
  by: text("by").notNull(),
  at: createdAt(),
});

/** Append-only: a trigger refuses updates and deletes (migration 0002). */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: createdAt(),
  by: text("by").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: uuid("entity_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
});

/** A write's Idempotency-Key: the first request with it runs, and its answer is replayed to a resend. `status` is null while that request is still running. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status"),
    body: jsonb("body"),
    createdAt: createdAt(),
  },
  (t) => [index("idempotency_keys_created").on(t.createdAt)],
);
