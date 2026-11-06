import { Accounted, CORRECTED, Grid, isLockedField, Question, Relation, Study, Term, parseCents, parsePercent } from "@dct/shared";
import type { z } from "zod";

type Raw = Record<string, unknown>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown, each: (item: unknown, i: number) => unknown, fallback: unknown) => (Array.isArray(v) ? v.map(each) : (v ?? fallback));

function cents(v: unknown, where: string, issues: string[]): number | null {
  if (v === undefined || v === null || v === "") return null;
  const c = parseCents(String(v));
  if (c === null) issues.push(`${where}: "${String(v)}" is not a dollar amount`);
  return c;
}

// An amount becomes cents; anything else printed in the cell ("Invoice", "Inc in PE", "N/A") stays as printed.
function cell(v: unknown, where: string, issues: string[]): unknown {
  if (typeof v === "string") return v.trim() ? (parseCents(v) ?? v) : null;
  if (typeof v === "number") return cents(v, where, issues);
  return v ?? null;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, issues: string[]): Parsed<T> {
  const result = schema.safeParse(value);
  if (!result.success) issues.push(...result.error.issues.map((i) => `${i.path.join(".") || "this item"}: ${i.message}`));
  return result.success && !issues.length ? { ok: true, value: result.data } : { ok: false, issues };
}

const notAnObject: Parsed<never> = { ok: false, issues: ["this item must be an object"] };

export function normalizeStudy(raw: unknown): Parsed<Study> {
  if (!isObject(raw)) return notAnObject;
  const documents = list(raw.documents, (d) => (isObject(d) ? { hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null, ...d } : d), undefined);
  return parse(Study, { payer: null, siteNumber: null, pi: null, effectiveDate: null, ...raw, documents }, []);
}

export function normalizeTerm(raw: unknown): Parsed<Term> {
  if (!isObject(raw)) return notAnObject;
  const issues: string[] = [];
  const cap = isObject(raw.cap)
    ? { value: null, period: null, text: "", ...raw.cap, ...(raw.cap.kind === "amount" && { value: cents(raw.cap.value, "cap.value", issues) }) }
    : (raw.cap ?? null);
  const term = {
    unit: null, trigger: null, formula: null, conditions: null, holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, houseRuleIds: [], notes: null,
    ...raw, cap, amountCents: cents(raw.amount, "amount", issues), evidence: "none",
  };
  return parse(Term, term, issues);
}

export function normalizeGrid(raw: unknown): Parsed<Grid> {
  if (!isObject(raw)) return notAnObject;
  const issues: string[] = [];
  const cellIds: Record<string, string> = {};
  // on a scanned page an amount comes as {value, cell}: the value as printed, and the id of the cell it is printed in
  const cited = (v: unknown, path: string) => {
    if (!isObject(v) || !("value" in v)) return v;
    if (typeof v.cell === "string") cellIds[path] = v.cell;
    return v.value;
  };
  const amount = (v: unknown, path: string, where: string) => cents(cited(v, path), where, issues);
  const cells = (v: unknown, path: string, where: string) => list(v, (c, i) => cell(cited(c, `${path}.${i}`), `${where} #${i + 1}`, issues), null);
  const line = (k: string) => (raw[k] == null ? null : cells(raw[k], k, k));
  const rows = list(
    raw.rows,
    (r, i) => {
      if (!isObject(r)) return r;
      const where = `row '${typeof r.name === "string" ? r.name : i + 1}'`;
      return {
        code: null, ...r, unitCostCents: amount(r.unitCost, `rows.${i}.unitCostCents`, `${where} unitCost`),
        printedRowTotalCents: amount(r.printedRowTotal, `rows.${i}.printedRowTotalCents`, `${where} printedRowTotal`), cells: cells(r.cells, `rows.${i}.cells`, where),
      };
    },
    undefined,
  );
  const additions = list(raw.additions, (a, i) => (isObject(a) ? { ...a, cells: cells(a.cells, `additions.${i}.cells`, `added line '${String(a.name)}'`) } : a), []);
  const pct = typeof raw.overheadPct === "string" ? parsePercent(raw.overheadPct) : (raw.overheadPct ?? null);
  if (pct === null && raw.overheadPct != null) issues.push(`overheadPct: "${String(raw.overheadPct)}" is not a percentage`);
  const grid = {
    arm: null, ...raw, cellsReadTwice: [], acceptedAsPrinted: false, overheadPct: pct, rows, subtotal: line("subtotal"), overhead: line("overhead"), total: line("total"), additions,
    grandTotalCents: amount(raw.grandTotal, "grandTotalCents", "grandTotal"), cellIds,
  };
  return parse(Grid, grid, issues);
}

export function normalizeAccounted(raw: unknown): Parsed<Accounted> {
  if (!isObject(raw)) return notAnObject;
  const issues: string[] = [];
  if (typeof raw.reason === "string" && raw.reason.trim().toLowerCase() === CORRECTED) issues.push(`reason: "${CORRECTED}" is kept for amounts only a person's answer corrected; give the real reason`);
  return parse(Accounted, { ...raw, amountCents: raw.amount == null ? undefined : cents(raw.amount, "amount", issues) }, issues);
}

export function normalizeRelation(raw: unknown): Parsed<Relation> {
  if (!isObject(raw)) return notAnObject;
  return parse(Relation, { ...raw, operands: typeof raw.operands === "string" ? [raw.operands] : raw.operands }, []);
}

// An option's patch is applied when a person picks it, who never sees the patch: it can't carry the proof fields.
const unlocked = (p: unknown) => (isObject(p) && isObject(p.set) ? { ...p, set: Object.fromEntries(Object.entries(p.set).filter(([key]) => !isLockedField(key))) } : p);

export function normalizeQuestion(raw: unknown): Parsed<Question> {
  if (!isObject(raw)) return notAnObject;
  const options = list(raw.options, (o) => {
    if (!isObject(o)) return o;
    const { patch, ...rest } = o;
    const patches = list(rest.patches ?? (patch ? [patch] : []), unlocked, []);
    return { ...rest, patches };
  }, []);
  return parse(Question, { context: "", about: null, suggestion: null, ...raw, options, origin: "compile", state: "open", blocking: true, readings: [], resolution: null }, []);
}
