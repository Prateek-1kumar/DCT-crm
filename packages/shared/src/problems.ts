import type { ContractAnomaly } from "./anomaly";
import { leaf } from "./blind";
import { openItems, type PageBox, type ReviewItem, settled } from "./evidence";
import { at } from "./pointer";
import { askAbout } from "./questions";
import { armKey, governingGrids, type Rulebook } from "./rulebook";

/**
 * Contract problems as questions (ADR-001 §6): one per finding of the contract checks, held back while the numbers it's
 * about are being typed, and asked on the typed numbers once they are. Pure, so the API and the in-browser sample server
 * ask the same; each passes its own checks.
 */

const BLANK = { answer: null, outcome: null, compare: null, sentBack: null } as const;
const box = (documentId: string, page: number): PageBox => ({ documentId, page, box: null });
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
const gridOf = (path: string | null) => /^\/budgetGrids\/\d+\//.exec(path ?? "")?.[0];

// The cross-read, its text-layer page check and self-reported confidence are not evidence (ADR-001 §4, §6): the binder replaces them.
const SUPERSEDED = new Set<ContractAnomaly["code"]>(["TEXT_LAYER_MISMATCH", "AI_DISAGREEMENT", "LOW_CONFIDENCE"]);
export const ARITHMETIC = new Set<string>(["VISIT_TOTAL_MISMATCH", "PER_PATIENT_TOTAL_MISMATCH"]);
const AS_PRINTED = [{ id: "as_printed", label: "Yes, go ahead as printed" }];
/** The contract itself is wrong here, so the site asks the sponsor: the note is that query. */
const SPONSOR = "What should we ask the sponsor?";
const ASK_SPONSOR = { id: "ask_sponsor", label: "Ask the sponsor; until they answer, bill it as printed", note: SPONSOR };
/** A question that's not needed to approve clears by a choice, or by one of these reasons with a note (ADR-001 §6). */
const REVIEW_REASONS = [{ id: "as_printed", label: "Bill it as the contract prints it", note: "Why is that right?" }, ASK_SPONSOR];

/**
 * One flag per root cause: a check about a value that's being typed is covered by its question, and a total that doesn't
 * add up isn't asked while a number in its grid's visits, rows or per-patient totals is being typed (its overhead % alone
 * doesn't hold it back). Held back is never dropped: recheck runs these on the typed numbers. An overhead label that
 * doesn't match what the amounts compute to is asked whatever is being typed.
 * ponytail: per grid, not per visit. Upgrade: only the visit whose numbers are asked.
 */
function heldBack(a: ContractAnomaly, asked: Set<string>): boolean {
  if (a.code === "OVERHEAD_LABEL_MISMATCH") return false;
  if (a.path && asked.has(a.path)) return true;
  const grid = gridOf(a.path);
  return ARITHMETIC.has(a.code) && !!grid && [...asked].some((p) => totalledIn(p, grid));
}
/**
 * What a grid's totals are made of: its visits', rows' and per-patient totals' values, a row's kind (procedure or not)
 * included; not its stated overhead %, nor how a visit is paid or whether a row takes overhead.
 */
const totalledIn = (path: string, grid: string) => path.startsWith(grid) && /^(visits|procedures|perPatientTotals)\//.test(path.slice(grid.length)) && !/\/(?:autopay|overheadApplied)$/.test(path);

type Visit = Rulebook["budgetGrids"][number]["visits"][number];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * What a total the contract prints should be, from the numbers it's made of: a visit's parts, a visit's grid rows (the
 * subtotal, less what isn't a procedure), or every visit for a per-patient total. undefined when it can't be worked out.
 * This is what "the sum governs" writes into the master (ARITHMETIC_MISMATCH), so billing uses it.
 */
export function sumAt(rb: Rulebook, path: string): number | undefined {
  const m = /^\/budgetGrids\/(\d+)\/(?:visits\/(\d+)\/(totalCents|procedureSubtotalCents|nonProcedureCents)|perPatientTotals\/\d+\/cents)$/.exec(path);
  const g = m ? rb.budgetGrids[Number(m[1])] : undefined;
  if (!g || !m) return undefined;
  if (!m[2]) return sum(g.visits.map((v) => v.totalCents));
  const v: Visit | undefined = g.visits[Number(m[2])];
  if (!v) return undefined;
  const cells = (cat?: "non_procedure") => sum(g.procedures.filter((p) => !cat || p.category === cat).map((p) => p.cells[v.code]).filter((c): c is number => typeof c === "number"));
  const out =
    m[3] === "totalCents" ? (v.procedureSubtotalCents === null || v.overheadCents === null ? undefined : v.procedureSubtotalCents + v.overheadCents + (v.nonProcedureCents ?? 0))
    : m[3] === "procedureSubtotalCents" ? cells() - (v.nonProcedureCents ?? 0)
    : cells("non_procedure");
  return out !== undefined && out >= 0 ? out : undefined;
}

/** "Which number governs" for a total that doesn't add up, in words for the number it's about. */
const ARITHMETIC_WORDS = (path: string) =>
  /perPatientTotals/.test(path) ? { printed: "The per-patient total as printed", sum: "The visit totals added up" }
  : /totalCents$/.test(path) ? { printed: "The visit total as printed", sum: "Its subtotal, overhead and non-procedure amounts added up" }
  : { printed: "The subtotal as printed", sum: "The grid's rows added up" };

/**
 * One question per contract problem the checks found. A blocker clears by a typed value or a pick (I6); one that's not
 * needed to approve clears by a pick or a reason from a fixed list with a note, never free text alone (ADR-001 §6).
 * Picks the API can't carry out (remove a grid, bill a duplicate one way) aren't offered.
 */
export function fromAnomalies(anomalies: ContractAnomaly[], rb: Rulebook, asked: Set<string>): ReviewItem[] {
  const chosen = governingGrids(rb);
  return anomalies.flatMap((a): ReviewItem[] => {
    if (SUPERSEDED.has(a.code) || heldBack(a, asked)) return [];
    const base = {
      ...BLANK,
      id: `anomaly:${a.id}`,
      reason: a.code,
      path: a.path,
      where: a.refs.map((r) => box(r.documentId, r.page)),
      blocking: a.severity === "blocker" || a.code === "AMBIGUOUS_TERM" || a.code === "REQUIRED_MISSING",
      input: null,
    };
    const value = a.path ? at(rb, a.path) : undefined;
    if (a.code === "GRID_CONFLICT") {
      const grids = rb.budgetGrids.filter((g) => (a.detail.gridIds as string[]).includes(g.id));
      // an arm whose choice was carried from the live version, its grids unchanged (carryGrid), isn't asked again
      if (grids.some((g) => grids.some((x) => x.id === chosen.get(armKey(g))))) return [];
      const arm = grids.find((g) => g.arm)?.arm;
      // a choice, not a value: nothing to withhold, and one question per arm
      return [{ ...base, kind: "contract_problem", path: null, question: `${arm ? `${arm}: ` : ""}${grids.map((g) => g.label).join(" and ")} price the same visits and disagree. Which one should we bill from?`, options: grids.map((g) => ({ id: g.id, label: g.label })) }];
    }
    if (a.code === "RETROACTIVE_NO_DATE")
      return [{ ...base, kind: "contract_problem", question: "The amendment says its new prices apply retroactively, but gives no start date. From what date do they apply?", input: "date", options: [] }];
    if ((a.code === "AMBIGUOUS_TERM" || a.code === "REQUIRED_MISSING") && a.path && value !== undefined && leaf(value)) {
      const q = askAbout(rb, [], a.path, base.id, a.code);
      const ambiguous = a.code === "AMBIGUOUS_TERM";
      return [{ ...q, ...base, where: base.where.length ? base.where : q.where, kind: ambiguous ? "interpretation" : "confirm_value", input: q.input, question: ambiguous ? `${sentence(a.message)} What does the contract mean?` : q.question, options: q.options.filter((o) => o.id !== "unspecified") }];
    }
    if (ARITHMETIC.has(a.code) && a.path) {
      const words = ARITHMETIC_WORDS(a.path);
      const options = [{ id: "printed", label: words.printed, note: SPONSOR }, ...(sumAt(rb, a.path) !== undefined ? [{ id: "sum", label: words.sum, note: SPONSOR }] : [])];
      // the total as it stands now: what "as printed" puts back if "the sum" is picked first
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} Which should we bill?`, options, ...(typeof value === "number" ? { asPrinted: value } : {}) }];
    }
    if (a.code === "OVERHEAD_LABEL_MISMATCH")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} Which governs?`, options: [{ id: "amounts", label: "The printed amounts: the label is wrong" }, ASK_SPONSOR] }];
    if (a.code === "MISSING_REFERENCED_DOC")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} How should we go on?`, options: [{ id: "later", label: "Go ahead; I'll upload it later" }, { id: "not_needed", label: "It doesn't affect billing", note: "Why doesn't it affect billing?" }] }];
    if (a.code === "DUPLICATE_ITEM")
      return [{ ...base, kind: "contract_problem", question: `${sentence(a.message)} How should it be billed?`, options: [{ id: "both", label: "They're different items: bill both" }, { ...ASK_SPONSOR, label: "Ask the sponsor whether it's billed twice" }] }];
    const kind = a.code === "AMBIGUOUS_TERM" ? "interpretation" : "contract_problem";
    if (!base.blocking) return [{ ...base, kind, question: `${sentence(a.message)} How should we go on?`, options: REVIEW_REASONS }];
    return [{ ...base, kind, question: `${sentence(a.message)} Go ahead with the contract as printed?`, options: AS_PRINTED }];
  });
}

/** Checks whose truth depends on numbers a person may type: held back while they're open (heldBack), then run again. */
const RECHECKED = new Set<ContractAnomaly["code"]>(["VISIT_TOTAL_MISMATCH", "PER_PATIENT_TOTAL_MISMATCH", "OVERHEAD_LABEL_MISMATCH"]);

/** Whether a settled "which should we bill" answer still says what the master holds: the sum of the parts as they are now, or the total as printed. */
function holds(rb: Rulebook, i: ReviewItem): boolean {
  const now = at(rb, i.path!);
  if (i.answer?.optionId === "sum") return now === sumAt(rb, i.path!);
  return i.answer?.optionId !== "printed" || i.asPrinted === undefined || now === i.asPrinted;
}

/**
 * The checks don't run again by themselves, so a total held back while its grid's numbers were typed would never be
 * asked. Once the last number of a grid is answered, its arithmetic checks (`checks`: the API's real ones, the sample
 * server's own) run on the typed numbers, and each finding is asked unless it's a question here already, or the read
 * found it on the same numbers and asked it then (a correction draft's checks were settled on the live version). New
 * findings (typed numbers that no longer add up) are asked too. A contract typed by hand ran its checks when typing was
 * marked done (`anomalies`), so the same holds for it.
 * A total already settled is asked again, in place (`v.review` changes), once its answer no longer holds: a number it
 * adds up from changed (the finding reads differently, or "the sum" isn't the sum any more), or another answer wrote
 * the total itself (then that answer is what's printed). Otherwise billing would take a sum of numbers since corrected.
 */
export function recheck(checks: (rb: Rulebook) => ContractAnomaly[], v: { rulebook: Rulebook; review: ReviewItem[]; anomalies: ContractAnomaly[] }, path: string): ReviewItem[] {
  const grid = gridOf(path);
  if (!grid || openItems(v.review).some((i) => i.kind === "confirm_value" && !!i.path && totalledIn(i.path, grid))) return [];
  // what the read asked: its value questions, and the checks it didn't hold back
  const readAsked = new Set(v.review.flatMap((i) => (/^(confirm|spot|missing):/.test(i.id) && i.path ? [i.path] : [])));
  const askedAtRead = new Set(v.anomalies.filter((a) => !SUPERSEDED.has(a.code) && !heldBack(a, readAsked)).map((a) => a.id));
  const read = new Map(v.anomalies.map((a) => [a.id, a.message]));
  const findings = checks(v.rulebook).filter((a) => RECHECKED.has(a.code) && gridOf(a.path) === grid);
  const now = new Map(fromAnomalies(findings, v.rulebook, new Set()).map((i) => [i.id, i]));
  for (const i of v.review) {
    if (!ARITHMETIC.has(i.reason) || !i.path || gridOf(i.path) !== grid) continue;
    const f = now.get(i.id);
    const reworded = !!f && f.question !== i.question;
    if (!settled(i)) {
      if (reworded) Object.assign(i, { question: f.question, options: f.options });
    } else if (reworded || !holds(v.rulebook, i))
      Object.assign(i, {
        question: f?.question ?? i.question,
        options: f?.options ?? i.options,
        ...(path === i.path ? { asPrinted: at(v.rulebook, path) } : {}),
        answer: null, outcome: null, compare: null, sentBack: null,
      });
  }
  const have = new Set(v.review.map((i) => i.id));
  return fromAnomalies(findings.filter((a) => !have.has(`anomaly:${a.id}`) && !(read.get(a.id) === a.message && askedAtRead.has(a.id))), v.rulebook, new Set());
}

/**
 * Two grids for one arm that price the same are billed once (billedGrids), so nothing asks which. A number written into
 * one of them later (a typed answer, a correction on the live version, a sample miss) can make them differ, and the arm
 * would bill neither: its GRID_CONFLICT (the runtime's `checks`) is asked then, unless a grid is chosen for the arm
 * (fromAnomalies) or its question is open already.
 */
export function gridConflicts(checks: (rb: Rulebook) => ContractAnomaly[], v: { rulebook: Rulebook; review: ReviewItem[] }, path: string): ReviewItem[] {
  if (!gridOf(path)) return [];
  const asked = (q: ReviewItem) => v.review.some((i) => i.id === q.id || (i.reason === "GRID_CONFLICT" && !settled(i) && i.options.some((o) => q.options.some((x) => x.id === o.id))));
  return fromAnomalies(checks(v.rulebook).filter((a) => a.code === "GRID_CONFLICT"), v.rulebook, new Set()).filter((q) => !asked(q));
}
