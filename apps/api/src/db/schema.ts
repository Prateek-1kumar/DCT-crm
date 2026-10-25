import type { ContractAnomaly, Rulebook } from "@dct/shared";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ExtractionNote, ExtractionOutput } from "../extraction/port.js";

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const studies = pgTable("studies", {
  id: uuid("id").primaryKey().defaultRandom(),
  sponsor: text("sponsor"),
  protocol: text("protocol"),
  siteName: text("site_name"),
  investigator: text("investigator"),
  status: text("status").notNull().default("setting_up"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").notNull().unique(),
  filename: text("filename").notNull(),
  kind: text("kind").notNull().default("other"),
  pageCount: integer("page_count").notNull(),
  storagePath: text("storage_path").notNull(),
  uploadedAt: ts("uploaded_at"),
});

export const studyDocuments = pgTable(
  "study_documents",
  {
    studyId: uuid("study_id").notNull().references(() => studies.id),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    addedAt: ts("added_at"),
  },
  (t) => [primaryKey({ columns: [t.studyId, t.documentId] })],
);

export const rulebookVersions = pgTable(
  "rulebook_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id").notNull().references(() => studies.id),
    version: integer("version").notNull(),
    /** extracting | draft | signed | superseded | failed */
    status: text("status").notNull().default("extracting"),
    rulebook: jsonb("rulebook").$type<Rulebook>(),
    crossRead: jsonb("cross_read").$type<Rulebook>(),
    anomalies: jsonb("anomalies").$type<ContractAnomaly[]>().notNull().default([]),
    pages: jsonb("pages").$type<ExtractionOutput["pages"]>().notNull().default([]),
    notes: jsonb("notes").$type<ExtractionNote[]>().notNull().default([]),
    cost: jsonb("cost").$type<ExtractionOutput["cost"]>().notNull().default([]),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    appliesFrom: text("applies_from"),
    editors: jsonb("editors").$type<string[]>().notNull().default([]),
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signNote: text("sign_note"),
    error: text("error"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [unique().on(t.studyId, t.version)],
);

/** Our view of background jobs (pg-boss job id = this id), so GET /jobs/:id can report progress. */
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  studyId: uuid("study_id").references(() => studies.id),
  version: integer("version"),
  /** queued | running | succeeded | failed */
  state: text("state").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  step: text("step").notNull().default("queued"),
  error: text("error"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/** Append-only: UPDATE/DELETE are rejected by a trigger (see the custom migration). */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at"),
  by: text("by").notNull(),
  studyId: uuid("study_id").references(() => studies.id),
  action: text("action").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
});

/** Single row (id = 1), seeded by migration. */
export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    people: jsonb("people").$type<string[]>().notNull().default([]),
    makerChecker: boolean("maker_checker").notNull().default(false),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);
