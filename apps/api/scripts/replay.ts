/**
 * The measurement bench: everything after the AI read, re-run on saved real reads. No AI, no database, no server.
 *
 *   pnpm --filter @dct/api exec tsx scripts/replay.ts [MK CBT EFC …] [--solver strict|guide] [--json <file>]
 *   pnpm --filter @dct/api exec tsx scripts/replay.ts --diff <a.json> <b.json>       (paths from apps/api)
 *   In a worktree, set DCT_ROOT to the main checkout (a worktree has no data/). Baseline: data/replays/baseline-2026-11-02.json
 *
 * Each study is a folder `data/replays/<S>/` (under DCT_ROOT, else this repo): `version.json` (the version DTO as the API
 * returned it after the read, unanswered), `study.json`, `manifest.json` (each documentId → its PDF, checked by sha256, with
 * our OCR's cache beside it, so no page is OCR'd again), and optionally `data/keys/<S>.json` (a superbill typed as a key).
 *
 * It rebuilds what jobs.ts passes to runContractChecks and reviewDraft from what the DTO keeps:
 * - pages: the PDFs' text read again through readTextLayer (OCR cache), as jobs.ts does;
 * - the excluded pages: parsed back from the `pages_excluded` warning's words (excludedPagesWords);
 * - the contract checks re-run (runContractChecks), with each page's printed amounts read again (pageText, printedAmounts),
 *   every page readable (no UNREADABLE_PAGE was stored), and the read's notes rebuilt from the stored AMBIGUOUS_TERM and
 *   RETROACTIVE_NO_DATE anomalies they made. AI_DISAGREEMENT needs the cross-read, which no DTO keeps: kept as stored;
 * - amendment: a document of kind amendment, or an earlier signed version; solver mode `strict` (the API's default).
 * Not recoverable from a DTO: the grid read's `printedRows` (printed quantities and row totals), the token map's `anchors`
 * and `nonFee` (off by default), the cross-read, and the corrections an amendment carries (none: all three are version 1).
 * The rulebook is the read's, fixed: a change before or inside the read (the scrubber, the prompts, gridtext) can't be
 * replayed; `redacted` counts what the scrubber already took out of it.
 *
 * Prints counts only, and JSON pointers in `--json`: never contract text, names or amounts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { besideOnLine, bindEvidence, gateSweep, lastSigned, type PageInfo, readTextLayer, reviewFromEvidence, runContractChecks, solveGrids, type SolverMode, type TextPage } from "@dct/extraction";
import {
  appliesFromOf,
  budgetCheck,
  type ContractAnomaly,
  EXCLUDED_PAGE_KINDS,
  excludedPagesWords,
  openCards,
  openItems,
  type ReviewItem,
  type Rulebook,
  type RulebookVersionDto,
  suggest,
  upgradeRulebook,
  type ValueEvidence,
} from "@dct/shared";
import { readSheets } from "@dct/shared/xlsx";
// ponytail: deep imports, scripts only; the package's index doesn't export what TEXT_LAYER_MISMATCH reads
import { printedAmounts } from "../../../packages/extraction/src/checks";
import { pageText } from "../../../packages/extraction/src/render";
import { reviewDraft, sampling } from "../src/review.js";

const ROOT = process.env.DCT_ROOT ?? path.resolve(import.meta.dirname, "../../..");
const at = (...p: string[]) => path.join(ROOT, "data", ...p);
const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const tally = (xs: string[]) => Object.fromEntries(Object.entries(xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).sort(([a], [b]) => a.localeCompare(b)));

type Manifest = { study: string; documents: { documentId: string; filename: string; kind: string | null; sha256: string; path: string }[]; gridKeys?: { golden?: string; xlsx?: string } };
type Study = { versions?: { version: number; status: string }[] };
/** A superbill typed as a key: amounts in cents (null: billed at actual cost or by invoice), terms as the master holds them. */
type Key = {
  provisional: string;
  items: { name: string; amountCents: number | null; unit: string; notes?: string }[];
  terms: { netDays?: number; overheadPct?: number; holdbackPct?: number | null; paymentFrequency?: string; effectiveDate?: string };
};

// ---------- inputs a DTO doesn't keep, rebuilt ----------

/** The excluded pages, back from the words the `pages_excluded` warning was shown in (excludedPagesWords). */
function excludedOf(warnings: string[], docs: Manifest["documents"]): { documentId: string; page: number; kind: string }[] {
  // what each kind is called in those words, taken from the function itself so a rewording can't drift from it
  const kindOf = new Map(EXCLUDED_PAGE_KINDS.map((kind) => [/\(([^)]+)\)/.exec(excludedPagesWords([{ filename: "f", page: 1, kind }]))![1]!, kind]));
  const out: { documentId: string; page: number; kind: string }[] = [];
  for (const w of warnings.filter((x) => x.startsWith(excludedPagesWords([]).slice(0, 40))))
    for (const [, runs, filename, what] of w.matchAll(/pages? ([\d–, ]+) of “([^”]+)” \(([^)]+)\)/g)) {
      const doc = docs.find((d) => d.filename === filename);
      const kind = kindOf.get(what!);
      if (!doc || !kind) throw new Error("an excluded-pages warning names a document or kind the manifest doesn't have");
      for (const run of runs!.split(", ")) {
        const [a, b = a] = run.split("–").map(Number);
        for (let p = a!; p <= b!; p++) out.push({ documentId: doc.documentId, page: p, kind });
      }
    }
  return out;
}

/** The read's notes, from the anomalies they made (runContractChecks: AMBIGUOUS_TERM with a topic; RETROACTIVE_NO_DATE). */
function notesOf(stored: ContractAnomaly[], rb: Rulebook) {
  const notes: NonNullable<Parameters<typeof runContractChecks>[1]>["notes"] & object = [];
  for (const a of stored) {
    if (a.code === "AMBIGUOUS_TERM" && typeof a.detail.topic === "string") notes.push({ kind: "ambiguous", topic: a.detail.topic, path: a.path, source: a.refs[0] ?? null });
    if (a.code === "RETROACTIVE_NO_DATE") {
      const own = rb.appliesFrom.prov.source;
      const other = a.refs.find((r) => !own || r.documentId !== own.documentId || r.page !== own.page) ?? null;
      // a note is needed when the quote alone wouldn't raise it, or when it added a page of its own
      if (other || !/retroactiv/i.test(own?.quote ?? "")) notes.push({ kind: "retroactive_no_date", topic: "", path: "/appliesFrom/value", source: other ?? a.refs[0] ?? null });
    }
  }
  return notes;
}

// ---------- one study ----------

async function replay(S: string, solver: SolverMode) {
  const dir = at("replays", S);
  const manifest = json<Manifest>(path.join(dir, "manifest.json"));
  const v = json<RulebookVersionDto>(path.join(dir, "version.json"));
  const study = json<Study>(path.join(dir, "study.json"));
  if (!v.rulebook) throw new Error(`${S}: the saved version has no read`);
  const docs = manifest.documents.map((d) => {
    const file = path.join(dir, d.path);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== d.sha256) throw new Error(`${S}: a PDF doesn't match its sha256 in the manifest`);
    return { id: d.documentId, filename: d.filename, path: file, kind: d.kind };
  });
  const rb = upgradeRulebook(v.rulebook);
  const pages: TextPage[] = (await Promise.all(docs.map((d) => readTextLayer(d.path, d.id, { ocr: true })))).flat();
  const excluded = excludedOf(v.warnings, manifest.documents);
  const kindAt = new Map(excluded.map((p) => [`${p.documentId}#${p.page}`, p.kind]));
  const infos: PageInfo[] = await Promise.all(
    pages.map(async (p) => {
      const printed = printedAmounts(await pageText(docs.find((d) => d.id === p.documentId)!.path, p.page));
      return { documentId: p.documentId, page: p.page, kind: (kindAt.get(`${p.documentId}#${p.page}`) ?? "terms") as PageInfo["kind"], readable: true, ...(printed && { printed }) };
    }),
  );
  const kept = v.anomalies.filter((a) => a.code === "AI_DISAGREEMENT");
  const made = runContractChecks(rb, { crossRead: null, pages: infos, notes: notesOf(v.anomalies, rb) });
  // in the order runContractChecks gives them: the cross-read's after LOW_CONFIDENCE, before TEXT_LAYER_MISMATCH
  const cut = made.findIndex((a) => a.code === "TEXT_LAYER_MISMATCH");
  const anomalies = cut < 0 ? [...made, ...kept] : [...made.slice(0, cut), ...kept, ...made.slice(cut)];
  const amendment = docs.some((d) => d.kind === "amendment") || !!study.versions?.some((x) => x.status === "signed" && x.version < v.version);
  const r = reviewDraft({ bindEvidence, reviewFromEvidence, solveGrids, gateSweep, besideOnLine, lastSigned }, rb, anomalies, pages, docs, { amendment, carried: null, excluded, solver });
  return { S, v, rb, pages, excluded, anomalies, kept: kept.length, r };
}

// ---------- counts ----------

const questionCounts = (review: ReviewItem[]) => ({
  total: review.length,
  blocking: review.filter((i) => i.blocking).length,
  // what needs you counts: questions on one quote are one card
  cards: openCards(review).length,
  byKindReason: tally(review.map((i) => `${i.kind}/${i.reason}${i.blocking ? "" : " (not blocking)"}`)),
});
const evidenceCounts = (evidence: ValueEvidence[]) => ({ total: evidence.length, byStatus: tally(evidence.map((e) => e.status)), held: evidence.filter((e) => e.held).length, blank: evidence.filter((e) => e.blank).length });
const statusOf = (evidence: ValueEvidence[]) => Object.fromEntries(evidence.map((e) => [e.path, e.status]));

/** Every string in the rulebook the scrubber cut ("[redacted]"), by pointer. */
function redacted(x: unknown, p = ""): string[] {
  if (typeof x === "string") return x.includes("[redacted]") ? [p] : [];
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, y]) => redacted(y, `${p}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  return [];
}

/** How the replay differs from what the read stored: pointers and ids only. */
function against(stored: RulebookVersionDto, review: ReviewItem[], evidence: ValueEvidence[], anomalies: ContractAnomaly[], warnings: string[]) {
  const [a, b] = [statusOf(stored.evidence), statusOf(evidence)];
  const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  const minus = <T>(x: Set<T>, y: Set<T>) => [...x].filter((k) => !y.has(k));
  const [qa, qb, aa, ab] = [ids(stored.review), ids(review), ids(stored.anomalies), ids(anomalies)];
  const [ca, cb] = [questionCounts(stored.review).byKindReason, questionCounts(review).byKindReason];
  return {
    questionCountsEqual: JSON.stringify(ca) === JSON.stringify(cb),
    questionCounts: Object.fromEntries([...new Set([...Object.keys(ca), ...Object.keys(cb)])].filter((k) => ca[k] !== cb[k]).map((k) => [k, { stored: ca[k] ?? 0, replay: cb[k] ?? 0 }])),
    questionsOnlyStored: minus(qa, qb),
    questionsOnlyReplay: minus(qb, qa),
    evidenceChanged: [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => ({ path: k, stored: a[k] ?? null, replay: b[k] ?? null })),
    anomaliesOnlyStored: minus(aa, ab),
    anomaliesOnlyReplay: minus(ab, aa),
    // the same id or pointer, any other field different (wording, options, spots, printed text): ids and pointers only
    questionsDiffer: deepDiffer(stored.review, review, (i) => i.id),
    evidenceDiffer: deepDiffer(stored.evidence, evidence, (e) => e.path),
    anomaliesDiffer: deepDiffer(stored.anomalies, anomalies, (a) => a.id),
    // what reviewDraft adds to the version's warnings (hidden text), each among the stored ones
    warningsNotStored: warnings.filter((w) => !stored.warnings.includes(w)).length,
  };
}

/** Ids of entries on both sides that aren't equal field for field, as the DTO's JSON holds them. */
function deepDiffer<T>(a: T[], b: T[], id: (x: T) => string) {
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
  const mine = new Map(b.map((x) => [id(x), x]));
  return a.filter((x) => mine.has(id(x)) && !isDeepStrictEqual(plain(x), plain(mine.get(id(x))))).map(id);
}

// ---------- the superbill key ----------

// two letters count ("EQ-5D-5L" is three words), so the little words are stop words
const STOP = new Set(["the", "and", "for", "per", "fee", "cost", "with", "included", "of", "to", "in", "at", "on", "or", "by", "an", "if"]);
const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).map((w) => w.replace(/s$/, "")).filter((w) => w.length > 1 && !STOP.has(w)));
const overlap = (a: string, b: string) => [...wordsOf(a)].filter((w) => wordsOf(b).has(w)).length;

/**
 * Each key item against the master: a value equal to its amount (or equal once the contract's overhead is applied), the
 * best-named one first, with that value's evidence and any open question on it; else a money-term question whose figures
 * include it; else missing. An item with no amount (actual cost, by invoice) is held when an item of that name has none.
 */
function coverage(key: Key, rb: Rulebook, evidence: ValueEvidence[], review: ReviewItem[]) {
  const oh = rb.overhead.pct.value;
  const money = [
    ...rb.siteFees.flatMap((f, i) => [{ path: `/siteFees/${i}/amountCents`, cents: f.amountCents, name: f.name, base: true }]),
    ...rb.invoiceables.flatMap((x, i) => [
      { path: `/invoiceables/${i}/amountCents`, cents: x.amountCents, name: x.name, base: true },
      { path: `/invoiceables/${i}/amountWithOverheadCents`, cents: x.amountWithOverheadCents, name: x.name, base: false },
      ...(x.cap.kind === "amount" ? [{ path: `/invoiceables/${i}/cap/n`, cents: x.cap.n, name: x.name, base: false }] : []),
    ]),
    ...(rb.screenFail ? [{ path: "/screenFail/amountCents", cents: rb.screenFail.amountCents, name: "screen failure", base: true }] : []),
  ];
  const asked = (p: string) => openItems(review).find((i) => i.path === p)?.reason ?? null;
  const items = key.items.map((k, index) => {
    const best = <T extends { name: string }>(xs: T[]) => xs.map((x) => ({ x, n: overlap(k.name, x.name) })).sort((a, b) => b.n - a.n)[0];
    const hit =
      k.amountCents === null
        ? best(money.filter((m) => m.cents === null && m.base && overlap(k.name, m.name) > 0).map((m) => ({ ...m, path: m.path.replace(/\/amountCents$/, ""), how: "named, no amount" })))
        : (best(money.filter((m) => m.cents === k.amountCents).map((m) => ({ ...m, how: "equal" }))) ??
          best(money.filter((m) => m.base && m.cents !== null && oh !== null && Math.round((m.cents * (100 + oh)) / 100) === k.amountCents).map((m) => ({ ...m, how: "with overhead" }))));
    if (hit) return { index, found: hit.x.how, path: hit.x.path, named: hit.n > 0, evidence: evidence.find((e) => e.path === hit.x.path)?.status ?? null, asked: asked(hit.x.path) };
    const q = k.amountCents === null ? undefined : openItems(review).find((i) => i.term?.amounts.includes(k.amountCents!));
    return { index, found: q ? "asked" : "missing", path: null, named: false, evidence: null, asked: q?.reason ?? null, question: q?.id ?? null };
  });
  // the terms, each at the pointer the master holds it
  const t = key.terms;
  const term = (name: string, want: unknown, path: string, have: unknown) => ({ term: name, found: want === have ? "equal" : have === null ? "blank" : "different", path, evidence: evidence.find((e) => e.path === path)?.status ?? null, asked: asked(path) });
  const terms = [
    ...(t.netDays !== undefined ? [term("netDays", t.netDays, "/payment/netDays/value", rb.payment.netDays.value)] : []),
    ...(t.overheadPct !== undefined ? [term("overheadPct", t.overheadPct, "/overhead/pct/value", oh)] : []),
    ...(t.holdbackPct !== undefined ? [term("holdbackPct", t.holdbackPct, "/holdback/pct", rb.holdback?.pct ?? null)] : []),
    ...(t.paymentFrequency !== undefined ? [term("paymentFrequency", t.paymentFrequency, "/payment/frequency/value", rb.payment.frequency.value)] : []),
  ];
  if (t.effectiveDate !== undefined) {
    // the date billing starts from (appliesFromOf), and whether a question on it suggests the key's date
    const qs = openItems(review).filter((i) => i.path && /^\/(?:study\/effectiveDate|appliesFrom)/.test(i.path));
    const suggested = qs.map((i) => suggest(i, { rulebook: rb, evidence })).find((s) => s && "value" in s);
    const where = rb.appliesFrom.value === null && rb.study.effectiveDate.value !== null ? "/study/effectiveDate/value" : "/appliesFrom/value";
    terms.push({ ...term("effectiveDate", t.effectiveDate, where, appliesFromOf(rb)), asked: qs.map((i) => i.reason).join(",") || null, suggestionEqual: !!suggested && "value" in suggested && suggested.value === t.effectiveDate } as ReturnType<typeof term>);
  }
  return { items, terms, summary: tally(items.map((i) => `${i.found}${i.found === "missing" || i.found === "asked" ? "" : i.named ? "" : " (amount only)"}`)) };
}

// ---------- grids against outside answers (EFC) ----------

/** Another key of the same protocol (data/golden) and the sponsor's sheet: what they can check of the read's first grid. */
async function grids(m: Manifest, rb: Rulebook) {
  const g = rb.budgetGrids[0];
  if (!g || !m.gridKeys) return null;
  const out: Record<string, unknown> = {};
  if (m.gridKeys.golden && existsSync(at(m.gridKeys.golden))) {
    const key = json<{ grids: { rows: { code: string; unitCents: number; cells: (number | null)[] }[]; visitTotals: number[] }[] }>(at(m.gridKeys.golden)).grids[0]!;
    const visits = [...g.visits].sort((a, b) => a.order - b.order);
    const cells = key.rows.flatMap((r, i) => r.cells.map((c, j) => ({ c, mine: g.procedures[i]?.cells[visits[j]!.code] ?? null })));
    out.golden = {
      rows: { key: key.rows.length, read: g.procedures.length, codesInOrder: key.rows.filter((r, i) => r.code === g.procedures[i]?.code).length },
      visits: { key: key.visitTotals.length, read: visits.length },
      // where a price is due (the protocol's schedule), and the prices themselves (a site's own budget)
      scheduleAgrees: cells.filter(({ c, mine }) => (c === null) === (mine === null)).length,
      pricesAgree: cells.filter(({ c, mine }) => c !== null && c === mine).length,
      pricedInKey: cells.filter(({ c }) => c !== null).length,
      unitPricesAgree: key.rows.filter((r, i) => r.unitCents === g.procedures[i]?.unitCents).length,
      visitTotalsAgree: key.visitTotals.filter((t, j) => t === visits[j]?.totalCents).length,
    };
  }
  if (m.gridKeys.xlsx && existsSync(path.join(at("replays", m.study), m.gridKeys.xlsx))) {
    const c = budgetCheck(rb, await readSheets(readFileSync(path.join(at("replays", m.study), m.gridKeys.xlsx))));
    out.sheet = c ? { compared: c.compared, agree: c.compared - c.differences.length, differences: c.differences.length } : "no sheet holds this grid's visits";
  }
  return out;
}

// ---------- report ----------

async function report(S: string, solver: SolverMode) {
  const { v, rb, pages, excluded, anomalies, kept, r } = await replay(S, solver);
  const keyFile = at("keys", `${S}.json`);
  const key = existsSync(keyFile) ? json<Key>(keyFile) : null;
  const manifest = json<Manifest>(at("replays", S, "manifest.json"));
  const vs = against(v, r.review, r.evidence, anomalies, r.warnings);
  return {
    study: S,
    solver,
    pages: { total: pages.length, bySource: tally(pages.map((p) => p.source)), excluded: excluded.length },
    inputs: { aiDisagreementKeptAsStored: kept, notRecoverable: ["printedRows", "anchors", "nonFee", "crossRead"] },
    questions: questionCounts(r.review),
    evidence: evidenceCounts(r.evidence),
    anomalies: { total: anomalies.length, byCode: tally(anomalies.map((a) => a.code)) },
    solverReport: r.solver ? { upgraded: r.solver.upgraded, noPage: r.solver.noPage, vetoed: r.solver.vetoed, heldWouldPass: r.solver.heldWouldPass, identities: r.solver.identities, failures: r.solver.failures.length } : null,
    sweep: r.sweep ?? null,
    warnings: r.warnings.length,
    redacted: redacted(rb).length,
    keyCoverage: key ? coverage(key, rb, r.evidence, r.review) : null,
    grids: await grids(manifest, rb),
    vsStored: vs,
    // pointers and ids only: what --diff compares
    pointers: {
      evidence: statusOf(r.evidence),
      questions: r.review.map((i) => ({ id: i.id, kind: i.kind, reason: i.reason, path: i.path, blocking: i.blocking })),
      anomalies: anomalies.map((a) => ({ id: a.id, code: a.code, path: a.path })),
      redacted: redacted(rb),
    },
  };
}
type Report = Awaited<ReturnType<typeof report>>;

function print(x: Report) {
  const line = (k: string, o: unknown) => console.log(`  ${k}: ${typeof o === "object" ? JSON.stringify(o) : String(o)}`);
  console.log(`\n== ${x.study} (solver ${x.solver})`);
  line("pages", x.pages);
  line("questions", `${x.questions.total} (${x.questions.blocking} blocking)`);
  for (const [k, n] of Object.entries(x.questions.byKindReason)) console.log(`    ${String(n).padStart(4)}  ${k}`);
  line("evidence", x.evidence);
  line("anomalies", x.anomalies);
  line("solver", x.solverReport && { upgraded: x.solverReport.upgraded, noPage: x.solverReport.noPage, vetoed: x.solverReport.vetoed, failures: x.solverReport.failures });
  line("sweep", x.sweep);
  line("redacted strings in the read", x.redacted);
  if (x.keyCoverage) {
    line("key items", x.keyCoverage.summary);
    for (const i of x.keyCoverage.items) console.log(`    key ${String(i.index).padStart(2)}: ${i.found}${i.named ? "" : i.path ? " (amount only)" : ""}${i.path ? ` ${i.path}` : ""}${i.evidence ? ` [${i.evidence}]` : ""}${i.asked ? ` asked: ${i.asked}` : ""}`);
    for (const t of x.keyCoverage.terms) line(`term ${t.term}`, t);
  }
  if (x.grids) line("grid vs outside keys", x.grids);
  const s = x.vsStored;
  const same = s.questionCountsEqual && [s.evidenceChanged, s.questionsOnlyStored, s.questionsOnlyReplay, s.anomaliesOnlyStored, s.anomaliesOnlyReplay, s.questionsDiffer, s.evidenceDiffer, s.anomaliesDiffer].every((x) => !x.length) && !s.warningsNotStored;
  line(
    "vs the stored read",
    same
      ? "SAME (every question, evidence entry and anomaly, field for field)"
      : { ...Object.fromEntries(Object.entries(s).map(([k, x]) => [k, Array.isArray(x) ? x.length : x])), questionCounts: s.questionCounts },
  );
}

/** Two --json runs: the evidence pointers whose status changed and the question counts that changed, study by study. */
function diff(a: Report[], b: Report[]) {
  for (const x of a) {
    const y = b.find((r) => r.study === x.study);
    if (!y) continue;
    console.log(`\n== ${x.study}`);
    const keys = <T extends object>(p: T, q: T) => [...new Set([...Object.keys(p), ...Object.keys(q)])] as (keyof T & string)[];
    const [ca, cb] = [x.questions.byKindReason, y.questions.byKindReason];
    console.log(`  questions: ${x.questions.total} → ${y.questions.total} (blocking ${x.questions.blocking} → ${y.questions.blocking})`);
    // a run before cards had one card per question
    console.log(`  cards (needs you): ${x.questions.cards ?? x.questions.total} → ${y.questions.cards ?? y.questions.total}`);
    for (const k of keys(ca, cb)) if (ca[k] !== cb[k]) console.log(`    ${k}: ${ca[k] ?? 0} → ${cb[k] ?? 0}`);
    const [qa, qb] = [new Set(x.pointers.questions.map((q) => q.id)), new Set(y.pointers.questions.map((q) => q.id))];
    console.log(`  question ids: ${[...qa].filter((k) => !qb.has(k)).length} gone, ${[...qb].filter((k) => !qa.has(k)).length} new`);
    const [ea, eb] = [x.pointers.evidence, y.pointers.evidence];
    const moved = keys(ea, eb).filter((k) => ea[k] !== eb[k]);
    console.log(`  evidence status changed: ${moved.length}`);
    for (const k of moved) console.log(`    ${k}: ${ea[k] ?? "none"} → ${eb[k] ?? "none"}`);
    const [aa, ab] = [x.anomalies.byCode, y.anomalies.byCode];
    for (const k of keys(aa, ab)) if (aa[k] !== ab[k]) console.log(`  anomalies ${k}: ${aa[k] ?? 0} → ${ab[k] ?? 0}`);
    if (x.redacted !== y.redacted) console.log(`  redacted: ${x.redacted} → ${y.redacted}`);
    for (const k of ["sweep", "solverReport"] as const) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) console.log(`  ${k}: ${JSON.stringify(x[k])} → ${JSON.stringify(y[k])}`);
    const [ka, kb] = [x.keyCoverage, y.keyCoverage];
    if (ka && kb) {
      for (const i of ka.items) {
        const j = kb.items[i.index];
        const was = `${i.found} ${i.path ?? ""} ${i.evidence ?? ""} ${i.asked ?? ""}`;
        const now = j ? `${j.found} ${j.path ?? ""} ${j.evidence ?? ""} ${j.asked ?? ""}` : "none";
        if (was !== now) console.log(`  key ${i.index}: ${was.trim()} → ${now.trim()}`);
      }
      for (const t of ka.terms) {
        const u = kb.terms.find((z) => z.term === t.term);
        if (JSON.stringify(t) !== JSON.stringify(u)) console.log(`  term ${t.term}: ${JSON.stringify(t)} → ${JSON.stringify(u ?? null)}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
  if (args[0] === "--diff") {
    const [a, b] = [args[1], args[2]];
    if (!a || !b) throw new Error("Usage: replay.ts --diff <a.json> <b.json>");
    return diff(json<Report[]>(a), json<Report[]>(b));
  }
  const solver = (flag("--solver") ?? "strict") as SolverMode;
  if (solver !== "strict" && solver !== "guide") throw new Error("--solver is strict or guide");
  const studies = args.filter((x, i) => !x.startsWith("--") && !["--json", "--solver"].includes(args[i - 1] ?? ""));
  // a table check's two columns are drawn at random; pinned, so two runs ask the same columns
  sampling.random = () => 1 - 2 ** -32;
  const out: Report[] = [];
  for (const S of studies.length ? studies : ["MK", "CBT", "EFC"]) {
    out.push(await report(S, solver));
    print(out.at(-1)!);
  }
  const file = flag("--json");
  if (file) writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
}

main().then(
  () => process.exit(0), // the PDF reader's worker would keep the process open
  (err: unknown) => {
    // the error's own words for our errors; a file error's code only (its message carries a path)
    console.error(`replay failed: ${err instanceof Error && !/ENOENT|EACCES/.test(err.message) ? err.message : ((err as { code?: string }).code ?? "unknown error")}`);
    process.exit(1);
  },
);
