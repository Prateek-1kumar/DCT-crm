import { z } from "zod";
import { ContractAnomaly } from "./anomaly";
import { ProofreadMark, ReviewItem, ValueEvidence } from "./evidence";
import { DocumentKind, Rulebook } from "./rulebook";

/** HTTP contract between apps/api and apps/web. All routes are under /api. */

export const StudyStatus = z.enum(["setting_up", "extracting", "extraction_failed", "needs_review", "live", "amendment_in_review"]);
export type StudyStatus = z.infer<typeof StudyStatus>;

export const VersionStatus = z.enum(["extracting", "draft", "signed", "superseded", "failed"]);
export type VersionStatus = z.infer<typeof VersionStatus>;

export const DocumentDto = z.object({
  id: z.string(),
  filename: z.string(),
  sha256: z.string(),
  kind: DocumentKind,
  pageCount: z.number().int(),
  uploadedAt: z.string(),
  /** Set when the same file was already uploaded. */
  duplicateOf: z.string().nullable(),
  /** "text": born-digital, its numbers can be checked against its own text · "scan": images only · null: not known yet. */
  text: z.enum(["text", "scan"]).nullable(),
});
export type DocumentDto = z.infer<typeof DocumentDto>;

export const StudySummaryDto = z.object({
  id: z.string(),
  sponsor: z.string().nullable(),
  protocol: z.string().nullable(),
  siteName: z.string().nullable(),
  investigator: z.string().nullable(),
  status: StudyStatus,
  liveVersion: z.number().int().nullable(),
  openAnomalies: z.number().int(),
  /** Unsettled review items on the latest draft: unanswered, differs, or a blocking can't-tell (a non-blocking one waits for the approver). */
  needsYou: z.number().int(),
  updatedAt: z.string(),
});
export type StudySummaryDto = z.infer<typeof StudySummaryDto>;

export const VersionSummaryDto = z.object({
  version: z.number().int(),
  status: VersionStatus,
  createdAt: z.string(),
  signedBy: z.string().nullable(),
  signedAt: z.string().nullable(),
  appliesFrom: z.string().nullable(),
});
export type VersionSummaryDto = z.infer<typeof VersionSummaryDto>;

export const StudyDetailDto = StudySummaryDto.extend({
  documents: z.array(DocumentDto),
  versions: z.array(VersionSummaryDto),
});
export type StudyDetailDto = z.infer<typeof StudyDetailDto>;

export const RulebookVersionDto = VersionSummaryDto.extend({
  studyId: z.string(),
  rulebook: Rulebook.nullable(),
  anomalies: z.array(ContractAnomaly),
  /** Names of people who corrected values in this version (for the optional maker-checker rule). */
  editors: z.array(z.string()),
  cost: z.object({ usd: z.number(), inputTokens: z.number().int(), outputTokens: z.number().int() }),
  evidence: z.array(ValueEvidence),
  review: z.array(ReviewItem),
  /** Money values checked against the PDF's own text; null when the PDF has no text (a scan). */
  pdfCheck: z.object({ values: z.number().int(), matched: z.number().int() }).nullable(),
  /** Typed in by hand (contract couldn't be read): values are set with PATCH .../values, which only by-hand drafts accept. */
  byHand: z.boolean(),
  /** Values someone proofread and found right (one mark per value, the latest). */
  proofread: z.array(ProofreadMark),
});
export type RulebookVersionDto = z.infer<typeof RulebookVersionDto>;

export const JobDto = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  /** 0–100. */
  progress: z.number(),
  step: z.string(),
  error: z.string().nullable(),
});
export type JobDto = z.infer<typeof JobDto>;

export const DiffEntry = z.object({
  path: z.string(),
  change: z.enum(["added", "changed", "removed"]),
  before: z.unknown(),
  after: z.unknown(),
  label: z.string(),
});
export type DiffEntry = z.infer<typeof DiffEntry>;

export const AuditEntryDto = z.object({
  id: z.string(),
  at: z.string(),
  by: z.string(),
  studyId: z.string().nullable(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

// ---- Request bodies ----

export const CreateStudyBody = z.object({ documentIds: z.array(z.string()).min(1), by: z.string().min(1).optional() });
/** POST /studies/:id/extract — documentIds adds documents (amendment journey). */
export const ExtractBody = z.object({ documentIds: z.array(z.string()).optional(), by: z.string().min(1).optional() });
export const ConfirmStudyBody = z.object({
  sponsor: z.string(),
  protocol: z.string(),
  siteName: z.string(),
  investigator: z.string(),
  by: z.string(),
});
export const SetDocumentKindBody = z.object({ kind: DocumentKind, by: z.string() });
export const CorrectValueBody = z.object({ path: z.string(), value: z.unknown(), note: z.string().min(1), by: z.string().min(1) });
export const ResolveAnomalyBody = z.object({
  kind: z.enum(["fixed", "chosen", "accepted_with_note"]),
  note: z.string().min(1),
  by: z.string().min(1),
});
export const ChooseGridBody = z.object({ gridId: z.string(), note: z.string().min(1), by: z.string().min(1) });
export const SignOffBody = z.object({ by: z.string().min(1), note: z.string().optional() });
export const SettingsDto = z.object({
  /** When on, a person who corrected values in a version cannot sign it off. Off by default. */
  makerChecker: z.boolean(),
  people: z.array(z.string()),
});
export type SettingsDto = z.infer<typeof SettingsDto>;

/** PATCH /settings — any subset of SettingsDto. */
export const PatchSettingsBody = SettingsDto.partial().extend({ by: z.string().min(1).optional() });
