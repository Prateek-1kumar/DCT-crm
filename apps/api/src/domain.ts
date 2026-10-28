import {
  type AlertKind,
  type DocumentDto,
  type DocumentKind,
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
import { alerts, auditLog, documents, rulebookVersions, studies } from "./db/schema.js";
import { itemIds } from "./lib/diff.js";
import { HttpError, notFound } from "./lib/http.js";
import { getAt, markManual, parsePointer, setAt } from "./lib/pointer.js";
import { blindReview, hiddenPaths, mask, needsYouOf } from "./review.js";

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
  text: d.textSource,
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

/**
 * Blind entry: on a draft, a value with an open question is withheld (null) from the master, its printed text from the
 * evidence, and the checks' anomalies (their messages and details carry the reading) until nothing is withheld.
 * Every response that carries a version goes through here.
 */
export const versionDto = (v: VersionRow): RulebookVersionDto => {
  const hidden = hiddenPaths(v);
  return {
    ...versionSummaryDto(v),
    studyId: v.studyId,
    rulebook: v.rulebook && hidden.length ? mask(v.rulebook, hidden) : v.rulebook,
    anomalies: hidden.length ? [] : v.anomalies,
    editors: v.editors,
    cost: { usd: v.costUsd, inputTokens: v.inputTokens, outputTokens: v.outputTokens },
    evidence: v.evidence.map((e) => (hidden.includes(e.path) ? { ...e, printed: null } : e)),
    review: blindReview(v.review, hidden),
    pdfCheck: v.pdfCheck,
    byHand: v.byHand,
    proofread: v.proofread,
  };
};

/** From the study row alone (needs_you is kept by refreshStudyStatus), so lists never load a rulebook. */
export function studySummaryDto(s: StudyRow, liveVersion: number | null): StudySummaryDto {
  return {
    id: s.id,
    sponsor: s.sponsor,
    protocol: s.protocol,
    siteName: s.siteName,
    investigator: s.investigator,
    status: s.status as StudyStatus,
    liveVersion,
    // ponytail: until review items are wired (ADR-001 step 5) the two are the same count; give openAnomalies its own column then.
    openAnomalies: s.needsYou,
    needsYou: s.needsYou,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Status changes raise theirs in refreshStudyStatus; sent_back is raised by the send-back write (which passes alert: false). */
export function raiseAlert(tx: Tx, a: typeof alerts.$inferInsert) {
  return tx.insert(alerts).values(a);
}

/**
 * Study status is derived from its versions, so it can't drift:
 * none → setting_up; latest extracting/failed/draft → extracting/extraction_failed/needs_review,
 * or amendment_in_review while an earlier version is live; latest signed → live.
 * Also stores needs_you, what the web counts as needing a person on the latest draft (see needsYouOf); the list's
 * `stage` is generated from both. Every write that changes a version calls this.
 * A stage change into needs you, waiting for approval (after reading or answering) or couldn't read raises an alert,
 * `by` whoever caused it, unless the write raises its own (`alert: false`).
 */
export async function refreshStudyStatus(tx: Tx, studyId: string, by = "system", { alert = true } = {}): Promise<StudyStatus> {
  const [before] = await tx.select({ stage: studies.stage }).from(studies).where(eq(studies.id, studyId)).for("no key update");
  const versions = await tx.select().from(rulebookVersions).where(eq(rulebookVersions.studyId, studyId)).orderBy(desc(rulebookVersions.version));
  const latest = versions[0];
  const hasLive = versions.some((v) => v.status === "signed");
  let status: StudyStatus;
  if (!latest) status = "setting_up";
  else if (latest.status === "signed") status = "live";
  else if (hasLive) status = "amendment_in_review";
  else status = ({ extracting: "extracting", failed: "extraction_failed", draft: "needs_review" } as const)[latest.status as "extracting" | "failed" | "draft"] ?? "needs_review";
  const needsYou = needsYouOf(latest);
  const [after] = await tx.update(studies).set({ status, needsYou, updatedAt: new Date() }).where(eq(studies.id, studyId)).returning({ stage: studies.stage });
  const from = before?.stage;
  const kind: AlertKind | null =
    !after || after.stage === from ? null
    : after.stage === 0 ? "questions_ready"
    : after.stage === 3 ? "ready_for_approval"
    : after.stage === 1 ? "couldnt_read"
    : null;
  if (kind && latest && alert) await raiseAlert(tx, { kind, studyId, version: latest.version, by, count: kind === "questions_ready" ? needsYou : null });
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

/** Date the version's terms apply from: amendment date, else the contract's effective date. */
export const appliesFromOf = (rb: Rulebook) => rb.appliesFrom.value ?? rb.study.effectiveDate.value;

const MANUAL = { source: null, confidence: 1, method: "manual", crossCheck: "not_checked" } as const;

/**
 * Starting point for typing a contract in by hand (as apps/web/src/lib/byhand.ts blankRulebook): every value empty and
 * tagged manual, prefilled with the confirmed study details, with one empty budget grid for the form to fill.
 */
export function manualRulebook(s: StudyRow, docs: DocumentRow[]): Rulebook {
  const m = <T>(value: T) => ({ value, prov: MANUAL });
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
    documents: docs.map((d) => ({ id: d.id, kind: d.kind as DocumentKind, title: d.filename, date: null })),
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
    budgetGrids: [
      {
        id: "g-hand",
        label: "Budget",
        arm: null,
        statedOverheadPct: null,
        visits: [{ code: "V1", name: "", order: 1, procedureSubtotalCents: null, overheadCents: null, nonProcedureCents: null, totalCents: 0, autopay: true, prov: MANUAL }],
        procedures: [{ code: null, name: "", unitCents: null, overheadApplied: false, category: "procedure", cells: {}, prov: MANUAL }],
        perPatientTotals: [],
        header: { investigator: null, siteName: null },
        prov: MANUAL,
      },
    ],
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
/** "This looks wrong" on the live version: a draft copied from it. */
export const CORRECTION_OPENED = "version.correction_opened";

/**
 * Every correction that makes version `v`'s values differ from the AI read, oldest first, replayed
 * from the audit log: what `v` carried at extraction (`version.corrections_carried`), what a draft
 * inherited by copying its live version (`version.manual_created` or `version.correction_opened` with
 * `seededFromVersion` → recurse), its answers that wrote a value (`review.answered` / `review.changed`
 * with `after`), and `value.corrected` entries from before review questions existed.
 */
export async function correctionsOf(tx: Tx, v: { studyId: string; version: number }): Promise<Correction[]> {
  const rows = await tx
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.studyId, v.studyId),
        inArray(auditLog.action, ["value.corrected", "review.answered", "review.changed", CARRIED, "version.manual_created", CORRECTION_OPENED]),
        sql`${auditLog.detail}->>'version' = ${String(v.version)}`,
      ),
    )
    .orderBy(auditLog.id);
  const out: Correction[] = [];
  for (const { action, by, detail: d } of rows) {
    if (action === CARRIED) out.push(...(d.carried as Correction[]));
    else if (action === "version.manual_created" || action === CORRECTION_OPENED) {
      if (typeof d.seededFromVersion === "number") out.push(...(await correctionsOf(tx, { studyId: v.studyId, version: d.seededFromVersion })));
    } else if ("after" in d) out.push({ path: d.path as string, before: d.before, after: d.after, note: d.note as string | undefined, by, items: d.items as string[] | undefined });
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
