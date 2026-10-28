import {
  alsoWithheld,
  amendmentDate,
  AnswerReviewBody,
  blindDetail,
  capFollowUps,
  familyOf,
  PROSPECTIVE,
  SAMPLE,
  sampleMisses,
  sampleMissWords,
  blindReview,
  ByHandBody,
  leaf,
  ConfirmStudyBody,
  CorrectValueBody,
  mask,
  PatchSettingsBody,
  ProofreadBody,
  ReportValueBody,
  samePerson,
  SetDocumentKindBody,
  SendBackBody,
  SignOffBody,
  StudyListQuery,
  AlertListQuery,
  AuditListQuery,
  auditMatches,
  blankNumbers,
  ReadAlertsBody,
  upgradeRulebook,
  withheldPaths,
  type AlertDto,
  searchMaster,
  amountOf,
  type RateHit,
  type StudyView,
  Rulebook as RulebookSchema,
  settled,
  type AuditEntryDto,
  type DiffEntry,
  type DocumentDto,
  type DocumentKind,
  type JobDto,
  type ReviewItem,
  type Rulebook,
  type RulebookVersionDto,
  type SettingsDto,
  type StudyDetailDto,
  type Unclassified,
  type StudyStatus,
  type StudySummaryDto,
  type ValueEvidence,
} from "@dct/shared";
import { blankRulebook } from "../byhand";
import { labelFor } from "../format";
import { layoutPage } from "./layout";
import { getAt, segments, setAt } from "../pointer";
import { needsYou, parseAnswer, summaryStage, VIEWS } from "../review";
import {
  amendmentSpecs,
  amendRulebook,
  askAbout,
  buildDraft,
  cobaltSpecs,
  halcyonV1Specs,
  makeRulebook,
  meridianSpecs,
  newContractSpecs,
  northwindSpecs,
  PEOPLE,
  SEEDS,
  toItem,
  toSecret,
  UNCLEAR_OVERHEAD,
  type Draft,
  type Secret,
  type Spec,
} from "./fixtures";

/**
 * In-browser implementation of the HTTP API in docs/phase-1/api.md (NEXT_PUBLIC_API_MOCK=1).
 * State lives in memory and is mirrored to localStorage so reloads keep the demo going.
 */

type Study = { id: string; sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null; status: StudyStatus; updatedAt: string; documentIds: string[] };
type Job = { id: string; kind: "identify" | "extract"; studyId: string; version: number | null; startedAt: number; durationMs: number; fail: boolean; applied: boolean };
/** `secrets` is the "server side": right answers keyed `studyId/version/itemId`, never in a response. */
type Alert = Omit<AlertDto, "read" | "protocol" | "sponsor">;
type Entry = Omit<AuditEntryDto, "protocol" | "sponsor">;
type Db = {
  studies: Study[]; documents: DocumentDto[]; versions: RulebookVersionDto[]; jobs: Job[]; audit: Entry[]; settings: SettingsDto; secrets: Record<string, Secret>; seq: number;
  alerts: Alert[];
  /** person → ids of the alerts they've read */
  alertReads: Record<string, string[]>;
};

const KEY = "dct.mockdb.v7";
let db: Db | null = null;

const now = () => new Date().toISOString();
const daysAgo = (d: number, h = 0) => new Date(Date.now() - (d * 24 + h) * 3600_000).toISOString();
const fakeSha = (seed: string) => Array.from({ length: 64 }, (_, i) => ((seed.charCodeAt(i % seed.length) * (i + 7)) % 16).toString(16)).join("");

function load(): Db {
  if (db) return db;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (raw) return (db = JSON.parse(raw) as Db);
  } catch {
    /* corrupt or unavailable storage: reseed */
  }
  return (db = seed());
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage full/unavailable: keep in memory */
  }
}

export function mockReset() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  db = seed();
}

// ---------------------------------------------------------------- seed

/** Sample data has no real PDFs: a file named like a scan is treated as one (the same rule the sample reading uses). */
const textOf = (filename: string): DocumentDto["text"] => (/scan/i.test(filename) ? "scan" : "text");

function seed(): Db {
  // maker-checker is on unless someone turns it off (ADR-001 §10)
  const d: Db = { studies: [], documents: [], versions: [], jobs: [], audit: [], settings: { makerChecker: true, people: [...PEOPLE] }, secrets: {}, seq: 100, alerts: [], alertReads: {} };
  const kinds: Record<string, DocumentKind> = { "doc-hal-am1": "amendment", "doc-sl-wo": "work_order" };

  for (const sd of Object.values(SEEDS)) {
    for (const [id, [filename, pageCount]] of Object.entries(sd.files)) {
      const kind = kinds[id] ?? sd.cfg?.docs.find((x) => x.id === id)?.kind ?? "other";
      d.documents.push({ id, filename, sha256: fakeSha(id), kind, pageCount, uploadedAt: daysAgo(30), duplicateOf: null, text: textOf(filename) });
    }
  }
  const study = (id: string, c: { sponsor: string; protocol: string; site: string; pi: string }, status: StudyStatus, docs: string[], updatedAt: string): Study => {
    const st: Study = { id, sponsor: c.sponsor, protocol: c.protocol, siteName: c.site, investigator: c.pi, status, updatedAt, documentIds: docs };
    d.studies.push(st);
    return st;
  };
  const version = (st: Study, v: number, dr: Draft | null, createdAt: string, status: RulebookVersionDto["status"] = "draft") => {
    const ver = newVersion(st.id, v, status, createdAt);
    if (dr) setDraft(d, ver, dr);
    d.versions.push(ver);
    return ver;
  };
  const sign = (st: Study, ver: RulebookVersionDto, by: string, at: string) => {
    Object.assign(ver, { status: "signed", signedBy: by, signedAt: at, appliesFrom: ver.rulebook?.appliesFrom.value ?? null });
    log(d, by, st.id, "version.signed", { version: ver.version }, at);
  };
  const say = (st: Study, ver: RulebookVersionDto, id: string, body: Record<string, unknown>, at: string) => answer(d, st, ver, id, body, at);
  /** Every question still open answered as the page shows it: its option, or the value it prints. */
  const sayRest = (st: Study, ver: RulebookVersionDto, by: string, at: string) => {
    for (const i of [...ver.review]) {
      if (settled(i)) continue;
      const truth = d.secrets[`${st.id}/${ver.version}/${i.id}`]?.truth ?? (i.path ? getAt(ver.rulebook, i.path) : undefined);
      const option = i.options.find((o) => o.id === String(truth)) ?? (i.input ? undefined : i.options[0]);
      const body = option ? { optionId: option.id, ...(option.note ? { note: "Checked against the page" } : {}) } : { value: truth };
      say(st, ver, i.id, { ...body, by }, at);
      if (ver.review.find((x) => x.id === i.id)?.outcome === "differs") say(st, ver, i.id, { ...body, note: "Checked against the page", by }, at);
    }
  };

  // Halcyon: live v1, and an amendment v2 with every question answered, waiting for approval.
  {
    const sd = SEEDS.halcyon;
    const st = study(sd.id, sd.cfg!, "amendment_in_review", ["doc-hal-cta", "doc-hal-am1"], daysAgo(1));
    log(d, "Avery Chen", st.id, "study.created", { documents: 1 }, daysAgo(44));
    const v1 = version(st, 1, buildDraft(makeRulebook(sd.cfg!), halcyonV1Specs()), daysAgo(44));
    say(st, v1, "h2", { optionId: "invoiceable", by: "Avery Chen" }, daysAgo(41));
    sayRest(st, v1, "Avery Chen", daysAgo(41));
    sign(st, v1, "Avery Chen", daysAgo(40));
    const am = amendRulebook(v1.rulebook!, { id: "doc-hal-am1", kind: "amendment", title: "Amendment 1 to CTA HAL-2207", date: "2026-09-30" });
    const v2 = version(st, 2, buildDraft(am, amendmentSpecs("doc-hal-am1", am.invoiceables.length - 1, am.budgetGrids[0]!.visits[5]!.totalCents), { amendment: true, retroactive: true }), daysAgo(2));
    log(d, "Taylor Brooks", st.id, "amendment.uploaded", { file: "HAL-2207_Amendment-1.pdf", version: 2 }, daysAgo(2));
    say(st, v2, "interpret:/appliesFrom/value", { value: "2026-09-01", by: "Taylor Brooks" }, daysAgo(1));
    say(st, v2, "a2", { value: 42000, by: "Taylor Brooks" }, daysAgo(1));
    say(st, v2, "a4", { optionId: "bill_by_hand", by: "Taylor Brooks" }, daysAgo(1));
    say(st, v2, "a5", { optionId: "printed", note: "Asked Crestline why Week 52 prints $5.00 under its lines", by: "Taylor Brooks" }, daysAgo(1));
    sayRest(st, v2, "Taylor Brooks", daysAgo(1));
  }

  // Northwind: a text PDF in "Needs you".
  {
    const sd = SEEDS.northwind;
    const st = study(sd.id, sd.cfg!, "needs_review", ["doc-nw-wo", "doc-nw-bud"], daysAgo(6));
    version(st, 1, buildDraft(makeRulebook(sd.cfg!), northwindSpecs(), { unclear: UNCLEAR_OVERHEAD }), daysAgo(6));
    log(d, "system", st.id, "extraction.succeeded", { version: 1 }, daysAgo(6));
  }

  // Cobalt: a scan, so every number outside the grids is typed by a person.
  {
    const sd = SEEDS.cobalt;
    const st = study(sd.id, sd.cfg!, "needs_review", ["doc-cb-cta"], daysAgo(3));
    version(st, 1, buildDraft(makeRulebook(sd.cfg!), cobaltSpecs(), { scan: true }), daysAgo(3));
    log(d, "system", st.id, "extraction.succeeded", { version: 1 }, daysAgo(3));
  }

  // Meridian: live.
  {
    const sd = SEEDS.meridian;
    const st = study(sd.id, sd.cfg!, "live", ["doc-mx-msa", "doc-mx-wo"], daysAgo(21));
    const v1 = version(st, 1, buildDraft(makeRulebook(sd.cfg!), meridianSpecs()), daysAgo(25));
    sayRest(st, v1, "Jordan Patel", daysAgo(22));
    sign(st, v1, "Sam Rivera", daysAgo(21));
  }

  // Solace: the scan couldn't be read.
  {
    const st = study(SEEDS.solace.id, { sponsor: "Solace Bio", protocol: "SLB-102", site: "DCT Lakeshore", pi: "Dr. Priya Raman" }, "extraction_failed", ["doc-sl-wo"], daysAgo(1));
    version(st, 1, null, daysAgo(1), "failed");
    d.jobs.push({ id: "job-solace-1", kind: "extract", studyId: st.id, version: 1, startedAt: Date.now() - 86_400_000, durationMs: 1000, fail: true, applied: true });
    log(d, "system", st.id, "extraction.failed", { version: 1, error: "Pages 3–7 couldn't be read: the scan is too faint." }, daysAgo(1));
  }

  // The alerts that got each contract where it is now.
  for (const st of d.studies) {
    const stage = stageOf(d, st);
    const answered = d.audit.filter((e) => e.studyId === st.id && e.action === "review.answered").at(-1)?.by ?? "system";
    const base = { studyId: st.id, version: latestVersion(d, st.id), count: null, note: null, at: st.updatedAt };
    if (stage === "needs") raiseAlert(d, { ...base, kind: "questions_ready", by: "system", count: summary(d, st).needsYou });
    if (stage === "approve") raiseAlert(d, { ...base, kind: "ready_for_approval", by: answered });
    if (stage === "failed") raiseAlert(d, { ...base, kind: "couldnt_read", by: "system" });
  }
  return d;
}

function newVersion(studyId: string, version: number, status: RulebookVersionDto["status"], createdAt = now()): RulebookVersionDto {
  return {
    studyId, version, status, createdAt, signedBy: null, signedAt: null, appliesFrom: null, rulebook: null, anomalies: [], editors: [],
    cost: { usd: 3.12, inputTokens: 201_300, outputTokens: 24_800 }, evidence: [], review: [], pdfCheck: null, byHand: false, proofread: [],
    updatedAt: createdAt, warnings: [],
  };
}

function setDraft(d: Db, ver: RulebookVersionDto, dr: Draft) {
  Object.assign(ver, { rulebook: dr.rulebook, review: dr.review, evidence: dr.evidence, pdfCheck: dr.pdfCheck, updatedAt: now() });
  for (const [id, sec] of Object.entries(dr.secrets)) d.secrets[`${ver.studyId}/${ver.version}/${id}`] = sec;
}

// ---------------------------------------------------------------- jobs

const EXTRACT_STEPS: [number, string][] = [
  [0, "Waiting to start"],
  [5, "Opening the PDFs"],
  [15, "Reading the contract terms"],
  [40, "Reading the budget grid"],
  [62, "Checking every number against the PDF"],
  [84, "Listing what needs you"],
  [100, "Done"],
];
const IDENTIFY_STEPS: [number, string][] = [
  [0, "Waiting to start"],
  [10, "Reading the cover pages"],
  [45, "Sorting the files"],
  [80, "Filling in the study details"],
  [100, "Done"],
];

function jobView(j: Job): JobDto {
  const p = Math.min(100, Math.floor(((Date.now() - j.startedAt) / j.durationMs) * 100));
  const failAt = 55;
  if (j.fail && p >= failAt)
    return { id: j.id, state: "failed", progress: failAt, step: "Reading the contract terms", error: "Pages 3–7 couldn't be read: the scan is too faint.", detail: "Sample data: pages 3–7 have no text layer and too little contrast to read." };
  const steps = j.kind === "extract" ? EXTRACT_STEPS : IDENTIFY_STEPS;
  const step = [...steps].reverse().find(([t]) => p >= t)![1];
  return { id: j.id, state: p >= 100 ? "succeeded" : p > 2 ? "running" : "queued", progress: p, step, error: null, detail: null };
}

/** Apply effects of finished jobs (called on every request). */
function tick(d: Db) {
  for (const j of d.jobs) {
    if (j.applied) continue;
    const v = jobView(j);
    if (v.state !== "succeeded" && v.state !== "failed") continue;
    j.applied = true;
    const st = d.studies.find((s) => s.id === j.studyId)!;
    const docs = d.documents.filter((x) => st.documentIds.includes(x.id));
    if (j.kind === "identify") {
      const proto = docs.map((x) => /[A-Z]{2,4}-\d{2,4}(-\d+)?/.exec(x.filename)?.[0]).find(Boolean);
      Object.assign(st, { sponsor: "Aster Biologics", protocol: proto ?? "AST-3301", siteName: "DCT Riverside", investigator: "Dr. Mara Ellison", status: "setting_up" as const, updatedAt: now() });
      continue;
    }
    const ver = d.versions.find((x) => x.studyId === st.id && x.version === j.version)!;
    const live = latestSigned(d, st.id);
    if (v.state === "failed") {
      // an amendment that couldn't be read shows as such, live version or not (as the real API)
      Object.assign(ver, { status: "failed", updatedAt: now() });
      st.status = "extraction_failed";
      st.updatedAt = now();
      log(d, "system", st.id, "extraction.failed", { version: ver.version, error: v.error });
      continue;
    }
    if (live?.rulebook) {
      const am = docs.find((x) => x.kind === "amendment" && !live.rulebook!.documents.some((r) => r.id === x.id)) ?? docs[docs.length - 1]!;
      const rb = amendRulebook(live.rulebook, { id: am.id, kind: am.kind, title: am.filename.replace(/\.pdf$/i, ""), date: now().slice(0, 10) });
      setDraft(d, ver, buildDraft(rb, amendmentSpecs(am.id, rb.invoiceables.length - 1, rb.budgetGrids[0]!.visits[5]!.totalCents), { amendment: true, retroactive: true }));
      ver.status = "draft";
      st.status = "amendment_in_review";
    } else {
      const rbDocs = docs.map((x) => ({ id: x.id, kind: x.kind, title: x.filename.replace(/\.pdf$/i, ""), date: null }));
      const terms = docs.find((x) => x.kind === "work_order") ?? docs[0]!;
      const hasMaster = docs.some((x) => x.kind === "master_agreement");
      const gridPage = Math.min(9, terms.pageCount);
      const rb = makeRulebook({
        sponsor: st.sponsor ?? "Unknown sponsor", payingAgent: null, protocol: st.protocol ?? "—", site: st.siteName ?? "—", pi: st.investigator ?? "—",
        effectiveDate: now().slice(0, 10), termsDoc: terms.id, docs: rbDocs,
        grids: [{ id: `g-${st.id}`, label: "Exhibit A – Budget", arm: null, docId: terms.id, page: gridPage, overheadPct: 30 }],
        ...(hasMaster ? {} : { missingMaster: { description: "Master Clinical Trial Agreement", date: "2024-01-15" } }),
      });
      // Keep every page reference inside the uploaded documents.
      clampPages(rb, docs);
      const scan = docs.some((x) => /scan/i.test(x.filename));
      setDraft(d, ver, buildDraft(rb, scan ? [] : newContractSpecs({ doc: terms.id, pages: terms.pageCount, gridPage, hasMaster }), { scan, unclear: UNCLEAR_OVERHEAD }));
      Object.assign(ver, { status: "draft", appliesFrom: null });
      st.status = "needs_review";
    }
    st.updatedAt = now();
    log(d, "system", st.id, "extraction.succeeded", { version: ver.version, questions: ver.review.length });
  }
}

function clampPages(rb: Rulebook, docs: DocumentDto[]) {
  const max = new Map(docs.map((x) => [x.id, x.pageCount]));
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    const src = (r.source ?? null) as { documentId: string; page: number } | null;
    if (r.confidence !== undefined && src) src.page = Math.min(src.page, max.get(src.documentId) ?? src.page);
    Object.values(r).forEach(walk);
  };
  walk(rb);
}

// ---------------------------------------------------------------- helpers

function log(d: Db, by: string, studyId: string | null, action: string, detail: Record<string, unknown>, at = now()) {
  d.audit.push({ id: `au-${++d.seq}`, at, by, studyId, action, detail });
}
const latestSigned = (d: Db, studyId: string) =>
  d.versions.filter((v) => v.studyId === studyId && v.status === "signed").sort((a, b) => b.version - a.version)[0];
const versionsOf = (d: Db, studyId: string) => d.versions.filter((v) => v.studyId === studyId).sort((a, b) => a.version - b.version);

function summary(d: Db, s: Study): StudySummaryDto {
  const vs = versionsOf(d, s.id);
  const draft = [...vs].reverse().find((v) => v.status === "draft");
  return {
    id: s.id, sponsor: s.sponsor, protocol: s.protocol, siteName: s.siteName, investigator: s.investigator, status: s.status,
    liveVersion: latestSigned(d, s.id)?.version ?? null,
    openAnomalies: 0,
    // ponytail: a by-hand draft still being typed counts as 1 (the typing); the summary has no by-hand flag yet.
    needsYou: !draft ? 0 : draft.byHand && !draft.review.length ? 1 : needsYou(draft.review).length,
    updatedAt: s.updatedAt,
  };
}

// ---------------------------------------------------------------- alerts: raised when a contract reaches a step that needs someone

type Stage = "needs" | "approve" | "reading" | "failed" | "other";
const stageOf = (d: Db, s: Study): Stage => {
  const st = summaryStage(summary(d, s));
  return st.failed ? "failed" : st.stage === "Needs you" ? "needs" : st.stage === "Approve" ? "approve" : st.stage === "Reading" ? "reading" : "other";
};
const stages = (d: Db) => new Map(d.studies.map((s) => [s.id, stageOf(d, s)]));
const latestVersion = (d: Db, studyId: string) => Math.max(0, ...d.versions.filter((v) => v.studyId === studyId).map((v) => v.version));

function raiseAlert(d: Db, a: Omit<Alert, "id" | "at"> & { at?: string }) {
  d.alerts.push({ ...a, id: `al-${d.seq++}`, at: a.at ?? now() });
}

/** Same rule as the real API: into Needs you → questions ready; into approval → ready; into couldn't read. */
function raiseAlerts(d: Db, before: Map<string, Stage>, by: string, since = d.alerts.length) {
  const raised = new Set(d.alerts.slice(since).map((a) => a.studyId)); // e.g. sent back, raised by its own route
  for (const s of d.studies) {
    const was = before.get(s.id);
    const is = stageOf(d, s);
    if (!was || was === is || raised.has(s.id)) continue;
    const base = { studyId: s.id, version: latestVersion(d, s.id), by, count: null, note: null };
    if (is === "needs") raiseAlert(d, { ...base, kind: "questions_ready", count: summary(d, s).needsYou });
    else if (is === "approve") raiseAlert(d, { ...base, kind: "ready_for_approval" });
    else if (is === "failed") raiseAlert(d, { ...base, kind: "couldnt_read" });
  }
}

/** GET /alerts?for=: newest first; everyone sees every alert, read state is per person. */
function listAlerts(d: Db, query: URLSearchParams): Res {
  const parsed = AlertListQuery.safeParse(Object.fromEntries(query));
  if (!parsed.success) return err(400, "Say whose alerts to show.");
  const { for: person, cursor, limit } = parsed.data;
  const read = new Set(d.alertReads[person] ?? []);
  const isRead = (a: Alert) => read.has(a.id) || a.by === person;
  const all = [...d.alerts].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  // ponytail: an offset cursor in the sample server; the real API pages by key.
  const start = cursor ? Number(atob(cursor)) || 0 : 0;
  const items = all.slice(start, start + limit).map((a) => {
    const st = d.studies.find((x) => x.id === a.studyId);
    // everyone sees every alert, and a send-back note can name the value being answered again blind
    return { ...a, note: a.note && blankNumbers(a.note), protocol: st?.protocol ?? null, sponsor: st?.sponsor ?? null, read: isRead(a) };
  });
  return ok({ items, unread: all.filter((a) => !isRead(a)).length, nextCursor: start + limit < all.length ? btoa(String(start + limit)) : null });
}

/** POST /alerts/read: the given alerts, or all of them, are read for `by`. */
function readAlerts(d: Db, raw: unknown): Res {
  const parsed = ReadAlertsBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who read which alerts.");
  const { by, ids } = parsed.data;
  const read = new Set([...(d.alertReads[by] ?? []), ...(ids ?? d.alerts.map((a) => a.id)).filter((id) => d.alerts.some((a) => a.id === id))]);
  d.alertReads[by] = [...read];
  return ok({ unread: d.alerts.filter((a) => !read.has(a.id) && a.by !== by).length });
}

// ---------------------------------------------------------------- listing and searching, done by the "server" as the real API does

const viewOf = (s: StudySummaryDto): StudyView | null => VIEWS.find((v) => v.test(summaryStage(s)))?.id ?? null;
/** Most urgent first: needs you, couldn't read, details to confirm, approval, reading, live. */
const urgency = (s: StudySummaryDto) => {
  const st = summaryStage(s);
  return st.failed ? 1 : { "Needs you": 0, Upload: 2, Approve: 3, Reading: 4, Checking: 4, Live: 5 }[st.stage];
};
const matchesQ = (s: StudySummaryDto, q?: string) =>
  !q?.trim() || q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => [s.protocol, s.sponsor, s.siteName, s.investigator].some((x) => x?.toLowerCase().includes(w)));

/** GET /studies: one page, most urgent first (needs you oldest first; the rest newest first). */
function listStudies(d: Db, query: URLSearchParams): Res {
  const parsed = StudyListQuery.safeParse(Object.fromEntries(query));
  if (!parsed.success) return err(400, "That list filter isn't valid.");
  const { view, site, q, cursor, limit } = parsed.data;
  const all = d.studies
    .map((s) => summary(d, s))
    .filter((s) => (!view || viewOf(s) === view) && (!site || s.siteName === site) && matchesQ(s, q))
    .sort((a, b) => urgency(a) - urgency(b) || (urgency(a) === 0 ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt)) || a.id.localeCompare(b.id));
  // ponytail: an offset cursor in the sample server; the real API pages by key.
  const start = cursor ? Number(atob(cursor)) || 0 : 0;
  return ok({ items: all.slice(start, start + limit), nextCursor: start + limit < all.length ? btoa(String(start + limit)) : null, total: all.length });
}

/** GET /studies/counts: contracts per view and the sites there are. */
function countStudies(d: Db, query: URLSearchParams): Res {
  const site = query.get("site") || undefined;
  const all = d.studies.map((s) => summary(d, s));
  const here = all.filter((s) => !site || s.siteName === site);
  const views: Record<StudyView, number> = { "needs-you": 0, approval: 0, live: 0, failed: 0 };
  for (const s of here) {
    const v = viewOf(s);
    if (v) views[v]++;
  }
  const bySite = new Map<string, number>();
  for (const s of all) if (s.siteName) bySite.set(s.siteName, (bySite.get(s.siteName) ?? 0) + 1);
  return ok({ all: here.length, views, sites: [...bySite].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })) });
}

/** GET /search: ⌘K. Contracts, and rates in each contract's live version. */
function searchAll(d: Db, query: URLSearchParams): Res {
  const q = (query.get("q") ?? "").trim();
  const limit = Math.min(20, Number(query.get("limit")) || 8);
  if (!q) return ok({ contracts: [], rates: [] });
  const contracts = d.studies.map((s) => summary(d, s)).filter((s) => matchesQ(s, q)).slice(0, limit);
  const rates: RateHit[] = [];
  for (const s of d.studies) {
    const v = latestSigned(d, s.id);
    if (!v?.rulebook) continue;
    const rb = v.rulebook;
    const base = { studyId: s.id, protocol: s.protocol, sponsor: s.sponsor, version: v.version };
    for (const h of searchMaster(rb, q)) {
      let m: RegExpExecArray | null;
      if ((m = /^\/budgetGrids\/(\d+)\/procedures\/(\d+)$/.exec(h.path))) {
        const g = rb.budgetGrids[Number(m[1])]!;
        const p = g.procedures[Number(m[2])]!;
        rates.push({ ...base, path: h.path, kind: "procedure", name: p.name, code: p.code, cents: p.unitCents, detail: g.label });
      } else if ((m = /^\/siteFees\/(\d+)$/.exec(h.path))) {
        const f = rb.siteFees[Number(m[1])]!;
        rates.push({ ...base, path: h.path, kind: "fee", name: f.name, code: f.code, cents: f.amountCents, detail: f.trigger.replace(/_/g, " ") });
      } else if ((m = /^\/invoiceables\/(\d+)$/.exec(h.path))) {
        const x = rb.invoiceables[Number(m[1])]!;
        rates.push({ ...base, path: h.path, kind: "invoiceable", name: x.name, code: x.code, cents: x.amountCents, detail: x.frequency });
      }
    }
  }
  return ok({ contracts, rates: rates.slice(0, limit) });
}

/** The invoicing master as an .xlsx, built in the browser by the same code the real server uses. */
export async function mockExport(studyId: string, version: number, by: string): Promise<{ blob: Blob; filename: string }> {
  const d = load();
  const st = d.studies.find((s) => s.id === studyId);
  const ver = d.versions.find((v) => v.studyId === studyId && v.version === version);
  if (!st || !ver?.rulebook) throw new Error("There's no invoicing master to export yet.");
  if (ver.status !== "signed" && ver.status !== "superseded") throw new Error("Only an approved version can be exported.");
  const { buildWorkbook } = await import("@dct/shared/xlsx");
  const bytes = await buildWorkbook(ver.rulebook, {
    protocol: st.protocol, sponsor: st.sponsor, site: st.siteName, investigator: st.investigator, version, status: ver.status, approvedBy: ver.signedBy, approvedAt: ver.signedAt,
  });
  log(d, by, st.id, "master.exported", { version, format: "xlsx" });
  save();
  return { blob: new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename: `${(st.protocol ?? "contract").replace(/[^\w.-]+/g, "_")}-v${version}-invoicing-master.xlsx` };
}

function detail(d: Db, s: Study): StudyDetailDto {
  return {
    ...summary(d, s),
    documents: d.documents.filter((x) => s.documentIds.includes(x.id)),
    versions: versionsOf(d, s.id).map(({ version, status, createdAt, signedBy, signedAt, appliesFrom }) => ({ version, status, createdAt, signedBy, signedAt, appliesFrom })),
  };
}

function guessKind(filename: string): DocumentKind {
  const f = filename.toLowerCase();
  if (/amend/.test(f)) return "amendment";
  if (/budget|payment.?schedule|attachment/.test(f)) return "budget";
  if (/master|msa|\bcta\b|_cta/.test(f)) return "master_agreement";
  if (/work.?order|\bwo\d?\b|_wo/.test(f)) return "work_order";
  if (/adopt/.test(f)) return "adoption";
  return "other";
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- diff

export function diffRulebooks(before: Rulebook | null, after: Rulebook | null): DiffEntry[] {
  const out: DiffEntry[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a === undefined) return out.push({ path, change: "added", before: null, after: b, label: labelFor(path, after) });
    if (b === undefined) return out.push({ path, change: "removed", before: a, after: null, label: labelFor(path, before) });
    if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b) && !(Array.isArray(a) && typeof a[0] !== "object")) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== "prov") walk(a[k], b[k], `${path}/${k}`);
      return;
    }
    out.push({ path, change: "changed", before: a, after: b, label: labelFor(path, after) });
  };
  walk(before, after, "");
  return out;
}

// ---------------------------------------------------------------- answering questions

const norm = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase() : x);
/** As the real API: text ignores case and edge spaces; a list ignores the order of its items too. */
const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify(a.map(norm).sort()) === JSON.stringify(b.map(norm).sort()) : JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const WHY = "Add a short note saying why the PDF text is wrong here.";
const WHERE = "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note.";
const ARITHMETIC = new Set(["VISIT_TOTAL_MISMATCH", "PER_PATIENT_TOTAL_MISMATCH"]);
/** Answers that list a term to bill by hand on the master's unclassified list (ADR-001 §7). */
const BILL_BY_HAND = new Set(["UNACCOUNTED_TERM", "SCAN_PAGE", "PICTURE_PAGE"]);

/** As the real API's sumAt: what a printed total should be from its parts, which "the sum governs" writes. */
function sumAt(rb: Rulebook, path: string): number | undefined {
  const m = /^\/budgetGrids\/(\d+)\/(?:visits\/(\d+)\/(totalCents|procedureSubtotalCents|nonProcedureCents)|perPatientTotals\/\d+\/cents)$/.exec(path);
  const g = m ? rb.budgetGrids[Number(m[1])] : undefined;
  if (!g || !m) return undefined;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  if (!m[2]) return sum(g.visits.map((v) => v.totalCents));
  const v = g.visits[Number(m[2])];
  if (!v) return undefined;
  const cells = (cat?: "non_procedure") => sum(g.procedures.filter((p) => !cat || p.category === cat).map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number"));
  const out =
    m[3] === "totalCents" ? (v.procedureSubtotalCents === null || v.overheadCents === null ? undefined : v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0))
    : m[3] === "procedureSubtotalCents" ? cells() - (v.nonProcedureCents ?? 0)
    : cells("non_procedure");
  return out !== undefined && out >= 0 ? out : undefined;
}

/** What picking an option writes, as the real API: the arm's grid (the other arms' picks stay), the sum, or the value. */
function optionValue(rb: Rulebook, item: ReviewItem, optionId: string, current: unknown, secret: Secret | undefined): { path: string; value: unknown } | undefined {
  if (item.reason === "GRID_CONFLICT") {
    const arm = new Set(item.options.map((o) => o.id));
    return { path: "/governingGridIds", value: [...(rb.governingGridIds ?? []).filter((id) => !arm.has(id)), optionId] };
  }
  if (ARITHMETIC.has(item.reason)) {
    const value = optionId === "sum" && item.path ? sumAt(rb, item.path) : undefined;
    return value === undefined ? undefined : { path: item.path!, value };
  }
  if (secret?.apply?.[optionId]) return secret.apply[optionId];
  // "prospective only": the amendment's own date, as its label shows it
  if (optionId === PROSPECTIVE && item.path === "/appliesFrom/value") {
    const d = amendmentDate(rb);
    return d ? { path: item.path, value: d } : undefined;
  }
  if (!item.path || (item.kind !== "confirm_value" && item.kind !== "interpretation") || current === undefined || !leaf(current)) return undefined;
  return { path: item.path, value: typeof current === "boolean" ? optionId === "true" : optionId };
}

const shortLabel = (quote: string) => {
  const t = quote.replace(/\s+/g, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, "")}…`;
};
/** As the real API: what "bill by hand" lists, the term's own words or the page to read. */
function unclassifiedOf(rb: Rulebook, item: ReviewItem, note: string | undefined): Unclassified {
  const w = item.where[0]!;
  const title = rb.documents.find((x) => x.id === w.documentId)?.title ?? "the contract";
  const t = item.term;
  return {
    label: t ? shortLabel(t.quote) : `Page ${w.page} of “${title}”`,
    quote: t?.quote ?? "", page: w.page, amounts: t?.amounts ?? [],
    ...(t?.pct !== undefined ? { pct: t.pct } : {}), ...(t?.days !== undefined ? { days: t.days } : {}),
    note: note ?? "", prov: { source: { documentId: w.documentId, page: w.page }, confidence: 1, method: "manual", crossCheck: "not_checked" }, itemId: item.id,
  };
}

/**
 * POST .../review/:itemId, as the real API. A typed value is compared with the PDF's own text at its spot, or, where it
 * prints nothing parseable, with the value we hold: matched, or differs (then picking a value settles it as chosen).
 * Settling a differs needs a note: keeping your own value over the PDF text says why the text is wrong; with no PDF
 * text, either value says where the page prints it, and the answer is marked `noPdfText`. Options are chosen; one with a
 * `note` needs one. An interpretation's pick is checked against the read's value; a question with options and an input
 * takes either. Can't tell is left for the approver and clears nothing. "Bill by hand" lists the term on the master, any
 * other answer takes it off. The same settling answer again from the same person changes nothing. A random spot check
 * kept different from what the PDF check confirmed has missed: logged as an incident, alerted, and approval waits for
 * its kind of value to be proofread. A cap's limit is asked once its kind is.
 */
function answer(d: Db, st: Study, ver: RulebookVersionDto, itemId: string, raw: unknown, at = now()): Res {
  if (ver.status !== "draft" || !ver.rulebook) return err(409, `Version ${ver.version} is ${ver.status}; only a draft takes answers.`);
  const item = ver.review.find((i) => i.id === itemId);
  if (!item) return err(404, "Question not found");
  const parsed = AnswerReviewBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who is answering.");
  const b = parsed.data;
  // The blind re-type of hand-typed values must be done by someone who didn't type them, nor change any value since.
  const retype = ver.byHand && item.reason === "spot_check";
  if (retype && ver.editors.some((e) => samePerson(e, b.by))) {
    const typist = ver.evidence.some((e) => e.note?.startsWith("Typed by hand by ") && samePerson(e.note.slice("Typed by hand by ".length), b.by));
    return err(409, typist ? `${b.by} typed these values, so someone else has to re-type them.` : `${b.by} changed a value on this contract, so someone else has to re-type the rest.`);
  }
  const secret = d.secrets[`${st.id}/${ver.version}/${item.id}`];
  const current = item.path ? getAt(ver.rulebook, item.path) : undefined;
  let value = b.value;
  if (Array.isArray(current) && typeof value === "string") value = value.split(",").map((x) => x.trim()).filter(Boolean);
  const ev = item.path ? ver.evidence.find((e) => e.path === item.path) : undefined;
  const note = b.note?.trim();
  const a = item.answer;
  if (settled(item) && a && samePerson(a.by, b.by) && !b.cantTell && (a.optionId ?? null) === (b.optionId ?? null) && (a.note ?? "") === (note ?? "") && (b.optionId !== undefined || same(a.value, value)))
    return ok(view(ver));
  // a pick, unless the question also takes a typed value and none was picked
  const pick = item.options.length > 0 && (b.optionId !== undefined || !item.input);
  let outcome: NonNullable<ReviewItem["outcome"]>;
  let set: { path: string; value: unknown } | undefined;
  let noPdfText = false;
  if (b.cantTell) outcome = "cant_tell";
  else if (pick) {
    const option = item.options.find((o) => o.id === b.optionId);
    if (!option) return err(400, "Pick one of the options.");
    if (option.note && !note) return err(400, `Add a short note for this answer: ${option.note.replace(/^./, (c) => c.toLowerCase())}`);
    set = optionValue(ver.rulebook, item, option.id, current, secret);
    const checkable = set && (item.kind === "confirm_value" || item.kind === "interpretation") && item.reason !== "REQUIRED_MISSING" && !empty(current) && current !== "unspecified" && item.outcome !== "differs";
    if (item.outcome === "differs" && !note) return err(400, WHERE);
    noPdfText = item.outcome === "differs";
    outcome = checkable && !same(set!.value, current) ? "differs" : checkable ? "matched" : "chosen";
    if (outcome === "differs") set = undefined;
  } else {
    if (value === undefined || value === null || value === "") return err(400, "Type a value, or say you can't tell.");
    if (item.path && !RulebookSchema.safeParse(setAt(ver.rulebook, item.path, value)).success) return err(400, "That value can't go in this field. Check what you typed.");
    // the sentence's full stop or comma after the number isn't part of it
    const text = ev?.printed ? parseAnswer(item.input ?? "text", ev.printed.trim().replace(/[.,;:]+$/, "")) : null;
    const printed = text && "value" in text ? text.value : undefined;
    const truth = printed ?? (empty(current) || item.reason === "REQUIRED_MISSING" ? undefined : current);
    if (item.outcome === "differs") {
      if (printed === undefined && !note) return err(400, WHERE);
      if (printed !== undefined && !same(value, printed) && !note) return err(400, WHY);
      noPdfText = printed === undefined;
      outcome = "chosen";
    } else if (truth === undefined) outcome = "chosen";
    else outcome = same(value, truth) ? "matched" : "differs";
    if (outcome !== "differs" && item.path) set = { path: item.path, value };
  }
  const changed = settled(item);
  const picked = pick && !b.cantTell ? optionValue(ver.rulebook, item, b.optionId!, current, secret)?.value : undefined;
  item.compare = outcome === "differs" ? { typed: picked ?? value, read: current ?? null, printed: ev?.printed ?? null } : null;
  const typed = !b.cantTell && !pick;
  item.answer = { value: typed ? value : undefined, optionId: b.optionId, cantTell: b.cantTell, note: note || undefined, ...(noPdfText ? { noPdfText } : {}), by: b.by, at };
  item.sentBack = null;
  item.outcome = outcome;
  const before = set ? getAt(ver.rulebook, set.path) : undefined;
  let rb = upgradeRulebook(ver.rulebook);
  if (set) rb = setAt(rb, set.path, set.value);
  // as the real API: no limit, so a cap's figures go with its kind
  if (set && /\/cap\/kind$/.test(set.path) && set.value === "none")
    for (const p of alsoWithheld(set.path)) {
      rb = setAt(rb, p, null);
      ver.evidence = ver.evidence.filter((e) => e.path !== p);
    }
  if (item.reason === "GRID_CONFLICT" && set && item.options.some((o) => o.id === rb.governingGridId)) rb = { ...rb, governingGridId: null };
  let listed: { billByHand: string } | { offBillByHand: string } | Record<string, never> = {};
  if (BILL_BY_HAND.has(item.reason)) {
    const was = rb.unclassified.find((u) => u.itemId === item.id);
    rb = { ...rb, unclassified: [...rb.unclassified.filter((u) => u.itemId !== item.id), ...(outcome === "chosen" && b.optionId === "bill_by_hand" ? [unclassifiedOf(rb, item, note)] : [])] };
    const is = rb.unclassified.find((u) => u.itemId === item.id);
    listed = is && !was ? { billByHand: is.label } : was && !is ? { offBillByHand: was.label } : {};
  }
  ver.rulebook = rb;
  if (item.path && settled(item)) {
    if (ev) Object.assign(ev, { status: "attested", note: `Typed by ${b.by}` });
    else if (set?.path === item.path) ver.evidence.push({ path: item.path, status: "attested", where: item.where, printed: null, note: `Typed by ${b.by}` });
  }
  // maker-checker: whoever decides is an editor; a re-typer (hand-typed values, the read's sample) only when their answer changes a value
  const wrote = !!set && !same(before ?? null, set.value);
  if (outcome !== "cant_tell" && (!(retype || item.reason === SAMPLE) || wrote) && !ver.editors.some((e) => samePerson(e, b.by))) ver.editors.push(b.by);
  // the sample missed: once missed, it stays missed
  const missed = item.reason === SAMPLE && !item.missed && outcome === "chosen" && wrote;
  if (missed) item.missed = true;
  // a cap's limit, once its kind is known (as the real API)
  const ask = (p: string, id: string, reason: string) => {
    const x = askAbout(ver.rulebook!, ver.evidence, p, id, reason);
    d.secrets[`${st.id}/${ver.version}/${id}`] = toSecret(x);
    return toItem(x);
  };
  ver.review.push(...capFollowUps({ ...ver, rulebook: ver.rulebook! }, item, !!set && JSON.stringify(before ?? null) !== JSON.stringify(set.value), ask));
  ver.updatedAt = at;
  st.updatedAt = at;
  const logged = !set || !wrote ? {} : set.path === "/governingGridIds" ? { gridId: b.optionId } : { path: set.path, before: before ?? null, after: set.value };
  log(d, b.by, st.id, changed ? "review.changed" : "review.answered", { version: ver.version, itemId: item.id, question: item.question, outcome: outcome.replace("_", " "), ...(note ? { note } : {}), ...logged, ...listed }, at);
  if (missed) {
    // an incident (ADR-001 §6): logged, told to everyone, and approval waits for its kind of value to be checked
    const miss = sampleMisses(ver).find((m) => m.family === familyOf(item.path!))!;
    log(d, b.by, st.id, "sample.missed", { version: ver.version, itemId: item.id, path: item.path, question: item.question, values: miss.label, "to check": miss.left.length }, at);
    raiseAlert(d, { kind: "sample_missed", studyId: st.id, version: ver.version, by: b.by, count: miss.left.length, note: null, at });
  }
  return ok(view(ver));
}

/**
 * A version as a response shows it, as the real API (versionDto): on a draft, each value with an open question is
 * withheld with the words that restate it (mask), its printed text too, the checks' findings, and the numbers in notes
 * about it (blindReview).
 */
function view(ver: RulebookVersionDto): RulebookVersionDto {
  const hidden = withheldPaths(ver);
  const rulebook = ver.rulebook && upgradeRulebook(ver.rulebook);
  if (!hidden.length) return { ...ver, rulebook };
  return {
    ...ver,
    rulebook: rulebook && mask(rulebook, hidden, ver),
    anomalies: [],
    evidence: ver.evidence.map((e) => (hidden.includes(e.path) ? { ...e, printed: null } : e)),
    review: blindReview(ver.review, hidden, ver.evidence),
  };
}

/**
 * GET /audit, as the real API: newest first, narrowed to a contract, every word of `q` in what's shown. While a value's
 * question is open on its draft, an entry about it (its path, or the question it answered or sent back) shows no
 * before/after value, and its note has its numbers blanked.
 */
function listAudit(d: Db, query: URLSearchParams): Res {
  const parsed = AuditListQuery.safeParse(Object.fromEntries(query));
  if (!parsed.success) return err(400, "That activity filter isn't valid.");
  const { studyId, q, cursor, limit } = parsed.data;
  const shown = (e: Entry): AuditEntryDto => {
    const st = d.studies.find((s) => s.id === e.studyId);
    const ver = d.versions.find((v) => v.studyId === e.studyId && v.version === e.detail.version);
    // the real API's rule, the same code (@dct/shared blindDetail)
    const detail = blindDetail(e.action, e.detail, ver && { hidden: new Set(withheldPaths(ver)), review: ver.review, evidence: ver.evidence });
    return { ...e, protocol: st?.protocol ?? null, sponsor: st?.sponsor ?? null, detail };
  };
  // newest first; reversed first so that, at the same time, the later entry comes first
  const all = [...d.audit]
    .reverse()
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((e) => !studyId || e.studyId === studyId)
    .map(shown)
    .filter((e) => !q?.trim() || auditMatches(e, q));
  // ponytail: an offset cursor in the sample server; the real API pages by key.
  const start = cursor ? Number(atob(cursor)) || 0 : 0;
  return ok({ items: all.slice(start, start + limit), nextCursor: start + limit < all.length ? btoa(String(start + limit)) : null });
}

/** POST .../send-back: the approver reopens answered questions with a note; they're answered again, blind. */
function sendBack(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown, at = now()): Res {
  const parsed = SendBackBody.safeParse(raw);
  if (!parsed.success) return err(400, "Pick the answers to send back and add a note.");
  if (ver.status !== "draft") return err(409, `Version ${ver.version} is ${ver.status}; only a draft's answers can be sent back.`);
  const { itemIds, note, by } = parsed.data;
  const items = itemIds.map((id) => ver.review.find((i) => i.id === id));
  if (items.some((i) => !i)) return err(400, "One of those questions isn't on this version.");
  if (items.some((i) => i!.outcome === null)) return err(409, "Only answered questions can be sent back.");
  for (const i of items as ReviewItem[]) {
    Object.assign(i, { outcome: null, answer: null, compare: null, sentBack: { by, note, at } });
    const ev = i.path ? ver.evidence.find((e) => e.path === i.path) : undefined;
    if (ev?.status === "attested") Object.assign(ev, { status: "conflict", note: `Sent back by ${by}` });
  }
  // a term listed to bill by hand comes off the list while its answer is reopened
  if (ver.rulebook) ver.rulebook = { ...upgradeRulebook(ver.rulebook), unclassified: upgradeRulebook(ver.rulebook).unclassified.filter((u) => !itemIds.includes(u.itemId ?? "")) };
  ver.updatedAt = at;
  st.updatedAt = at;
  log(d, by, st.id, "review.sent_back", { version: ver.version, questions: items.length, itemIds: items.map((i) => i!.id), note }, at);
  raiseAlert(d, { kind: "sent_back", studyId: st.id, version: ver.version, by, count: items.length, note, at });
  return ok(view(ver));
}

/** POST .../proofread: values that looked right. Any version with a master, live ones too: the marks never change its numbers. */
function proofread(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown, at = now()): Res {
  const parsed = ProofreadBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who is proofreading and which values.");
  if (!ver.rulebook || ver.status === "superseded") return err(409, `Version ${ver.version} can't be proofread.`);
  const { paths, by } = parsed.data;
  if (paths.some((p) => getAt(ver.rulebook, p) === undefined)) return err(400, "One of those values isn't in the invoicing master.");
  const marks = new Map((ver.proofread ?? []).map((m) => [m.path, m]));
  for (const path of paths) marks.set(path, { path, by, at });
  ver.proofread = [...marks.values()];
  ver.updatedAt = at;
  log(d, by, st.id, "values.proofread", { version: ver.version, values: paths.length }, at);
  return ok(view(ver));
}

// ---------------------------------------------------------------- "This looks wrong" and typing by hand


function addQuestion(d: Db, ver: RulebookVersionDto, x: Spec) {
  ver.review.push(toItem(x));
  d.secrets[`${ver.studyId}/${ver.version}/${x.id}`] = toSecret(x);
}

/**
 * POST .../report. On a draft: a blocking blind question about the value. On the live version: a correction draft
 * (a copy of it plus that question); the live version stays live until the draft is approved.
 */
function report(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown): Res {
  const parsed = ReportValueBody.safeParse(raw);
  if (!parsed.success) return err(400, "Add a short note and say who is reporting.");
  const { path, note, by } = parsed.data;
  if (!ver.rulebook || getAt(ver.rulebook, path) === undefined || !leaf(getAt(ver.rulebook, path))) return err(400, "Pick a single value to report.");
  let draft = ver;
  if (ver.status === "signed") {
    const newest = versionsOf(d, st.id).at(-1)!;
    // as the real API: an amendment that couldn't be read is read again first, never replaced by a correction
    if (newest.status === "failed") return err(409, `The amendment in version ${newest.version} couldn't be read. Read it again, or type it in by hand, then report this on that version.`);
    if (newest.status === "extracting") return err(409, `Version ${newest.version} is being read right now. When it's ready, report this there.`);
    if (newest.version !== ver.version) return err(409, `Version ${newest.version} is already in progress. Report it there.`);
    draft = { ...structuredClone(ver), version: ver.version + 1, status: "draft", createdAt: now(), updatedAt: now(), signedBy: null, signedAt: null, editors: [], review: [], byHand: false, proofread: [], warnings: [] };
    d.versions.push(draft);
    st.status = "amendment_in_review";
  } else if (ver.status !== "draft" || ver.byHand) return err(409, `Version ${ver.version} is ${ver.status}; report a value on the live version or a draft.`);
  if (withheldPaths(draft).includes(path)) return err(409, "There's already an open question about this value.");
  const x = askAbout(draft.rulebook!, draft.evidence, path, `r${++d.seq}`, "reported");
  addQuestion(d, draft, x);
  // the note goes with the question, so whoever answers it sees why (its numbers blanked until it's settled)
  draft.review.at(-1)!.reported = { by, note, at: now() };
  draft.updatedAt = now();
  st.updatedAt = now();
  const value = getAt(draft.rulebook!, path);
  log(d, by, st.id, typeof value === "number" ? "number.reported" : "value.reported", { version: draft.version, path, value: labelFor(path, draft.rulebook), note });
  return ok(view(draft));
}

/** POST /studies/:id/versions/by-hand: a blank draft for a contract that couldn't be read. */
function startByHand(d: Db, st: Study, raw: unknown): Res {
  const parsed = ByHandBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who is typing.");
  const vs = versionsOf(d, st.id);
  const newest = vs.at(-1);
  if (newest && (newest.status === "draft" || newest.status === "extracting")) return err(409, `Version ${newest.version} is already in progress.`);
  const docs = d.documents.filter((x) => st.documentIds.includes(x.id)).map((x) => ({ id: x.id, kind: x.kind, title: x.filename.replace(/\.pdf$/i, ""), date: null }));
  const ver = newVersion(st.id, (newest?.version ?? 0) + (newest?.status === "failed" ? 0 : 1), "draft");
  Object.assign(ver, { byHand: true, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, rulebook: blankRulebook(docs, { sponsor: st.sponsor ?? "", protocol: st.protocol ?? "", site: st.siteName ?? "", pi: st.investigator ?? "" }) });
  // replaces the failed attempt, as the real API: same version number, never a gap
  d.versions = [...d.versions.filter((v) => !(v.studyId === st.id && v.version === ver.version)), ver];
  st.status = latestSigned(d, st.id) ? "amendment_in_review" : "needs_review";
  st.updatedAt = now();
  log(d, parsed.data.by, st.id, "version.manual_created", { version: ver.version });
  return ok(view(ver));
}

/**
 * PATCH .../values, by-hand drafts only, until entry is marked done. Every typed value is attested; removing a row or
 * visit moves the evidence of the ones after it. The result must still be a valid invoicing master.
 */
function typeValue(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown): Res {
  if (ver.status !== "draft" || !ver.byHand || !ver.rulebook) return err(409, "Values can only be typed on a contract being typed in by hand. Use “This looks wrong” instead.");
  if (ver.review.length) return err(409, "Typing is marked done. Use “This looks wrong” to change a value.");
  const parsed = CorrectValueBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who is typing.");
  const { path, value, by } = parsed.data;
  const before = getAt(ver.rulebook, path);
  if (before === undefined && segments(path).at(-2) !== "cells") return err(400, `Unknown field ${path}`);
  const rb = setAt(ver.rulebook, path, value);
  if (!RulebookSchema.safeParse(rb).success) return err(400, "That field can't be left empty or take that value.");
  // Structural edit (rows, visits): a typed value keeps its mark only if it's still there unchanged; after removing one
  // row or visit, the ones below move up.
  const removed = Array.isArray(before) && Array.isArray(value) && value.length === before.length - 1
    ? ((i) => (i === -1 ? value.length : i))(value.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(before[i])))
    : -1;
  const ev: ValueEvidence[] = ver.evidence.flatMap((e) => {
    if (!e.path.startsWith(`${path}/`)) return [e];
    const [k, ...tail] = e.path.slice(path.length + 1).split("/");
    const moved = removed >= 0 && Number(k) > removed ? `${path}/${[Number(k) - 1, ...tail].join("/")}` : e.path;
    if (removed >= 0 && Number(k) === removed) return [];
    return JSON.stringify(getAt(ver.rulebook, e.path)) === JSON.stringify(getAt(rb, moved)) ? [{ ...e, path: moved }] : [];
  }).filter((e) => e.path !== path);
  if (leaf(value) && value !== null && value !== "" && !(Array.isArray(value) && !value.length))
    ev.push({ path, status: "attested", where: [], printed: null, note: `Typed by hand by ${by}` });
  ver.rulebook = rb;
  ver.evidence = ev.filter((e) => getAt(rb, e.path) !== undefined);
  ver.updatedAt = now();
  if (!ver.editors.some((e) => samePerson(e, by))) ver.editors.push(by);
  st.updatedAt = now();
  if (leaf(value)) log(d, by, st.id, "value.typed", { version: ver.version, path, value: labelFor(path, rb), before: before ?? null, after: value });
  return ok(view(ver));
}

/** As the real API's placeholders(): numbers in a hand-typed master nobody typed (not an order, a schema version or provenance). */
function placeholders(rb: Rulebook, evidence: ValueEvidence[]): string[] {
  const typed = new Set(evidence.map((e) => e.path));
  const out: string[] = [];
  const walk = (node: unknown, path: string, key: string) => {
    if (key === "prov" || key === "schemaVersion" || key === "order") return;
    if (typeof node === "number") return void (typed.has(path) || out.push(path));
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${path}/${i}`, String(i)));
    else if (node && typeof node === "object") for (const [k, x] of Object.entries(node)) walk(x, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, k);
  };
  walk(rb, "", "");
  return out;
}

/** POST .../by-hand/done: someone else re-types 10 randomly chosen typed values (all of them if fewer), blind. */
function finishByHand(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown): Res {
  const parsed = ByHandBody.safeParse(raw);
  if (!parsed.success) return err(400, "Say who is typing.");
  if (ver.status !== "draft" || !ver.byHand) return err(409, "Only a contract typed by hand can be marked done.");
  if (ver.review.length) return err(409, "Typing is already marked done.");
  const typed = ver.evidence.filter((e) => e.status === "attested" && ["number", "string"].includes(typeof getAt(ver.rulebook, e.path)));
  if (!typed.length) return err(400, "Type at least one value first.");
  // ponytail: Math.random shuffle; a seeded pick if the sample ever needs to be reproducible.
  const sample = typed.map((e) => [Math.random(), e] as const).sort((a, b) => a[0] - b[0]).slice(0, 10).map(([, e]) => e);
  for (const e of sample) addQuestion(d, ver, askAbout(ver.rulebook!, ver.evidence, e.path, `t${++d.seq}`, "spot_check"));
  // As the real API: a number nobody typed holds the blank form's placeholder (a visit's total 0), never seen by a
  // person, so it's asked as missing. (The sample server has no contract checks to run on what was typed.)
  for (const p of placeholders(ver.rulebook!, ver.evidence)) addQuestion(d, ver, { ...askAbout(ver.rulebook!, ver.evidence, p, `missing:${p}`, "REQUIRED_MISSING"), truth: undefined, lines: [] });
  ver.updatedAt = now();
  st.updatedAt = now();
  log(d, parsed.data.by, st.id, "byhand.done", { version: ver.version, typed: typed.length, "re-type": sample.length });
  return ok(view(ver));
}

// ---------------------------------------------------------------- page images

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A synthetic contract page. It prints what the contract says: the right answer for every question (at the question's
 * box, or in the text when only the page is known), and the master's values for everything else.
 */
export function mockPageSrc(docId: string, page: number): string {
  const d = load();
  const doc = d.documents.find((x) => x.id === docId);
  const st = d.studies.find((s) => s.documentIds.includes(docId));
  const scan = !!doc && /scan/i.test(doc.filename);
  // Every version's print on this page (an amendment's grid lives on its own document), each span once.
  const seen = new Set<string>();
  const spans = (st ? versionsOf(d, st.id) : [])
    .filter((v) => v.rulebook)
    .flatMap((v) => {
      const secret = (id: string) => d.secrets[`${st!.id}/${v.version}/${id}`];
      const truth = new Map(v.review.flatMap((i) => (i.path && secret(i.id)?.truth !== undefined ? [[i.path, secret(i.id)!.truth] as const] : [])));
      const items = v.review.map((i) => ({ id: i.id, path: i.path, where: i.where, lines: secret(i.id)?.lines ?? [] }));
      return layoutPage(v.rulebook!, items, (p) => (truth.has(p) ? truth.get(p) : getAt(v.rulebook, p)), docId, page, doc?.filename.replace(/\.pdf$/i, "") ?? docId);
    })
    .filter((s) => {
      const k = `${s.text}|${s.box.join(",")}`;
      return !seen.has(k) && !!seen.add(k);
    });
  const draw = (s: (typeof spans)[number]) => {
    const [x, y, w, h] = s.box;
    const size = Math.min(15, Math.max(8.5, h * 1100 * 0.56));
    const tx = s.anchor === "end" ? (x + w) * 850 : x * 850;
    return `<text x="${tx.toFixed(1)}" y="${((y + h * 0.74) * 1100).toFixed(1)}" font-size="${size.toFixed(1)}" font-weight="${s.weight ?? 400}"${s.anchor === "end" ? ' text-anchor="end"' : ""}${s.muted ? ' fill="#666"' : ""}>${esc(s.text)}</text>`;
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100" viewBox="0 0 850 1100">
<rect width="850" height="1100" fill="${scan ? "#ecebe6" : "#fff"}"/>
<g${scan ? ' transform="rotate(-0.5 425 550)"' : ""}>
<text x="70" y="62" font-family="Georgia,serif" font-size="12" fill="#666">SAMPLE PAGE: not a real contract${scan ? " · scanned copy" : ""}</text>
<text x="780" y="62" text-anchor="end" font-family="Georgia,serif" font-size="12" fill="#666">Page ${page} of ${doc?.pageCount ?? "?"}</text>
<line x1="70" y1="78" x2="780" y2="78" stroke="#ccc"/>
<g font-family="Georgia,serif" fill="#222">${spans.map(draw).join("")}</g>
<text x="425" y="1060" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#888">${esc(st?.protocol ?? "")} · Confidential</text>
</g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- routes

type Res = { status: number; json: unknown };
/** A 400's message as the real API words it (zod's prettifyError). */
const pretty = (e: { issues: { message: string; path: PropertyKey[] }[] }) => e.issues.map((i) => `✖ ${i.message}${i.path.length ? `\n  → at ${i.path.map(String).join(".")}` : ""}`).join("\n");
const ok = (json: unknown): Res => ({ status: 200, json });
const err = (status: number, message: string): Res => ({ status, json: { statusCode: status, error: status === 409 ? "Conflict" : "Error", message } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Idempotency-Key → the request it came with and the response it got, as the API keeps them (in memory here). */
const replays = new Map<string, { request: string; res: Res }>();

export async function mockRequest(method: string, fullPath: string, body: unknown, key?: string): Promise<Res> {
  await sleep(120 + Math.random() * 180);
  // the same key again: the first response, nothing applied twice; with a different request, refused (as the API does)
  const request = `${method} ${fullPath} ${body instanceof FormData ? [...body.entries()].map(([k, v]) => `${k}=${typeof v === "string" ? v : v.name}`).join("&") : JSON.stringify(body ?? null)}`;
  const saved = key ? replays.get(key) : undefined;
  if (saved) return saved.request === request ? saved.res : err(422, "This Idempotency-Key was already used for a different request. Send a new key for each new action.");
  const res = await apply(method, fullPath, body);
  if (key && res.status < 400) replays.set(key, { request, res });
  return res;
}

async function apply(method: string, fullPath: string, body: unknown): Promise<Res> {
  const d = load();
  const by = typeof (body as { by?: unknown } | undefined)?.by === "string" ? (body as { by: string }).by : "system";
  let before = stages(d);
  tick(d);
  raiseAlerts(d, before, "system");
  before = stages(d);
  const mark = d.alerts.length;
  const res = await route(d, method, fullPath, body);
  if (res.status < 400) raiseAlerts(d, before, by, mark);
  save();
  // Like the wire: a fresh copy, so cached responses never share objects with the mock's state.
  return { status: res.status, json: JSON.parse(JSON.stringify(res.json ?? null)) };
}

async function route(d: Db, method: string, fullPath: string, body: unknown): Promise<Res> {
  const [path, qs] = fullPath.split("?");
  const query = new URLSearchParams(qs);
  const m = (re: RegExp) => re.exec(path!);
  const b = (body ?? {}) as Record<string, unknown>;
  const by = typeof b.by === "string" ? b.by : "unknown";
  let r: RegExpExecArray | null;

  if (method === "GET" && path === "/studies") return listStudies(d, query);
  if (method === "GET" && path === "/studies/counts") return countStudies(d, query);
  if (method === "GET" && path === "/search") return searchAll(d, query);
  if (method === "GET" && path === "/alerts") return listAlerts(d, query);
  if (method === "POST" && path === "/alerts/read") return readAlerts(d, body);
  if (method === "GET" && path === "/settings") return ok(d.settings);
  if (method === "PATCH" && path === "/settings") {
    const parsed = PatchSettingsBody.safeParse(body);
    if (!parsed.success) return err(400, pretty(parsed.error));
    const { by: who, ...patch } = parsed.data;
    const after = { ...d.settings, ...patch };
    // the same settings again change nothing, so they log nothing
    if (JSON.stringify(after) === JSON.stringify(d.settings)) return ok(d.settings);
    log(d, who ?? "system", null, "settings.updated", { before: d.settings, after });
    d.settings = after;
    return ok(d.settings);
  }
  if (method === "GET" && path === "/audit") return listAudit(d, query);
  if (method === "POST" && path === "/uploads") {
    const fd = body as FormData;
    const uploader = (fd.get("by") as string | null) ?? "system";
    const out: DocumentDto[] = [];
    const files = fd.getAll("files[]") as File[];
    if (!files.length) return err(400, "No files in upload (field files[])");
    // as the real API, all or none: a file that isn't a PDF refuses the whole upload
    for (const f of files) if (new TextDecoder().decode(await f.slice(0, 5).arrayBuffer()) !== "%PDF-") return err(415, `${f.name} is not a PDF`);
    for (const f of files) {
      const sha = await sha256Hex(f);
      const existing = d.documents.find((x) => x.sha256 === sha);
      if (existing) {
        out.push({ ...existing, duplicateOf: existing.id });
        continue;
      }
      const doc: DocumentDto = { id: `doc-${++d.seq}`, filename: f.name, sha256: sha, kind: guessKind(f.name), pageCount: 4 + (parseInt(sha.slice(0, 2), 16) % 12), uploadedAt: now(), duplicateOf: null, text: textOf(f.name) };
      d.documents.push(doc);
      out.push(doc);
      log(d, uploader, null, "document.uploaded", { file: doc.filename });
    }
    return ok(out);
  }
  if (method === "POST" && path === "/studies") {
    const ids = (b.documentIds as string[]) ?? [];
    if (!ids.length) return err(400, "documentIds must not be empty");
    const st: Study = { id: `st-${++d.seq}`, sponsor: null, protocol: null, siteName: null, investigator: null, status: "setting_up", updatedAt: now(), documentIds: [...new Set(ids)] };
    d.studies.push(st);
    const job: Job = { id: `job-${++d.seq}`, kind: "identify", studyId: st.id, version: null, startedAt: Date.now(), durationMs: 2500, fail: false, applied: false };
    d.jobs.push(job);
    log(d, by, st.id, "study.created", { documents: ids.length });
    return ok({ studyId: st.id, jobId: job.id });
  }
  if ((r = m(/^\/jobs\/([^/]+)$/)) && method === "GET") {
    const j = d.jobs.find((x) => x.id === r![1]);
    return j ? ok(jobView(j)) : err(404, "Job not found");
  }
  if ((r = m(/^\/documents\/([^/]+)$/)) && method === "PATCH") {
    const doc = d.documents.find((x) => x.id === r![1]);
    if (!doc) return err(404, "Document not found");
    const parsed = SetDocumentKindBody.safeParse(body);
    if (!parsed.success) return err(400, pretty(parsed.error));
    if (doc.kind === parsed.data.kind) return ok(doc);
    const before = doc.kind;
    doc.kind = parsed.data.kind;
    // a shared file: every study that uses it logs the change
    const using = d.studies.filter((s) => s.documentIds.includes(doc.id));
    for (const st of using.length ? using : [null]) log(d, parsed.data.by, st?.id ?? null, "document.kind_set", { documentId: doc.id, from: before, to: doc.kind });
    return ok(doc);
  }

  if (!(r = m(/^\/studies\/([^/]+)(\/.*)?$/))) return err(404, `No mock route for ${method} ${path}`);
  const st = d.studies.find((s) => s.id === r![1]);
  if (!st) return err(404, "Study not found");
  const rest = r[2] ?? "";

  if (rest === "" && method === "GET") return ok(detail(d, st));
  if (rest === "" && method === "PATCH") {
    const parsed = ConfirmStudyBody.safeParse(body);
    if (!parsed.success) return err(400, pretty(parsed.error));
    if (versionsOf(d, st.id).some((v) => v.status === "signed" || v.status === "superseded"))
      return err(409, "This contract has an approved version, so its sponsor, protocol, site and investigator can't be changed any more: they're part of what was approved.");
    for (const k of ["sponsor", "protocol", "siteName", "investigator"] as const) st[k] = parsed.data[k];
    st.updatedAt = now();
    log(d, by, st.id, "study.confirmed", { sponsor: st.sponsor, protocol: st.protocol, site: st.siteName, investigator: st.investigator });
    return ok(detail(d, st));
  }
  if (rest === "/extract" && method === "POST") {
    const vs = versionsOf(d, st.id);
    const latest = vs.at(-1);
    // as the real API: a read already running is handed back; a draft is approved first; a failed read is read again in its own version
    if (latest?.status === "extracting") {
      const running = d.jobs.filter((j) => j.studyId === st.id && j.kind === "extract" && j.version === latest.version).at(-1);
      if (running) return ok({ jobId: running.id, version: latest.version });
    }
    if (latest?.status === "draft") return err(409, `Version ${latest.version} is a draft under review; sign it off before extracting again`);
    for (const id of (b.documentIds as string[] | undefined) ?? []) if (!st.documentIds.includes(id)) st.documentIds.push(id);
    const retry = latest && (latest.status === "failed" || latest.status === "extracting");
    const version = retry ? latest.version : (latest?.version ?? 0) + 1;
    const attempts = d.jobs.filter((j) => j.studyId === st.id && j.kind === "extract").length;
    const docs = d.documents.filter((x) => st.documentIds.includes(x.id));
    const fail = attempts === 0 && docs.some((x) => /fail|unreadable/i.test(x.filename));
    d.versions = [...d.versions.filter((v) => !(v.studyId === st.id && v.version === version)), newVersion(st.id, version, "extracting")];
    const job: Job = { id: `job-${++d.seq}`, kind: "extract", studyId: st.id, version, startedAt: Date.now(), durationMs: 7000, fail, applied: false };
    d.jobs.push(job);
    // an amendment being read is being read, not waiting for approval (as the real API)
    st.status = "extracting";
    st.updatedAt = now();
    log(d, by, st.id, "extraction.queued", { version });
    return ok({ jobId: job.id, version });
  }

  if (rest === "/versions/by-hand" && method === "POST") return startByHand(d, st, body);

  const vm = /^\/versions\/(\d+)(\/.*)?$/.exec(rest);
  if (!vm) return err(404, `No mock route for ${method} ${path}`);
  const ver = d.versions.find((v) => v.studyId === st.id && v.version === Number(vm[1]));
  if (!ver) return err(404, "Version not found");
  const vrest = vm[2] ?? "";

  if (vrest === "" && method === "GET") return ok(view(ver));
  if (vrest === "/search" && method === "GET") {
    const q = query.get("q") ?? "";
    // On a draft, a value still hidden for someone to type blind must not be findable: amounts match values, and a
    // term's words include its values. Names and codes of grid rows and fees don't, so those still match.
    // as the real API: the master as it's shown, so a withheld fixed-list word (a fee's trigger) isn't matched either
    const hidden = withheldPaths(ver);
    const byValue = (h: { path: string; section: string }) => amountOf(q) !== null || h.section === "terms";
    const shown = ver.rulebook && (hidden.length ? mask(upgradeRulebook(ver.rulebook), hidden, ver) : ver.rulebook);
    const hits = shown ? searchMaster(shown, q).filter((h) => !(byValue(h) && hidden.some((p) => p === h.path || p.startsWith(`${h.path}/`)))) : [];
    return ok({ q, hits });
  }
  if (vrest === "/diff" && method === "GET") {
    const other = d.versions.find((v) => v.studyId === st.id && v.version === Number(query.get("against")));
    if (!other) return err(404, "Version to compare against not found");
    // blind entry, as the real API: both sides masked alike, and a withheld value never shown as changed
    const hidden = [...new Set([...withheldPaths(other), ...withheldPaths(ver)])];
    const where = { evidence: [...other.evidence, ...ver.evidence], review: [...other.review, ...ver.review] };
    const shown = (rb: Rulebook | null) => rb && (hidden.length ? mask(upgradeRulebook(rb), hidden, where) : upgradeRulebook(rb));
    return ok(diffRulebooks(shown(other.rulebook), shown(ver.rulebook)).filter((e) => !hidden.includes(e.path)));
  }
  if ((r = /^\/review\/([^/]+)$/.exec(vrest)) && method === "POST") return answer(d, st, ver, decodeURIComponent(r[1]!), body);
  if (vrest === "/report" && method === "POST") return report(d, st, ver, body);
  if (vrest === "/proofread" && method === "POST") return proofread(d, st, ver, body);
  if (vrest === "/send-back" && method === "POST") return sendBack(d, st, ver, body);
  if (vrest === "/values" && method === "PATCH") return typeValue(d, st, ver, body);
  if (vrest === "/by-hand/done" && method === "POST") return finishByHand(d, st, ver, body);
  if (vrest === "/sign-off" && method === "POST") {
    // as the real API: as seen (asOf), every question settled, typing re-typed, every number backed, a missed sample's kind
    // of value proofread, then maker-checker
    const parsed = SignOffBody.safeParse(body);
    if (!parsed.success) return err(400, pretty(parsed.error));
    const { by, asOf } = parsed.data;
    if (ver.status === "signed" || ver.status === "superseded") return err(409, `Version ${ver.version} is ${ver.status} and immutable; changes need a new version (amendment)`);
    if (ver.status !== "draft" || !ver.rulebook) return err(409, `Version ${ver.version} is ${ver.status}; only draft versions can be changed`);
    if (ver.updatedAt !== asOf) return err(409, "This contract changed since you opened it. Check it again.");
    if (ver.byHand && !ver.review.length) return err(409, "Typing isn't marked done yet, so nobody has re-typed the values.");
    const open = ver.review.filter((i) => !settled(i)).length;
    if (open) return err(409, `${open} ${open === 1 ? "question still needs" : "questions still need"} an answer before this can be approved.`);
    const unconfirmed = ver.evidence.filter((e) => e.status !== "confirmed" && e.status !== "attested").length;
    if (unconfirmed) return err(409, `${unconfirmed} ${unconfirmed === 1 ? "number isn't" : "numbers aren't"} confirmed by the PDF or a person yet.`);
    const miss = sampleMisses(ver).find((m) => m.left.length);
    if (miss) return err(409, sampleMissWords(miss));
    if (d.settings.makerChecker && ver.editors.some((e) => samePerson(e, by))) return err(409, `Maker-checker is on: ${by} answered questions on this contract, so someone else has to approve it.`);
    for (const v of versionsOf(d, st.id)) if (v.status === "signed") v.status = "superseded";
    Object.assign(ver, { status: "signed", signedBy: by, signedAt: now(), updatedAt: now(), appliesFrom: ver.rulebook?.appliesFrom.value ?? null });
    st.status = "live";
    st.updatedAt = now();
    log(d, by, st.id, "version.signed", { version: ver.version, ...(b.note ? { note: b.note } : {}) });
    return ok(view(ver));
  }
  return err(404, `No mock route for ${method} ${path}`);
}
