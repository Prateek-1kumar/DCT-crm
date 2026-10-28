import {
  type ContractAnomaly,
  type DocumentDto,
  type DocumentKind,
  type Resolution,
  Rulebook,
  type RulebookVersionDto,
  type StudyStatus,
  type StudySummaryDto,
  type VersionStatus,
  type VersionSummaryDto,
} from "@dct/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { Tx } from "./db/index.js";
import { auditLog, documents, rulebookVersions, studies } from "./db/schema.js";
import type { CheckOptions, ExtractionPort } from "./extraction/port.js";
import { itemIds } from "./lib/diff.js";
import { HttpError, notFound } from "./lib/http.js";
import { getAt, markManual, parsePointer, setAt } from "./lib/pointer.js";

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
  // ponytail: not detected at upload yet; needs a documents column filled by readTextLayer (ADR-001 step 5).
  text: null,
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
  // Filled once the evidence pipeline is wired (ADR-001 build steps 2–5).
  evidence: [],
  review: [],
  pdfCheck: null,
  byHand: false,
  proofread: [],
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
    // Until review items are wired (ADR-001 step 5), open anomalies are what needs a person.
    needsYou: latest?.status === "draft" ? latest.anomalies.filter((a) => !a.resolution).length : 0,
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

/**
 * Starting point for manual entry. Amendment: a copy of the live rulebook (only what changes needs
 * editing; appliesFrom is cleared so it must be entered). Otherwise a valid blank rulebook, every
 * value tagged manual, prefilled with the confirmed study details.
 */
export function manualRulebook(s: StudyRow, docs: DocumentRow[], live: Rulebook | null): Rulebook {
  const prov = { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } as const;
  const m = <T>(value: T) => ({ value, prov });
  const documentList = docs.map((d) => ({ id: d.id, kind: d.kind as DocumentKind, title: d.filename, date: null }));
  if (live) return Rulebook.parse({ ...structuredClone(live), documents: documentList, appliesFrom: m(null) });
  return Rulebook.parse({
    schemaVersion: 1,
    study: {
      sponsor: m(s.sponsor ?? ""),
      payingAgent: m(null),
      protocol: m(s.protocol ?? ""),
      siteName: m(s.siteName ?? ""),
      investigator: m(s.investigator ?? ""),
      effectiveDate: m(null),
      currency: "USD",
    },
    documents: documentList,
    referencedDocuments: [],
    overhead: { pct: m(null), appliesTo: m("unspecified") },
    payment: {
      visitPayment: m("unspecified"),
      frequency: m("unspecified"),
      netDays: m(null),
      netDaysFrom: m(null),
      invoiceAddress: m(null),
      requiredReferences: m([]),
      paymentConditions: m([]),
    },
    budgetGrids: [],
    governingGridId: null,
    invoiceables: [],
    screenFail: null,
    siteFees: [],
    holdback: null,
    deadlines: [],
    overpayment: null,
    rounding: m("unspecified"),
    appliesFrom: m(null),
  });
}

// ---- Amendment drafts: carry the live version's corrections forward ----

/** One value correction. `items`: identities of the array items its path passes through (see itemIds). */
export type Correction = { path: string; before: unknown; after: unknown; note?: string; by?: string; items?: string[] };
export type SkipReason = "amendment_changed" | "item_moved" | "path_missing" | "invalid" | "already_equal";
export const CARRIED = "version.corrections_carried";

/**
 * Every correction that makes version `v`'s values differ from the AI read, oldest first, replayed
 * from the audit log: what `v` carried at extraction (`version.corrections_carried`), what a manual
 * draft inherited by copying its live version (`version.manual_created` → recurse), and its own
 * `value.corrected` entries.
 */
export async function correctionsOf(tx: Tx, v: { studyId: string; version: number }): Promise<Correction[]> {
  const rows = await tx
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.studyId, v.studyId),
        inArray(auditLog.action, ["value.corrected", CARRIED, "version.manual_created"]),
        sql`${auditLog.detail}->>'version' = ${String(v.version)}`,
      ),
    )
    .orderBy(auditLog.id);
  const out: Correction[] = [];
  for (const { action, by, detail: d } of rows) {
    if (action === CARRIED) out.push(...(d.carried as Correction[]));
    else if (action === "version.manual_created") {
      if (typeof d.seededFromVersion === "number") out.push(...(await correctionsOf(tx, { studyId: v.studyId, version: d.seededFromVersion })));
    } else out.push({ path: d.path as string, before: d.before, after: d.after, note: d.note as string, by, items: d.items as string[] | undefined });
  }
  return out;
}

/**
 * Replay corrections onto a fresh AI read. A correction applies only where the new read still has the
 * value it corrected (`before`) on the same items; anything else is the amendment's to decide.
 */
export function carryCorrections(rulebook: Rulebook, corrections: Correction[]) {
  let rb = structuredClone(rulebook);
  const carried: Correction[] = [];
  const skipped: (Correction & { reason: SkipReason })[] = [];
  const skip = (c: Correction, reason: SkipReason) => skipped.push({ ...c, reason });
  for (const c of corrections) {
    try {
      const tokens = parsePointer(c.path);
      const found = getAt(rb, tokens);
      const now = found ?? null;
      // ponytail: entries logged before `items` existed are guarded by the value check only
      if (c.items && !isDeepStrictEqual(itemIds(rb, tokens), c.items)) skip(c, "item_moved");
      else if (found === undefined && c.before !== null) skip(c, "path_missing");
      else if (isDeepStrictEqual(now, c.after)) skip(c, "already_equal");
      else if (!isDeepStrictEqual(now, c.before)) skip(c, "amendment_changed");
      else {
        const next = structuredClone(rb);
        setAt(next, tokens, structuredClone(c.after));
        markManual(next, tokens);
        const ok = Rulebook.safeParse(next);
        if (!ok.success) skip(c, "invalid");
        else {
          rb = ok.data;
          carried.push(c);
        }
      }
    } catch {
      skip(c, "path_missing"); // the path no longer fits the new read's shape
    }
  }
  return { rulebook: rb, carried, skipped };
}

/** The live version's governing grid, found in the new read by label and arm. */
export function carryGrid(rulebook: Rulebook, live: Rulebook): string | null {
  const chosen = live.budgetGrids.find((g) => g.id === live.governingGridId);
  return chosen ? (rulebook.budgetGrids.find((g) => g.label === chosen.label && g.arm === chosen.arm)?.id ?? null) : null;
}

/** Copy the resolution of every live anomaly found again unchanged (same id, deep-equal detail). */
export function carryResolutions(anomalies: ContractAnomaly[], live: { version: number; anomalies: ContractAnomaly[] }) {
  const carried: { anomalyId: string; code: string; kind: Resolution["kind"] }[] = [];
  const out = anomalies.map((a) => {
    const old = live.anomalies.find((o) => o.id === a.id && isDeepStrictEqual(o.detail, a.detail))?.resolution;
    if (!old || a.resolution) return a;
    carried.push({ anomalyId: a.id, code: a.code, kind: old.kind });
    return { ...a, resolution: { ...old, note: `Carried from v${live.version}: ${old.note.replace(/^Carried from v\d+: /, "")}` } };
  });
  return { anomalies: out, carried };
}
