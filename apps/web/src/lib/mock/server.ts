import {
  answerQuestion,
  appliesFromOf,
  blindDetail,
  BODY_WORDS,
  bodyProblem,
  followUps,
  isoDate,
  labelFor,
  proofreadMarks,
  shownAppliesFrom,
  signOffRefusal,
  blindReview,
  ByHandBody,
  leaf,
  mask,
  ConfirmStudyBody,
  CorrectValueBody,
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
  searchVersion,
  type RateHit,
  type StudyView,
  Rulebook as RulebookSchema,
  settled,
  type AuditEntryDto,
  type DocumentDto,
  type DocumentKind,
  type JobDto,
  type ReviewItem,
  type Rulebook,
  type RulebookVersionDto,
  type SettingsDto,
  type StudyDetailDto,
  type StudyStatus,
  type StudySummaryDto,
  type ValueEvidence,
  typingDone,
  versionDiff,
} from "@dct/shared";
import { blankRulebook } from "../byhand";
import { layoutPage } from "./layout";
import { getAt, segments, setAt } from "../pointer";
import { needsYou, summaryStage, VIEWS } from "../review";
import {
  amendmentSpecs,
  amendRulebook,
  askAbout,
  buildDraft,
  cobaltSpecs,
  halcyonV1Specs,
  makeRulebook,
  meridianSpecs,
  mockChecks,
  mockSampling,
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

// v9: the blind sample at its page only, and a total that doesn't add up keeps its printed value (asPrinted)
const KEY = "dct.mockdb.v9";
let db: Db | null = null;

const now = () => new Date().toISOString();
/** A version's `updatedAt` for a write that changes it, as the real API's (domain.ts touched): at `at`, and always after the last one. */
const touched = (prev: string, at = now()) => new Date(Math.max(Date.parse(at), Date.parse(prev) + 1)).toISOString();
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
    Object.assign(ver, { status: "signed", signedBy: by, signedAt: at });
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
  // as the API's read: the checks' findings, and the date the terms apply from (kept current by every answer)
  Object.assign(ver, { rulebook: dr.rulebook, review: dr.review, evidence: dr.evidence, pdfCheck: dr.pdfCheck, anomalies: dr.anomalies, appliesFrom: appliesFromOf(dr.rulebook), updatedAt: now() });
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
      ver.status = "draft";
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
    versions: versionsOf(d, s.id).map((v) => ({ version: v.version, status: v.status, createdAt: v.createdAt, signedBy: v.signedBy, signedAt: v.signedAt, appliesFrom: shownAppliesFrom(v) })),
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

// ---------------------------------------------------------------- answering questions

/**
 * POST .../review/:itemId, by the API's own rules (answerQuestion, @dct/shared): checked, written and logged the same,
 * then followed up the same: a grid's held-back totals asked on the typed numbers (the sample server's own checks), a
 * cap's limit once its kind is known. A sample miss is logged as an incident and alerted.
 */
function answer(d: Db, st: Study, ver: RulebookVersionDto, itemId: string, raw: unknown, at = now()): Res {
  if (ver.status !== "draft" || !ver.rulebook) return err(409, `Version ${ver.version} is ${ver.status}; only a draft takes answers.`);
  const draft = { ...ver, rulebook: upgradeRulebook(ver.rulebook) };
  const r = answerQuestion(draft, itemId, raw, { isoDate, now: at });
  if ("refusal" in r) return err(r.refusal.status, r.refusal.message);
  if (r.unchanged) return ok(view(ver));
  // a question asked next keeps its right answer on the "server side", as every sample question does
  const ask = (p: string, id: string, reason: string) => {
    const x = askAbout(draft.rulebook, draft.evidence, p, id, reason);
    d.secrets[`${st.id}/${ver.version}/${id}`] = toSecret(x);
    return toItem(x);
  };
  followUps(draft, r, mockChecks, ask);
  Object.assign(ver, { rulebook: draft.rulebook, review: draft.review, evidence: draft.evidence, editors: draft.editors, appliesFrom: appliesFromOf(draft.rulebook), updatedAt: touched(ver.updatedAt, at) });
  st.updatedAt = at;
  log(d, r.log.by, st.id, r.log.action, r.log.detail, at);
  if (r.incident) {
    log(d, r.log.by, st.id, "sample.missed", r.incident.detail, at);
    raiseAlert(d, { kind: "sample_missed", studyId: st.id, version: ver.version, by: r.log.by, count: r.incident.count, note: null, at });
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
    appliesFrom: shownAppliesFrom(ver),
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
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.sendBack));
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
  ver.updatedAt = touched(ver.updatedAt, at);
  st.updatedAt = at;
  log(d, by, st.id, "review.sent_back", { version: ver.version, questions: items.length, itemIds: items.map((i) => i!.id), note }, at);
  raiseAlert(d, { kind: "sent_back", studyId: st.id, version: ver.version, by, count: items.length, note, at });
  return ok(view(ver));
}

/** POST .../proofread: values that looked right. Any version with a master, live ones too: the marks never change its numbers. */
function proofread(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown, at = now()): Res {
  const parsed = ProofreadBody.safeParse(raw);
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.proofread));
  if (!ver.rulebook || ver.status === "superseded") return err(409, `Version ${ver.version} can't be proofread.`);
  const { paths, by } = parsed.data;
  if (paths.some((p) => getAt(ver.rulebook, p) === undefined)) return err(400, "One of those values isn't in the invoicing master.");
  const marks = proofreadMarks(ver.proofread ?? [], paths, by, at);
  // marked by them already: nothing changes, nothing is logged (as the API)
  if (!marks) return ok(view(ver));
  ver.proofread = marks;
  ver.updatedAt = touched(ver.updatedAt, at);
  log(d, by, st.id, "values.proofread", { version: ver.version, values: paths.length }, at);
  return ok(view(ver));
}

// ---------------------------------------------------------------- "This looks wrong" and typing by hand


function addQuestion(d: Db, ver: RulebookVersionDto, x: Spec) {
  ver.review.push(toItem(x));
  d.secrets[`${ver.studyId}/${ver.version}/${x.id}`] = toSecret(x);
}

/**
 * POST .../report. On a draft (one typed by hand once typing is marked done): a blocking blind question about the value.
 * On the live version: a correction draft (a copy of it plus that question); the live version stays live until the
 * draft is approved.
 */
function report(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown): Res {
  const parsed = ReportValueBody.safeParse(raw);
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.report));
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
  } else if (ver.status !== "draft") return err(409, `Version ${ver.version} is ${ver.status}; report a value on the live version or a draft.`);
  else if (ver.byHand && !ver.review.length) return err(409, "Typing isn't marked done yet: change the value in the form instead.");
  if (withheldPaths(draft).includes(path)) return err(409, "There's already an open question about this value.");
  const x = askAbout(draft.rulebook!, draft.evidence, path, `reported:${draft.review.length + 1}`, "reported");
  addQuestion(d, draft, x);
  // the note goes with the question, so whoever answers it sees why (its numbers blanked until it's settled)
  draft.review.at(-1)!.reported = { by, note, at: now() };
  draft.updatedAt = touched(draft.updatedAt);
  st.updatedAt = now();
  const value = getAt(draft.rulebook!, path);
  log(d, by, st.id, typeof value === "number" ? "number.reported" : "value.reported", { version: draft.version, path, value: labelFor(draft.rulebook, path), note });
  return ok(view(draft));
}

/** POST /studies/:id/versions/by-hand: a blank draft for a contract that couldn't be read. */
function startByHand(d: Db, st: Study, raw: unknown): Res {
  const parsed = ByHandBody.safeParse(raw);
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.byHand));
  const vs = versionsOf(d, st.id);
  const newest = vs.at(-1);
  if (newest && (newest.status === "draft" || newest.status === "extracting")) return err(409, `Version ${newest.version} is already in progress.`);
  const docs = d.documents.filter((x) => st.documentIds.includes(x.id)).map((x) => ({ id: x.id, kind: x.kind, title: x.filename.replace(/\.pdf$/i, ""), date: null }));
  const ver = newVersion(st.id, (newest?.version ?? 0) + (newest?.status === "failed" ? 0 : 1), "draft");
  const rulebook = blankRulebook(docs, { sponsor: st.sponsor ?? "", protocol: st.protocol ?? "", site: st.siteName ?? "", pi: st.investigator ?? "" });
  Object.assign(ver, { byHand: true, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, rulebook, appliesFrom: appliesFromOf(rulebook) });
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
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.values));
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
  ver.appliesFrom = appliesFromOf(rb);
  ver.updatedAt = touched(ver.updatedAt);
  if (!ver.editors.some((e) => samePerson(e, by))) ver.editors.push(by);
  st.updatedAt = now();
  if (leaf(value)) log(d, by, st.id, "value.typed", { version: ver.version, path, value: labelFor(rb, path), before: before ?? null, after: value });
  return ok(view(ver));
}

/**
 * POST .../by-hand/done, by the API's own rules (typingDone, @dct/shared): someone else re-types up to 10 typed values
 * drawn at random, blind; the checks (the sample server's own) run on what was typed; and everything nobody typed or
 * picked is asked as missing. Each question keeps its right answer on the "server side": a re-typed value's own.
 */
function finishByHand(d: Db, st: Study, ver: RulebookVersionDto, raw: unknown): Res {
  const parsed = ByHandBody.safeParse(raw);
  if (!parsed.success) return err(400, bodyProblem(parsed.error, BODY_WORDS.byHand));
  const rb = ver.rulebook && upgradeRulebook(ver.rulebook);
  const done = typingDone({ ...ver, rulebook: rb }, { random: mockSampling.random, checks: mockChecks });
  if ("refusal" in done) return err(done.refusal.status, done.refusal.message);
  ver.review = done.review;
  ver.anomalies = done.anomalies;
  for (const i of done.review) d.secrets[`${ver.studyId}/${ver.version}/${i.id}`] = { truth: i.reason === "spot_check" && i.path ? getAt(rb, i.path) : undefined, lines: [] };
  ver.updatedAt = touched(ver.updatedAt);
  st.updatedAt = now();
  log(d, parsed.data.by, st.id, "byhand.done", done.detail);
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
/** Test seam: the sample server's network delay, least and most ms. None under vitest, where it was most of the web suite's time. */
export const mockLatency: { ms: [number, number] } = { ms: process.env.NODE_ENV === "test" ? [0, 0] : [120, 300] };

/** Idempotency-Key → the request it came with and the response it got, as the API keeps them (in memory here). */
const replays = new Map<string, { request: string; res: Res }>();

export async function mockRequest(method: string, fullPath: string, body: unknown, key?: string): Promise<Res> {
  const [least, most] = mockLatency.ms;
  if (most) await sleep(least + Math.random() * (most - least));
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
    // as the real API: never a value withheld for a blind answer (searchVersion, @dct/shared)
    return ok({ q, hits: ver.rulebook ? searchVersion({ ...ver, rulebook: upgradeRulebook(ver.rulebook) }, q) : [] });
  }
  if (vrest === "/diff" && method === "GET") {
    // as the real API: its refusals, and its blind diff (versionDiff, @dct/shared)
    const against = query.get("against");
    if (!against) return err(400, "Query parameter `against` (version number) is required");
    if (!/^[1-9]\d{0,8}$/.test(against)) return err(400, `Invalid version "${against}"`);
    const other = d.versions.find((v) => v.studyId === st.id && v.version === Number(against));
    if (!other) return err(404, `Version ${against} of study ${st.id} not found`);
    const diff = versionDiff(other, ver);
    return "refusal" in diff ? err(diff.refusal.status, diff.refusal.message) : ok(diff);
  }
  if ((r = /^\/review\/([^/]+)$/.exec(vrest)) && method === "POST") return answer(d, st, ver, decodeURIComponent(r[1]!), body);
  if (vrest === "/report" && method === "POST") return report(d, st, ver, body);
  if (vrest === "/proofread" && method === "POST") return proofread(d, st, ver, body);
  if (vrest === "/send-back" && method === "POST") return sendBack(d, st, ver, body);
  if (vrest === "/values" && method === "PATCH") return typeValue(d, st, ver, body);
  if (vrest === "/by-hand/done" && method === "POST") return finishByHand(d, st, ver, body);
  if (vrest === "/sign-off" && method === "POST") {
    // the API's gate (signOffRefusal): as seen (asOf), typing re-typed, every question settled, every number backed, a
    // missed sample's kind of value proofread, then maker-checker
    const parsed = SignOffBody.safeParse(body);
    if (!parsed.success) return err(400, pretty(parsed.error));
    const { by, asOf } = parsed.data;
    const refusal = signOffRefusal(ver, { asOf, by, makerChecker: d.settings.makerChecker });
    if (refusal) return err(409, refusal);
    for (const v of versionsOf(d, st.id)) if (v.status === "signed") v.status = "superseded";
    Object.assign(ver, { status: "signed", signedBy: by, signedAt: now(), updatedAt: touched(ver.updatedAt) });
    st.status = "live";
    st.updatedAt = now();
    log(d, by, st.id, "version.signed", { version: ver.version, ...(b.note ? { note: b.note } : {}), appliesFrom: ver.appliesFrom });
    return ok(view(ver));
  }
  return err(404, `No mock route for ${method} ${path}`);
}
