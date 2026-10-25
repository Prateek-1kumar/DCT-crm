import type {
  ContractAnomaly,
  DocumentDto,
  DocumentKind,
  Rulebook,
  Resolution,
  RulebookVersionDto,
  StudyStatus,
  StudySummaryDto,
  VersionStatus,
  VersionSummaryDto,
} from "@dct/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "./db/index.js";
import { auditLog, documents, rulebookVersions, studies } from "./db/schema.js";
import type { CheckOptions, ExtractionPort } from "./extraction/port.js";
import { HttpError, notFound } from "./lib/http.js";

type DocumentRow = typeof documents.$inferSelect;
type VersionRow = typeof rulebookVersions.$inferSelect;
type StudyRow = typeof studies.$inferSelect;

export function audit(tx: Tx, by: string, studyId: string | null, action: string, detail: Record<string, unknown> = {}) {
  return tx.insert(auditLog).values({ by, studyId, action, detail });
}

export const documentDto = (d: DocumentRow, duplicateOf: string | null = null): DocumentDto => ({
  id: d.id,
  filename: d.filename,
  sha256: d.sha256,
  kind: d.kind as DocumentKind,
  pageCount: d.pageCount,
  uploadedAt: d.uploadedAt.toISOString(),
  duplicateOf,
});

export const versionSummaryDto = (v: VersionRow): VersionSummaryDto => ({
  version: v.version,
  status: v.status as VersionStatus,
  createdAt: v.createdAt.toISOString(),
  signedBy: v.signedBy,
  signedAt: v.signedAt?.toISOString() ?? null,
  appliesFrom: v.appliesFrom,
});

export const versionDto = (v: VersionRow): RulebookVersionDto => ({
  ...versionSummaryDto(v),
  studyId: v.studyId,
  rulebook: v.rulebook,
  anomalies: v.anomalies,
  editors: v.editors,
  cost: { usd: v.costUsd, inputTokens: v.inputTokens, outputTokens: v.outputTokens },
});

/** `versions` newest first. */
export function studySummaryDto(s: StudyRow, versions: VersionRow[]): StudySummaryDto {
  const latest = versions[0];
  return {
    id: s.id,
    sponsor: s.sponsor,
    protocol: s.protocol,
    siteName: s.siteName,
    investigator: s.investigator,
    status: s.status as StudyStatus,
    liveVersion: versions.find((v) => v.status === "signed")?.version ?? null,
    openAnomalies: latest?.status === "draft" ? latest.anomalies.filter((a) => !a.resolution).length : 0,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * Study status is derived from its versions, so it can't drift:
 * none → setting_up; latest extracting/failed/draft → extracting/extraction_failed/needs_review,
 * or amendment_in_review while an earlier version is live; latest signed → live.
 */
export async function refreshStudyStatus(tx: Tx, studyId: string): Promise<StudyStatus> {
  const versions = await tx.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, studyId)).orderBy(desc(rulebookVersions.version));
  const latest = versions[0];
  const hasLive = versions.some((v) => v.status === "signed");
  let status: StudyStatus;
  if (!latest) status = "setting_up";
  else if (latest.status === "signed") status = "live";
  else if (hasLive) status = "amendment_in_review";
  else status = ({ extracting: "extracting", failed: "extraction_failed", draft: "needs_review" } as const)[latest.status as "extracting" | "failed" | "draft"] ?? "needs_review";
  await tx.update(studies).set({ status, updatedAt: new Date() }).where(eq(studies.id, studyId));
  return status;
}

export async function loadVersion(tx: Tx, studyId: string, version: number, forUpdate = false): Promise<VersionRow> {
  const q = tx.select().from(rulebookVersions).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, version)));
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) throw notFound(`Version ${version} of study ${studyId}`);
  return row;
}

/** Only drafts can change. Signed versions are immutable. */
export function assertDraft(v: VersionRow): asserts v is VersionRow & { rulebook: Rulebook } {
  if (v.status === "signed" || v.status === "superseded")
    throw new HttpError(409, `Version ${v.version} is ${v.status} and immutable; changes need a new version (amendment)`);
  if (v.status !== "draft" || !v.rulebook) throw new HttpError(409, `Version ${v.version} is ${v.status}; only draft versions can be changed`);
}

/**
 * Re-run contract checks; anomalies whose id still exists keep their resolution.
 * An anomaly the change made disappear stays in the list, settled by this change (`settledBy`),
 * so the review keeps its record and a follow-up resolve call doesn't 404.
 */
export function recheck(
  port: ExtractionPort,
  rulebook: Rulebook,
  row: { crossRead: Rulebook | null; pages: CheckOptions["pages"]; notes: CheckOptions["notes"]; anomalies: ContractAnomaly[] },
  settledBy: Omit<Resolution, "at">,
): ContractAnomaly[] {
  const resolved = new Map(row.anomalies.map((a) => [a.id, a.resolution]));
  const fresh = port.runContractChecks(rulebook, { crossRead: row.crossRead, pages: row.pages, notes: row.notes }).map((a) => ({ ...a, resolution: resolved.get(a.id) ?? a.resolution ?? null }));
  const at = new Date().toISOString();
  const gone = row.anomalies.filter((a) => !fresh.some((f) => f.id === a.id)).map((a) => ({ ...a, resolution: a.resolution ?? { ...settledBy, at } }));
  return [...fresh, ...gone];
}

/** Date the version's terms apply from: amendment date, else the contract's effective date. */
export const appliesFromOf = (rb: Rulebook) => rb.appliesFrom.value ?? rb.study.effectiveDate.value;
