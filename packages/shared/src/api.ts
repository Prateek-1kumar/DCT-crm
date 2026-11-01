import { z } from "zod";
import { ContractAnomaly } from "./anomaly";
import { Person, ProofreadMark, ReviewItem, settled, ValueEvidence } from "./evidence";
import { actionLabel } from "./labels";
import { decidedBy } from "./questions";
import { DocumentKind, Rulebook } from "./rulebook";

/** HTTP contract between apps/api and apps/web. All routes are under /api/v1. */

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
  /** Unsettled review items on the latest draft: unanswered, differs, or can't tell (openItems): approval waits for every one. */
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

/**
 * The values an open question on a draft is about, or decides (decidedBy: a cap's limit while its kind is asked, say),
 * and every value held for its table's columns or its blank check (`held`, `blank`). Shown, and marked as waiting for an
 * answer: nothing is withheld (ADR-003). "This looks wrong" refuses one of them (it's asked already).
 */
export const openPaths = (v: { status: string; review: ReviewItem[]; evidence: { path: string; held?: string; blank?: string }[]; rulebook?: unknown }): string[] =>
  v.status === "draft"
    ? [...new Set([...v.review.flatMap((i) => (i.path && !settled(i) ? [i.path] : [])), ...v.evidence.flatMap((e) => (e.held || e.blank ? [e.path] : []))].flatMap((p) => [p, ...decidedBy(p, v.rulebook)]))]
    : [];

export const RulebookVersionDto = VersionSummaryDto.extend({
  studyId: z.string(),
  /** A valid Rulebook (checked below). */
  rulebook: z.custom<Rulebook>((v) => typeof v === "object" && v !== null).nullable(),
  /** What the contract checks found. */
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
  /** When typing by hand was marked done (by-hand/done); null while it's still being typed, and on a version read from the PDF. */
  typingDoneAt: z.string().nullable(),
  /** Values someone proofread and found right (one mark per value, the latest). */
  proofread: z.array(ProofreadMark),
  /** When anything in it last changed: approval sends it back (SignOffBody.asOf), so nobody approves what they didn't see. */
  updatedAt: z.string(),
  /** What made the reading weaker than usual (a budget grid read only once, say), in plain words; empty when nothing did. */
  warnings: z.array(z.string()),
}).superRefine((v, ctx) => {
  if (!v.rulebook) return;
  const r = Rulebook.safeParse(v.rulebook);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: ["rulebook", ...i.path] });
});
export type RulebookVersionDto = z.infer<typeof RulebookVersionDto>;

export const JobDto = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  /** 0–100. */
  progress: z.number(),
  step: z.string(),
  /** Why it failed, in plain words for people. */
  error: z.string().nullable(),
  /** The technical reason, for the team ("Details for the team"); null when the plain words say it all. */
  detail: z.string().nullable().optional(),
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
  /** The contract's, for the Contract column; null when the entry isn't about one. */
  protocol: z.string().nullable(),
  sponsor: z.string().nullable(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

/**
 * GET /audit?studyId=&q=&cursor=&limit=: one page of the log, newest first. `q` matches the person, the action (its
 * code or what it's called, ACTION_LABELS) or any text or number in the details, every word, case-insensitive; nothing
 * is withheld (ADR-003). `cursor` is opaque.
 */
export const AuditListQuery = z.object({
  studyId: z.string().min(1).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditListQuery = Partial<z.infer<typeof AuditListQuery>>;

export const AuditPage = z.object({ items: z.array(AuditEntryDto), nextCursor: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;

/** Every text and number in an entry's details, keys left out: what `q` is matched against (the API's SQL reads the same). */
export function detailText(detail: unknown): string[] {
  if (typeof detail === "string") return [detail];
  if (typeof detail === "number") return [String(detail)];
  if (detail === null || typeof detail !== "object") return [];
  return Object.values(detail).flatMap(detailText);
}

/** Whether an entry, as it's shown, matches every word of `q`. */
export function auditMatches(e: Pick<AuditEntryDto, "by" | "action" | "detail">, q: string): boolean {
  const hay = [e.by, e.action, actionLabel(e.action), ...detailText(e.detail)].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// ---- Request bodies ----

export const CreateStudyBody = z.object({ documentIds: z.array(z.string()).min(1).max(50), by: Person.optional() });
/** POST /studies/:id/extract — documentIds adds documents (amendment journey). */
export const ExtractBody = z.object({ documentIds: z.array(z.string()).max(50).optional(), by: Person.optional() });
export const ConfirmStudyBody = z.object({
  sponsor: z.string(),
  protocol: z.string(),
  siteName: z.string(),
  investigator: z.string(),
  by: Person,
});
export const SetDocumentKindBody = z.object({ kind: DocumentKind, by: Person });
export const CorrectValueBody = z.object({ path: z.string(), value: z.unknown(), note: z.string().min(1), by: Person });
/**
 * `asOf`: the version's `updatedAt` as the approver saw it. If anything changed since (an answer in another tab), approval
 * is refused, so nobody approves values they didn't see.
 */
export const SignOffBody = z.object({ by: Person, note: z.string().optional(), asOf: z.string().min(1) });
export type SignOffBody = z.infer<typeof SignOffBody>;
export const SettingsDto = z.object({
  /** When on, nobody who answered questions or typed values on a version can approve it. On by default (ADR-001 §10). */
  makerChecker: z.boolean(),
  people: z.array(z.string()),
});
export type SettingsDto = z.infer<typeof SettingsDto>;

/** PATCH /settings — any subset of SettingsDto, plus who changed it. */
/** `by` is required: turning maker-checker off is logged under the name of whoever did it, never "system". */
export const PatchSettingsBody = SettingsDto.partial().extend({ by: Person });
