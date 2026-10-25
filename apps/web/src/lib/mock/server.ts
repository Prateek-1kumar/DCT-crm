import type {
  AuditEntryDto,
  ContractAnomaly,
  DiffEntry,
  DocumentDto,
  DocumentKind,
  JobDto,
  Rulebook,
  RulebookVersionDto,
  SettingsDto,
  StudyDetailDto,
  StudyStatus,
  StudySummaryDto,
} from "@dct/shared";
import { formatValue, ENUM_OPTIONS } from "../format";
import { findProv, getAt, segments, setAt } from "../pointer";
import { amendRulebook, anomaly, blankRulebook, makeRulebook, PEOPLE, refsOf, SEEDS } from "./fixtures";

/**
 * In-browser implementation of the PHASE-1.md HTTP API (NEXT_PUBLIC_API_MOCK=1).
 * State lives in memory and is mirrored to localStorage so reloads keep the demo going.
 */

type Study = { id: string; sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null; status: StudyStatus; updatedAt: string; documentIds: string[] };
type Job = { id: string; kind: "identify" | "extract"; studyId: string; version: number | null; startedAt: number; durationMs: number; fail: boolean; applied: boolean };
type Db = { studies: Study[]; documents: DocumentDto[]; versions: RulebookVersionDto[]; jobs: Job[]; audit: AuditEntryDto[]; settings: SettingsDto; seq: number };

const KEY = "dct.mockdb.v1";
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

function seed(): Db {
  const d: Db = { studies: [], documents: [], versions: [], jobs: [], audit: [], settings: { makerChecker: false, people: [...PEOPLE] }, seq: 100 };
  const kinds: Record<string, DocumentKind> = { "doc-hal-am1": "amendment", "doc-sl-wo": "work_order" };

  for (const sd of Object.values(SEEDS)) {
    for (const [id, [filename, pageCount]] of Object.entries(sd.files)) {
      const kind = kinds[id] ?? sd.cfg?.docs.find((x) => x.id === id)?.kind ?? "other";
      d.documents.push({ id, filename, sha256: fakeSha(id), kind, pageCount, uploadedAt: daysAgo(30), duplicateOf: null });
    }
  }
  const version = (studyId: string, v: number, status: RulebookVersionDto["status"], rulebook: Rulebook | null, anomalies: ContractAnomaly[], extra: Partial<RulebookVersionDto> = {}): RulebookVersionDto => ({
    studyId, version: v, status, rulebook, anomalies, createdAt: daysAgo(10), signedBy: null, signedAt: null, appliesFrom: rulebook?.appliesFrom.value ?? null, editors: [],
    cost: { usd: 2.84, inputTokens: 182_400, outputTokens: 21_900 }, ...extra,
  });
  const study = (id: string, c: { sponsor: string; protocol: string; site: string; pi: string }, status: StudyStatus, docs: string[], updatedAt: string): Study =>
    ({ id, sponsor: c.sponsor, protocol: c.protocol, siteName: c.site, investigator: c.pi, status, updatedAt, documentIds: docs });

  // Halcyon: live v1 + amendment v2 in review (diff).
  {
    const sd = SEEDS.halcyon;
    const cfg = sd.cfg!;
    const v1 = makeRulebook(cfg);
    const am = amendRulebook(v1, { id: "doc-hal-am1", kind: "amendment", title: "Amendment 1 to CTA HAL-2207", date: "2026-09-30" });
    d.studies.push(study(sd.id, cfg, "amendment_in_review", ["doc-hal-cta", "doc-hal-am1"], daysAgo(2)));
    const settled = { kind: "accepted_with_note" as const, note: "ET is billed per occurrence as invoiceable; matches §4.4.", by: "Avery Chen", at: daysAgo(41) };
    d.versions.push(version(sd.id, 1, "signed", v1, [{ ...anomaly("AMBIGUOUS_TERM", "info", "Early termination procedures marked 'as performed'; treated as invoiceable.", "/budgetGrids/0/visits/6", refsOf(v1.budgetGrids[0]!.prov)), resolution: settled }], { createdAt: daysAgo(44), signedBy: "Avery Chen", signedAt: daysAgo(40) }));
    d.versions.push(version(sd.id, 2, "draft", am.rulebook, am.anomalies, { createdAt: daysAgo(2) }));
  }

  // Northwind: draft with conflicting grids, overhead label, missing master, AI disagreements.
  {
    const sd = SEEDS.northwind;
    const cfg = sd.cfg!;
    const rb = makeRulebook(cfg);
    rb.payment.netDays.prov = { ...rb.payment.netDays.prov, crossCheck: "disagree", confidence: 0.74 };
    rb.invoiceables[0]!.prov = { ...rb.invoiceables[0]!.prov, crossCheck: "disagree", confidence: 0.81 };
    rb.payment.invoiceAddress.prov = { ...rb.payment.invoiceAddress.prov, confidence: 0.58 };
    const bad = rb.budgetGrids[1]!.visits[3]!;
    const expected = bad.totalCents;
    bad.totalCents += 100; // printed total off by $1.00
    const [ga, gb] = rb.budgetGrids;
    d.studies.push(study(sd.id, cfg, "needs_review", ["doc-nw-wo", "doc-nw-bud"], daysAgo(6)));
    d.versions.push(version(sd.id, 1, "draft", rb, [
      anomaly("GRID_CONFLICT", "blocker", "Exhibit A and Attachment 2 both price the whole study and disagree on 4 procedures. Choose the governing grid.", "/budgetGrids", [ga!.prov.source!, gb!.prov.source!], { gridIds: [ga!.id, gb!.id] }),
      anomaly("VISIT_TOTAL_MISMATCH", "blocker", "Attachment 2, Week 12: printed total is $1.00 more than its lines add up to.", "/budgetGrids/1/visits/3/totalCents", refsOf(bad.prov), { expected, actual: bad.totalCents }),
      anomaly("OVERHEAD_LABEL_MISMATCH", "warning", "Exhibit A says 35% overhead, but the visit math works out to 25%.", "/budgetGrids/0/statedOverheadPct", refsOf(ga!.prov), { stated: 35, computed: 25 }),
      anomaly("MISSING_REFERENCED_DOC", "warning", "Work order refers to the Master Clinical Trial Agreement (12 Mar 2024), which wasn't uploaded. Terms that depend on it are marked unverified.", "/referencedDocuments/0", refsOf(rb.referencedDocuments[0]!.prov)),
      anomaly("AI_DISAGREEMENT", "warning", "Net payment days: Claude read 45, OpenAI read 60.", "/payment/netDays/value", refsOf(rb.payment.netDays.prov), { claude: 45, openai: 60 }),
      anomaly("AI_DISAGREEMENT", "warning", "Unscheduled visit (with overhead): the two reads differ.", "/invoiceables/0/amountWithOverheadCents", refsOf(rb.invoiceables[0]!.prov), { claude: 80000, openai: 77200 }),
      anomaly("LOW_CONFIDENCE", "info", "Invoice address was hard to read (58% confidence).", "/payment/invoiceAddress/value", refsOf(rb.payment.invoiceAddress.prov), { confidence: 0.58 }),
    ], { createdAt: daysAgo(6) }));
  }

  // Cobalt: two arms; Arm B header names another PI/site; duplicate item.
  {
    const sd = SEEDS.cobalt;
    const cfg = sd.cfg!;
    const rb = makeRulebook(cfg);
    rb.screenFail!.prov = { ...rb.screenFail!.prov, crossCheck: "disagree", confidence: 0.83 };
    d.studies.push(study(sd.id, cfg, "needs_review", ["doc-cb-cta"], daysAgo(3)));
    const ai = anomaly("AI_DISAGREEMENT", "warning", "Screen-fail amount: Claude read $610.00, OpenAI read $660.00.", "/screenFail/amountCents", refsOf(rb.screenFail!.prov), { claude: 61000, openai: 66000 });
    ai.resolution = { kind: "chosen", note: "Exhibit A §5 clearly says $610.00.", by: "Jordan Patel", at: daysAgo(1) };
    d.versions.push(version(sd.id, 1, "draft", rb, [
      anomaly("HEADER_MISMATCH", "blocker", "Arm B grid header names Dr. Owen Pratt at DCT Eastfield; the contract is with Dr. Lena Ortiz at DCT Northgate.", "/budgetGrids/1/header", refsOf(rb.budgetGrids[1]!.prov), { grid: rb.budgetGrids[1]!.header, contract: { investigator: cfg.pi, siteName: cfg.site } }),
      anomaly("DUPLICATE_ITEM", "warning", "Central lab kit processing is paid inside visits and also listed as an invoiceable.", "/invoiceables/2", [...refsOf(rb.invoiceables[2]!.prov), ...refsOf(rb.budgetGrids[0]!.procedures[6]!.prov)]),
      ai,
    ], { createdAt: daysAgo(3), editors: [] }));
  }

  // Meridian: live, clean.
  {
    const sd = SEEDS.meridian;
    const cfg = sd.cfg!;
    d.studies.push(study(sd.id, cfg, "live", ["doc-mx-msa", "doc-mx-wo"], daysAgo(21)));
    d.versions.push(version(sd.id, 1, "signed", makeRulebook(cfg), [], { createdAt: daysAgo(25), signedBy: "Sam Rivera", signedAt: daysAgo(21) }));
  }

  // Solace: extraction failed.
  {
    const id = SEEDS.solace.id;
    d.studies.push(study(id, { sponsor: "Solace Bio", protocol: "SLB-102", site: "DCT Lakeshore", pi: "Dr. Priya Raman" }, "extraction_failed", ["doc-sl-wo"], daysAgo(1)));
    d.versions.push(version(id, 1, "failed", null, [], { createdAt: daysAgo(1) }));
    d.jobs.push({ id: "job-solace-1", kind: "extract", studyId: id, version: 1, startedAt: Date.now() - 86_400_000, durationMs: 1000, fail: true, applied: true });
  }

  const log = (at: string, by: string, studyId: string | null, action: string, detail: Record<string, unknown>) =>
    d.audit.push({ id: `au-${d.audit.length + 1}`, at, by, studyId, action, detail });
  log(daysAgo(44), "Avery Chen", "st-halcyon", "study.created", { documents: 1 });
  log(daysAgo(41), "Avery Chen", "st-halcyon", "anomaly.resolved", { version: 1, anomaly: "AMBIGUOUS_TERM", kind: "accepted_with_note", note: "ET is billed per occurrence as invoiceable; matches §4.4." });
  log(daysAgo(40), "Avery Chen", "st-halcyon", "version.signed", { version: 1 });
  log(daysAgo(21), "Sam Rivera", "st-meridian", "version.signed", { version: 1 });
  log(daysAgo(2), "Taylor Brooks", "st-halcyon", "amendment.uploaded", { document: "HAL-2207_Amendment-1.pdf", version: 2 });
  log(daysAgo(1), "Jordan Patel", "st-cobalt", "anomaly.resolved", { version: 1, anomaly: "AI_DISAGREEMENT", kind: "chosen", note: "Exhibit A §5 clearly says $610.00." });
  log(daysAgo(1), "system", "st-solace", "extraction.failed", { version: 1, error: "Pages 3–7 unreadable (scan too faint)" });
  return d;
}

// ---------------------------------------------------------------- jobs

const EXTRACT_STEPS: [number, string][] = [
  [0, "Queued"],
  [5, "Splitting PDFs into pages"],
  [15, "Reading contract terms (Claude)"],
  [40, "Extracting the procedure × visit grid"],
  [62, "Independent second read (OpenAI)"],
  [84, "Running contract checks"],
  [100, "Done"],
];
const IDENTIFY_STEPS: [number, string][] = [
  [0, "Queued"],
  [10, "Reading cover pages"],
  [45, "Sorting documents by kind"],
  [80, "Suggesting study details"],
  [100, "Done"],
];

function jobView(j: Job): JobDto {
  const p = Math.min(100, Math.floor(((Date.now() - j.startedAt) / j.durationMs) * 100));
  const failAt = 55;
  if (j.fail && p >= failAt) return { id: j.id, state: "failed", progress: failAt, step: "Reading contract terms (Claude)", error: "Pages 3–7 couldn't be read (scan too faint). Retry, or enter the terms manually." };
  const steps = j.kind === "extract" ? EXTRACT_STEPS : IDENTIFY_STEPS;
  const step = [...steps].reverse().find(([t]) => p >= t)![1];
  return { id: j.id, state: p >= 100 ? "succeeded" : p > 2 ? "running" : "queued", progress: p, step, error: null };
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
      ver.status = "failed";
      st.status = live ? "live" : "extraction_failed";
      st.updatedAt = now();
      log(d, "system", st.id, "extraction.failed", { version: ver.version, error: v.error });
      continue;
    }
    if (live?.rulebook) {
      const am = docs.find((x) => x.kind === "amendment" && !live.rulebook!.documents.some((r) => r.id === x.id)) ?? docs[docs.length - 1]!;
      const r = amendRulebook(live.rulebook, { id: am.id, kind: am.kind, title: am.filename.replace(/\.pdf$/i, ""), date: now().slice(0, 10) });
      Object.assign(ver, { status: "draft", rulebook: r.rulebook, anomalies: r.anomalies });
      st.status = "amendment_in_review";
    } else {
      const rbDocs = docs.map((x) => ({ id: x.id, kind: x.kind, title: x.filename.replace(/\.pdf$/i, ""), date: null }));
      const terms = docs.find((x) => x.kind === "work_order") ?? docs[0]!;
      const hasMaster = docs.some((x) => x.kind === "master_agreement");
      const rb = makeRulebook({
        sponsor: st.sponsor ?? "Unknown sponsor", payingAgent: null, protocol: st.protocol ?? "—", site: st.siteName ?? "—", pi: st.investigator ?? "—",
        effectiveDate: now().slice(0, 10), termsDoc: terms.id, docs: rbDocs,
        grids: [{ id: `g-${st.id}`, label: "Exhibit A – Budget", arm: null, docId: terms.id, page: Math.min(9, terms.pageCount), overheadPct: 30 }],
        ...(hasMaster ? {} : { missingMaster: { description: "Master Clinical Trial Agreement", date: "2024-01-15" } }),
      });
      // Keep every page reference inside the uploaded documents.
      clampPages(rb, docs);
      rb.payment.netDays.prov = { ...rb.payment.netDays.prov, crossCheck: "disagree", confidence: 0.76 };
      const anomalies = [
        anomaly("AI_DISAGREEMENT", "warning", "Net payment days: Claude read 45, OpenAI read 30.", "/payment/netDays/value", refsOf(rb.payment.netDays.prov), { claude: 45, openai: 30 }),
        anomaly("LOW_CONFIDENCE", "info", "Spirometry unit price was hard to read (71% confidence).", "/budgetGrids/0/procedures/3/unitCents", refsOf(rb.budgetGrids[0]!.procedures[3]!.prov), { confidence: 0.71 }),
      ];
      if (!hasMaster) anomalies.unshift(anomaly("MISSING_REFERENCED_DOC", "warning", "The work order refers to a Master Clinical Trial Agreement that wasn't uploaded. Dependent terms are marked unverified.", "/referencedDocuments/0", refsOf(rb.referencedDocuments[0]!.prov)));
      Object.assign(ver, { status: "draft", rulebook: rb, anomalies, appliesFrom: null });
      st.status = "needs_review";
    }
    st.updatedAt = now();
    log(d, "system", st.id, "extraction.succeeded", { version: ver.version, anomalies: ver.anomalies.length });
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

function log(d: Db, by: string, studyId: string | null, action: string, detail: Record<string, unknown>) {
  d.audit.push({ id: `au-${++d.seq}`, at: now(), by, studyId, action, detail });
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
    openAnomalies: draft ? draft.anomalies.filter((a) => !a.resolution).length : 0,
    updatedAt: s.updatedAt,
  };
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

const TOP: Record<string, string> = {
  study: "Study", payment: "Payment", overhead: "Overhead", budgetGrids: "Budget grid", invoiceables: "Invoiceable", siteFees: "Site fee",
  deadlines: "Deadline", screenFail: "Screen fail", holdback: "Holdback", overpayment: "Overpayment", rounding: "Rounding",
  appliesFrom: "Applies from", documents: "Document", referencedDocuments: "Referenced document", governingGridId: "Governing grid",
};
const humanize = (k: string) => k.replace(/Cents$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (m) => m.toLowerCase());

export function labelFor(path: string, rb: unknown): string {
  const segs = segments(path);
  const parts: string[] = [];
  let cur: unknown = rb;
  segs.forEach((seg, i) => {
    cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
    if (seg === "value" || seg === "cells") return;
    if (i === 0) return parts.push(TOP[seg] ?? humanize(seg));
    if (/^\d+$/.test(seg)) {
      const o = (cur ?? {}) as Record<string, unknown>;
      const kindLabel = typeof o.kind === "string" ? ENUM_OPTIONS.kind?.[o.kind] : undefined;
      const name = o.name ?? o.label ?? o.title ?? o.description ?? kindLabel ?? o.code ?? `#${Number(seg) + 1}`;
      return parts.push(String(name));
    }
    parts.push(segs[i - 1] === "cells" ? seg : humanize(seg));
  });
  return parts.join(" › ");
}

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

// ---------------------------------------------------------------- page images

const BOILER = [
  "The parties agree that the following terms govern payment for services performed under the Protocol.",
  "Amounts are stated in United States dollars and are inclusive of all applicable overhead unless noted.",
  "Institution shall maintain complete and accurate records supporting each invoice submitted hereunder.",
  "Nothing in this Exhibit shall be construed to limit the obligations set forth in the Agreement.",
  "Sponsor shall not be responsible for costs incurred prior to the Effective Date without written approval.",
];

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mockPageSrc(docId: string, page: number): string {
  const d = load();
  const doc = d.documents.find((x) => x.id === docId);
  const st = d.studies.find((s) => s.documentIds.includes(docId));
  const ver = st && [...versionsOf(d, st.id)].reverse().find((v) => v.rulebook);
  const facts: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    const prov = r.prov as { source: { documentId: string; page: number; location?: string; quote?: string } | null } | undefined;
    if (prov?.source?.documentId === docId && prov.source.page === page) {
      const v = "value" in r ? r.value : r;
      facts.push(`${prov.source.location ?? labelFor(path, ver?.rulebook)}: ${prov.source.quote ? `“${prov.source.quote}” — ` : ""}${formatValue(path + ("value" in r ? "/value" : ""), v)}`);
    }
    for (const [k, v] of Object.entries(r)) if (k !== "prov") walk(v, `${path}/${k}`);
  };
  walk(ver?.rulebook, "");
  const lines: { t: string; bold?: boolean }[] = [];
  lines.push({ t: doc ? doc.filename.replace(/\.pdf$/i, "") : docId, bold: true });
  lines.push({ t: "" });
  BOILER.slice(0, 2 + (page % 3)).forEach((t) => lines.push({ t }));
  lines.push({ t: "" });
  for (const f of [...new Set(facts)].slice(0, 26)) lines.push({ t: f, bold: true });
  if (!facts.length) BOILER.slice(2).forEach((t) => lines.push({ t }));
  const wrap = (t: string) => t.match(/.{1,92}(\s|$)/g) ?? [t];
  let y = 120;
  const text = lines
    .flatMap((l) => wrap(l.t || " ").map((t) => ({ t, bold: l.bold })))
    .map((l) => `<text x="70" y="${(y += 26)}" font-weight="${l.bold ? 600 : 400}">${esc(l.t.trim())}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100" viewBox="0 0 850 1100">
<rect width="850" height="1100" fill="#fbfaf7"/>
<text x="70" y="70" font-family="Georgia,serif" font-size="13" fill="#666">SYNTHETIC DEMO PAGE — not a real contract</text>
<text x="780" y="70" text-anchor="end" font-family="Georgia,serif" font-size="13" fill="#666">Page ${page} of ${doc?.pageCount ?? "?"}</text>
<line x1="70" y1="88" x2="780" y2="88" stroke="#ccc"/>
<g font-family="Georgia,serif" font-size="15" fill="#222">${text}</g>
<text x="425" y="1060" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#888">${esc(st?.protocol ?? "")} · Confidential</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- routes

type Res = { status: number; json: unknown };
const ok = (json: unknown): Res => ({ status: 200, json });
const err = (status: number, message: string): Res => ({ status, json: { statusCode: status, error: status === 409 ? "Conflict" : "Error", message } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockRequest(method: string, fullPath: string, body: unknown): Promise<Res> {
  await sleep(120 + Math.random() * 180);
  const d = load();
  tick(d);
  const res = await route(d, method, fullPath, body);
  save();
  return res;
}

async function route(d: Db, method: string, fullPath: string, body: unknown): Promise<Res> {
  const [path, qs] = fullPath.split("?");
  const query = new URLSearchParams(qs);
  const m = (re: RegExp) => re.exec(path!);
  const b = (body ?? {}) as Record<string, unknown>;
  const by = typeof b.by === "string" ? b.by : "unknown";
  let r: RegExpExecArray | null;

  if (method === "GET" && path === "/studies") return ok(d.studies.map((s) => summary(d, s)));
  if (method === "GET" && path === "/settings") return ok(d.settings);
  if (method === "PATCH" && path === "/settings") {
    d.settings = { ...d.settings, ...(b as Partial<SettingsDto>) };
    log(d, by, null, "settings.updated", b);
    return ok(d.settings);
  }
  if (method === "GET" && path === "/audit") {
    const sid = query.get("studyId");
    return ok(d.audit.filter((a) => !sid || a.studyId === sid).sort((a, b2) => b2.at.localeCompare(a.at)));
  }
  if (method === "POST" && path === "/uploads") {
    const fd = body as FormData;
    const studyId = fd.get("studyId") as string | null;
    const uploader = (fd.get("by") as string | null) ?? "unknown";
    const out: DocumentDto[] = [];
    for (const f of fd.getAll("files[]") as File[]) {
      const sha = await sha256Hex(f);
      const existing = d.documents.find((x) => x.sha256 === sha);
      if (existing) {
        out.push({ ...existing, duplicateOf: existing.id });
        continue;
      }
      const doc: DocumentDto = { id: `doc-${++d.seq}`, filename: f.name, sha256: sha, kind: guessKind(f.name), pageCount: 4 + (parseInt(sha.slice(0, 2), 16) % 12), uploadedAt: now(), duplicateOf: null };
      d.documents.push(doc);
      out.push(doc);
      if (studyId) {
        const st = d.studies.find((s) => s.id === studyId);
        if (!st) return err(404, "Study not found");
        st.documentIds.push(doc.id);
        log(d, uploader, studyId, "document.uploaded", { document: doc.filename });
      }
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
    const before = doc.kind;
    doc.kind = b.kind as DocumentKind;
    const st = d.studies.find((s) => s.documentIds.includes(doc.id));
    log(d, by, st?.id ?? null, "document.kind_changed", { document: doc.filename, before, after: doc.kind });
    return ok(doc);
  }

  if (!(r = m(/^\/studies\/([^/]+)(\/.*)?$/))) return err(404, `No mock route for ${method} ${path}`);
  const st = d.studies.find((s) => s.id === r![1]);
  if (!st) return err(404, "Study not found");
  const rest = r[2] ?? "";

  if (rest === "" && method === "GET") return ok(detail(d, st));
  if (rest === "" && method === "PATCH") {
    for (const k of ["sponsor", "protocol", "siteName", "investigator"] as const) if (typeof b[k] === "string") st[k] = b[k] as string;
    st.updatedAt = now();
    log(d, by, st.id, "study.confirmed", { sponsor: st.sponsor, protocol: st.protocol, siteName: st.siteName, investigator: st.investigator });
    return ok(detail(d, st));
  }
  if (rest === "/extract" && method === "POST") {
    const vs = versionsOf(d, st.id);
    if (vs.some((v) => v.status === "extracting")) return err(409, "An extraction is already running for this study.");
    const version = (vs[vs.length - 1]?.version ?? 0) + 1;
    const attempts = d.jobs.filter((j) => j.studyId === st.id && j.kind === "extract").length;
    const docs = d.documents.filter((x) => st.documentIds.includes(x.id));
    const fail = attempts === 0 && docs.some((x) => /fail|unreadable/i.test(x.filename));
    d.versions.push({ studyId: st.id, version, status: "extracting", createdAt: now(), signedBy: null, signedAt: null, appliesFrom: null, rulebook: null, anomalies: [], editors: [], cost: { usd: 3.12, inputTokens: 201_300, outputTokens: 24_800 } });
    const job: Job = { id: `job-${++d.seq}`, kind: "extract", studyId: st.id, version, startedAt: Date.now(), durationMs: 7000, fail, applied: false };
    d.jobs.push(job);
    if (!latestSigned(d, st.id)) st.status = "extracting";
    st.updatedAt = now();
    log(d, by, st.id, "extraction.queued", { version });
    return ok({ jobId: job.id, version });
  }
  if (rest === "/versions" && method === "POST") {
    const vs = versionsOf(d, st.id);
    const version = (vs[vs.length - 1]?.version ?? 0) + 1;
    const docs = d.documents.filter((x) => st.documentIds.includes(x.id)).map((x) => ({ id: x.id, kind: x.kind, title: x.filename, date: null }));
    const rb = blankRulebook(docs, { sponsor: st.sponsor ?? "", protocol: st.protocol ?? "", site: st.siteName ?? "", pi: st.investigator ?? "" });
    d.versions.push({
      studyId: st.id, version, status: "draft", createdAt: now(), signedBy: null, signedAt: null, appliesFrom: null, rulebook: rb, editors: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      anomalies: [
        anomaly("REQUIRED_MISSING", "blocker", "Net payment days must be entered.", "/payment/netDays/value", []),
        anomaly("REQUIRED_MISSING", "warning", "No budget grid. Visit fees can't be checked until a grid is added.", "/budgetGrids", []),
      ],
    });
    st.status = latestSigned(d, st.id) ? "amendment_in_review" : "needs_review";
    st.updatedAt = now();
    log(d, by, st.id, "version.manual_created", { version });
    return ok({ version });
  }

  const vm = /^\/versions\/(\d+)(\/.*)?$/.exec(rest);
  if (!vm) return err(404, `No mock route for ${method} ${path}`);
  const ver = d.versions.find((v) => v.studyId === st.id && v.version === Number(vm[1]));
  if (!ver) return err(404, "Version not found");
  const vrest = vm[2] ?? "";

  if (vrest === "" && method === "GET") return ok(ver);
  if (vrest === "/diff" && method === "GET") {
    const other = d.versions.find((v) => v.studyId === st.id && v.version === Number(query.get("against")));
    if (!other) return err(404, "Version to compare against not found");
    return ok(diffRulebooks(other.rulebook, ver.rulebook));
  }

  const isDraft = ver.status === "draft";
  if (vrest === "/values" && method === "PATCH") {
    if (!isDraft || !ver.rulebook) return err(409, `Version ${ver.version} is ${ver.status}; only drafts can be corrected.`);
    const p = String(b.path);
    const before = getAt(ver.rulebook, p);
    if (before === undefined && !p.includes("/cells/")) return err(400, `Unknown path ${p}`);
    const rb = setAt(ver.rulebook, p, b.value);
    const prov = findProv(rb, p);
    if (prov) Object.assign(prov, { method: "manual", confidence: 1 });
    ver.rulebook = rb;
    if (!ver.editors.includes(by)) ver.editors.push(by);
    st.updatedAt = now();
    log(d, by, st.id, "value.corrected", { version: ver.version, path: p, label: labelFor(p, rb), before, after: b.value, note: b.note });
    return ok(ver);
  }
  if ((r = /^\/anomalies\/([^/]+)\/resolve$/.exec(vrest)) && method === "POST") {
    if (!isDraft) return err(409, `Version ${ver.version} is ${ver.status}.`);
    const a = ver.anomalies.find((x) => x.id === decodeURIComponent(r![1]!));
    if (!a) return err(404, "Anomaly not found");
    a.resolution = { kind: b.kind as "fixed", note: String(b.note), by, at: now() };
    st.updatedAt = now();
    log(d, by, st.id, "anomaly.resolved", { version: ver.version, anomaly: a.code, path: a.path, kind: b.kind, note: b.note });
    return ok(ver);
  }
  if (vrest === "/grid-choice" && method === "POST") {
    if (!isDraft || !ver.rulebook) return err(409, `Version ${ver.version} is ${ver.status}.`);
    const g = ver.rulebook.budgetGrids.find((x) => x.id === b.gridId);
    if (!g) return err(400, "Unknown grid");
    ver.rulebook.governingGridId = g.id;
    for (const a of ver.anomalies) if (a.code === "GRID_CONFLICT") a.resolution = { kind: "chosen", note: String(b.note), by, at: now() };
    log(d, by, st.id, "grid.chosen", { version: ver.version, grid: g.label, note: b.note });
    return ok(ver);
  }
  if (vrest === "/sign-off" && method === "POST") {
    if (!isDraft) return err(409, `Version ${ver.version} is ${ver.status}; only drafts can be signed off.`);
    const open = ver.anomalies.filter((a) => !a.resolution).length;
    if (open) return err(409, `${open} ${open === 1 ? "anomaly is" : "anomalies are"} still open. Settle every anomaly before signing off.`);
    if (d.settings.makerChecker && ver.editors.includes(by)) return err(409, `Maker-checker is on: ${by} corrected values in this version and can't sign it off.`);
    for (const v of versionsOf(d, st.id)) if (v.status === "signed") v.status = "superseded";
    Object.assign(ver, { status: "signed", signedBy: by, signedAt: now(), appliesFrom: ver.rulebook?.appliesFrom.value ?? null });
    st.status = "live";
    st.updatedAt = now();
    log(d, by, st.id, "version.signed", { version: ver.version, note: b.note ?? null });
    return ok(ver);
  }
  return err(404, `No mock route for ${method} ${path}`);
}
