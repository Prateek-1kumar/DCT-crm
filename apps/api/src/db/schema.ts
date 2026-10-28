import type { AlertKind, ContractAnomaly, ProofreadMark, ReviewItem, Rulebook, ValueEvidence } from "@dct/shared";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
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

/**
 * Contract-list order as one ascending key: needs you oldest first, every other stage newest first, to the microsecond.
 * `extract` from an interval is immutable, so it can be indexed; queries must use this exact expression to hit the index.
 */
export const listKey = sql`(CASE WHEN stage = 0 THEN 1 ELSE -1 END * extract(epoch FROM updated_at - timestamptz 'epoch'))`;

export const studies = pgTable(
  "studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sponsor: text("sponsor"),
    protocol: text("protocol"),
    siteName: text("site_name"),
    investigator: text("investigator"),
    status: text("status").notNull().default("setting_up"),
    /** What needs a person on the latest draft; kept by refreshStudyStatus. */
    needsYou: integer("needs_you").notNull().default(0),
    /** Contract-list urgency: 0 needs you · 1 couldn't read · 2 setting up · 3 waiting for approval · 4 extracting · 5 live. */
    stage: integer("stage")
      .notNull()
      .generatedAlwaysAs(
        sql`CASE WHEN status IN ('needs_review', 'amendment_in_review') THEN (CASE WHEN needs_you > 0 THEN 0 ELSE 3 END) WHEN status = 'extraction_failed' THEN 1 WHEN status = 'setting_up' THEN 2 WHEN status = 'extracting' THEN 4 ELSE 5 END`,
      ),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("studies_list_idx").on(t.stage, listKey, t.id), index("studies_site_idx").on(t.siteName)],
);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: text("sha256").notNull().unique(),
  filename: text("filename").notNull(),
  kind: text("kind").notNull().default("other"),
  pageCount: integer("page_count").notNull(),
  storagePath: text("storage_path").notNull(),
  /** From the PDF's own text at upload: "text" when any page has a real text layer, else "scan"; null = not known. */
  textSource: text("text_source").$type<"text" | "scan">(),
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
    /** Evidence ledger, one status per money value (ADR-001). */
    evidence: jsonb("evidence").$type<ValueEvidence[]>().notNull().default([]),
    /** What a person answers before approval. Values with an open question are withheld from responses (versionDto). */
    review: jsonb("review").$type<ReviewItem[]>().notNull().default([]),
    /** Money values checked against the PDF's own text; null for a scan. */
    pdfCheck: jsonb("pdf_check").$type<{ values: number; matched: number }>(),
    byHand: boolean("by_hand").notNull().default(false),
    /** "Looks right" marks; the one column a signed version still takes (see the immutability trigger). */
    proofread: jsonb("proofread").$type<ProofreadMark[]>().notNull().default([]),
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

/** A contract reached a step where someone is needed (see AlertDto); raised by refreshStudyStatus. Everyone sees every alert. */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<AlertKind>().notNull(),
    studyId: uuid("study_id").notNull().references(() => studies.id),
    version: integer("version").notNull(),
    by: text("by").notNull(),
    count: integer("count"),
    note: text("note"),
    createdAt: ts("created_at"),
  },
  // NULLS FIRST, as ORDER BY … DESC means: with drizzle-kit's default NULLS LAST the planner won't use it for that order
  (t) => [index("alerts_list_idx").on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())],
);

/** Read state per person (the name they picked). An alert is also read for whoever caused it, without a row. */
export const alertReads = pgTable(
  "alert_reads",
  {
    alertId: uuid("alert_id").notNull().references(() => alerts.id),
    person: text("person").notNull(),
  },
  (t) => [primaryKey({ columns: [t.alertId, t.person] })],
);

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
