import { z } from "zod";
import { ContractAnomaly } from "./anomaly";
import { Person, ProofreadMark, ReviewItem, settled, ValueEvidence } from "./evidence";
import { actionLabel } from "./labels";
import { alsoWithheld } from "./questions";
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

/**
 * Blind entry: on a draft, the value at each open review question's path is withheld from every response until it is
 * answered (the API's versionDto, search, diff and audit), with the values its answer decides the meaning of
 * (alsoWithheld). The web masks the same paths.
 */
export const withheldPaths = (v: { status: string; review: ReviewItem[] }): string[] =>
  v.status === "draft" ? [...new Set(v.review.flatMap((i) => (i.path && !settled(i) ? [i.path, ...alsoWithheld(i.path)] : [])))] : [];

/** `appliesFrom` as a response shows it: the start date, or the effective date it falls back to, withheld while either is asked blind. */
export const shownAppliesFrom = (v: { status: string; review: ReviewItem[]; appliesFrom: string | null }) =>
  withheldPaths(v).some((p) => p === "/appliesFrom/value" || p === "/study/effectiveDate/value") ? null : v.appliesFrom;

const pointer = (path: PropertyKey[]) => path.map((k) => `/${String(k).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");

export const RulebookVersionDto = VersionSummaryDto.extend({
  studyId: z.string(),
  /**
   * A valid Rulebook, except that on a draft each withheld value (withheldPaths) is null, whatever its type, until its
   * question is answered; its evidence's `printed` is null too. Checked below: nothing else may be null or invalid.
   */
  rulebook: z.custom<Rulebook>((v) => typeof v === "object" && v !== null).nullable(),
  /** What the contract checks found; empty on a draft while any value is withheld (their messages carry the reading). */
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
  /** When anything in it last changed: approval sends it back (SignOffBody.asOf), so nobody approves what they didn't see. */
  updatedAt: z.string(),
  /** What made the reading weaker than usual (a budget grid read only once, say), in plain words; empty when nothing did. */
  warnings: z.array(z.string()),
}).superRefine((v, ctx) => {
  if (!v.rulebook) return;
  const r = Rulebook.safeParse(v.rulebook);
  if (r.success) return;
  const withheld = new Set(withheldPaths(v));
  const valueAt = (path: PropertyKey[]) => path.reduce<unknown>((n, k) => (n !== null && typeof n === "object" ? (n as Record<PropertyKey, unknown>)[k] : undefined), v.rulebook);
  for (const i of r.error.issues) if (!(withheld.has(pointer(i.path)) && valueAt(i.path) === null)) ctx.addIssue({ code: "custom", message: i.message, path: ["rulebook", ...i.path] });
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
  /** Withheld values left out and notes about them blanked (blankNumbers) while their question is open. */
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

/**
 * GET /audit?studyId=&q=&cursor=&limit=: one page of the log, newest first. `q` matches the person, the action (its
 * code or what it's called, ACTION_LABELS) or any text or number in the details, every word, case-insensitive; never
 * what's withheld or blanked. `cursor` is opaque.
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
  by: z.string().trim(),
});
export const SetDocumentKindBody = z.object({ kind: DocumentKind, by: z.string().trim() });
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

/** PATCH /settings — any subset of SettingsDto. */
export const PatchSettingsBody = SettingsDto.partial().extend({ by: Person.optional() });
