// Scores a rulebook against an answer key (design §9), no model calls. The key is written by a person reading the contract
// cold, before the read it judges, so a change is measured and not eyeballed.
//   pnpm --filter @dct/harness score <key.json> <read outDir | rulebook.json | saved version .json> [more reads of the same bundle...]
// Several reads of one bundle show what differs from run to run. Exits 1 when any read fails the key.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Cell = number | string | null;
interface KeyGrid { name: string; visits: string[]; rows: { name: string; cells: Cell[] }[]; total?: Cell[] | null; grandTotalCents?: number | null }
export interface Key {
  bundle: string;
  /** The key lists only some of the contract's fees, so an amount it doesn't know is not held against the read. */
  partial?: boolean;
  /** amountCents is what ONE unit pays, so a line total stored as the amount is reported; a per-patient total may sit in a grid. */
  terms: { id: string; name: string; amountCents: number }[];
  grids: KeyGrid[];
  /** match: a case-insensitive pattern the question, its context or its answers must contain; without one it can't be scored. */
  decisions: { id: string; question: string; match?: string }[];
  missedRules: (string | { text: string; match: string })[];
}
interface Term { name: string; amountCents: number | null; cap?: { kind: string; value: number | null } | null; formula?: string | null; conditions?: string | null; notes?: string | null; trigger?: string | null; deadline?: string | null }
interface Grid { name: string; visits: string[]; overheadPct?: number | null; rows: { name: string; cells: Cell[] }[]; total?: Cell[] | null; additions?: { name: string; cells: Cell[] }[] | null; grandTotalCents?: number | null }
interface Question { question: string; context?: string; state?: string; blocking?: boolean; origin?: string; options?: { label: string }[] }
export interface Rulebook { terms: Term[]; grids: Grid[]; questions: Question[] }

const numbers = (cells: Cell[] | null | undefined) => (cells ?? []).filter((c): c is number => typeof c === "number");
// a visit is compared by what it holds, whatever order the rows were written in
const column = (g: { rows: { cells: Cell[] }[] }, i: number) => g.rows.map((r) => r.cells[i] ?? null).filter((c) => c !== null).map((c) => String(c).trim().toLowerCase());
// the read may keep two printed columns (a visit's rate and its reduced rate) in one grid where the key has two: every
// figure the key expects for the visit must be there, and a figure the key doesn't know is caught by the read's own arithmetic
const holds = (got: string[], want: string[]) => {
  const left = [...got];
  return want.every((c) => left.includes(c) && left.splice(left.indexOf(c), 1));
};

// a one-row price list may come back turned: one row per visit under a single "Fee" column
const turned = (g: Grid): Grid =>
  g.visits.length === 1 && g.rows.length > 1 ? { ...g, visits: g.rows.map((r) => r.name), rows: [{ name: g.visits[0]!, cells: g.rows.map((r) => r.cells[0] ?? null) }], total: null } : g;

function scoreGrid(want: KeyGrid, given: Grid | undefined) {
  if (!given) return { name: want.name, found: false, visits: want.visits.length, wrongVisits: want.visits };
  const got = want.rows.length === 1 ? turned(given) : given;
  const totalsPrinted = numbers(want.total).length > 0 && numbers(got.total).length > 0;
  const at = (i: number) => (got.visits.length === want.visits.length ? i : got.visits.findIndex((v) => v.trim().toLowerCase() === want.visits[i]!.trim().toLowerCase()));
  const wrongVisits = want.visits.filter((_, i) => at(i) < 0 || !holds(column(got, at(i)), column(want, i)) || (totalsPrinted && got.visits.length === want.visits.length && want.total![i] !== got.total![i]));
  if (want.grandTotalCents != null && got.grandTotalCents != null && want.grandTotalCents !== got.grandTotalCents) wrongVisits.push("grand total");
  return { name: want.name, found: true, visits: want.visits.length, wrongVisits };
}

export function score(key: Key, rulebook: Rulebook) {
  const termAmounts = new Set(rulebook.terms.map((t) => t.amountCents).filter((a): a is number => a !== null));
  const caps = new Set(rulebook.terms.map((t) => (t.cap?.kind === "amount" ? t.cap.value : null)).filter((a): a is number => a !== null));
  const inGrids = new Set(
    rulebook.grids.flatMap((g) => [g.grandTotalCents ?? NaN, (g.overheadPct ?? NaN) * 100, ...numbers(g.total), ...g.rows.flatMap((r) => numbers(r.cells)), ...(g.additions ?? []).flatMap((r) => numbers(r.cells))]),
  );
  const where = (a: number) => (termAmounts.has(a) ? "term" : inGrids.has(a) ? "grid" : caps.has(a) ? "cap" : null);

  const values = key.terms.map((t) => ({ id: t.id, name: t.name, amountCents: t.amountCents, where: where(t.amountCents) }));
  const expected = new Set([...key.terms.map((t) => t.amountCents), ...key.grids.flatMap((g) => [g.grandTotalCents ?? NaN, ...numbers(g.total), ...g.rows.flatMap((r) => numbers(r.cells))])]);
  // an amount on a term that the key doesn't know: a wrong value, or a billable the key lacks; a person looks at each
  const unexpectedAmounts = rulebook.terms.filter((t) => t.amountCents !== null && !expected.has(t.amountCents)).map((t) => ({ name: t.name, amountCents: t.amountCents! }));

  // a key grid is matched to the rulebook grid with the same number of visits that agrees on the most of them
  const grids = key.grids.map((want) => {
    const candidates = rulebook.grids.map((g) => scoreGrid(want, g));
    return candidates.sort((a, b) => a.wrongVisits.length - b.wrongVisits.length)[0] ?? scoreGrid(want, undefined);
  });

  const open = rulebook.questions.filter((q) => (q.state ?? "open") === "open");
  const words = (q: Question) => [q.question, q.context ?? "", ...(q.options ?? []).map((o) => o.label)].join(" ");
  const matched = new Set<Question>();
  const decisions = key.decisions.map((d) => {
    const hits = d.match ? open.filter((q) => new RegExp(d.match!, "is").test(words(q))) : [];
    hits.forEach((q) => matched.add(q));
    return { id: d.id, raised: hits.length > 0, scorable: Boolean(d.match) };
  });
  const unexpectedQuestions = open.filter((q) => !matched.has(q)).map((q) => ({ origin: q.origin, blocking: q.blocking ?? false, question: q.question }));

  const ruleWords = [...rulebook.terms.map((t) => [t.name, t.formula, t.conditions, t.notes, t.trigger, t.deadline].join(" ")), ...open.map(words)];
  const missedRules = key.missedRules.flatMap((r) => (typeof r === "string" || ruleWords.some((w) => new RegExp(r.match, "is").test(w)) ? [] : [r.text]));

  return {
    valuesExpected: values.length,
    valuesMissing: values.filter((v) => v.where === null),
    valuesOnlyAsCap: values.filter((v) => v.where === "cap"),
    unexpectedAmounts,
    grids,
    gridVisitsWrong: grids.reduce((n, g) => n + g.wrongVisits.length, 0),
    decisionsExpected: decisions.length,
    decisionsMissing: decisions.filter((d) => d.scorable && !d.raised).map((d) => d.id),
    decisionsUnscorable: decisions.filter((d) => !d.scorable).map((d) => d.id),
    questions: open.length,
    blocking: open.filter((q) => q.blocking).length,
    unexpectedQuestions,
    missedRules,
  };
}

function load(path: string): { rulebook: Rulebook; cost: string } {
  const dir = existsSync(path) && statSync(path).isDirectory();
  const raw = JSON.parse(readFileSync(dir ? join(path, "rulebook.json") : path, "utf8")) as { rulebook?: Rulebook } & Rulebook;
  const summary = dir && existsSync(join(path, "summary.json")) ? (JSON.parse(readFileSync(join(path, "summary.json"), "utf8")) as { usd?: number; turns?: number }) : null;
  return { rulebook: raw.rulebook ?? raw, cost: summary ? `  $${summary.usd} · ${summary.turns} turns` : "" };
}

function main() {
  const base = process.env.INIT_CWD ?? process.cwd();
  const [keyPath, ...paths] = process.argv.slice(2);
  if (!keyPath || !paths.length) {
    console.error("Usage: pnpm --filter @dct/harness score <key.json> <read outDir or rulebook.json...>");
    process.exit(1);
  }
  const key = JSON.parse(readFileSync(resolve(base, keyPath), "utf8")) as Key;
  let failed = false;
  for (const p of paths) {
    const { rulebook, cost } = load(resolve(base, p));
    const s = score(key, rulebook);
    // questions the key doesn't list don't fail a read: a person decides whether each is genuine (then it joins the key) or noise
    const pass = !s.valuesMissing.length && !s.valuesOnlyAsCap.length && (key.partial || !s.unexpectedAmounts.length) && !s.gridVisitsWrong && !s.decisionsMissing.length && !s.missedRules.length;
    failed ||= !pass;
    console.log(`\n== ${key.bundle}: ${p}\n${pass ? "PASS" : "FAIL"}${cost}`);
    console.log(`  values:    ${s.valuesExpected - s.valuesMissing.length - s.valuesOnlyAsCap.length} of ${s.valuesExpected} are a term's amount or in a grid; ${s.unexpectedAmounts.length} term amounts the key doesn't know`);
    for (const v of s.valuesMissing) console.log(`     missing: ${v.id} (${v.name}) ${(v.amountCents / 100).toFixed(2)}`);
    for (const v of s.valuesOnlyAsCap) console.log(`     only a cap, not an amount: ${v.id} (${v.name})`);
    for (const v of s.unexpectedAmounts) console.log(`     not in key: ${v.name} = ${(v.amountCents / 100).toFixed(2)}`);
    for (const g of s.grids) console.log(`  grid:      ${g.found ? `${g.visits - g.wrongVisits.filter((v) => v !== "grand total").length} of ${g.visits} visits match${g.wrongVisits.length ? `; wrong: ${g.wrongVisits.join(", ")}` : ""}` : "NOT FOUND"}  (${g.name.slice(0, 48)})`);
    console.log(`  decisions: ${s.decisionsExpected - s.decisionsMissing.length - s.decisionsUnscorable.length} of ${s.decisionsExpected} expected were raised${s.decisionsMissing.length ? `; missing: ${s.decisionsMissing.join(", ")}` : ""}${s.decisionsUnscorable.length ? `; key has no pattern for: ${s.decisionsUnscorable.join(", ")}` : ""}`);
    console.log(`  questions: ${s.questions} open, ${s.blocking} blocking, ${s.unexpectedQuestions.length} not in the key`);
    for (const q of s.unexpectedQuestions) console.log(`     ${q.blocking ? "blocking" : "optional"} (${q.origin}): ${q.question.slice(0, 140)}`);
    for (const r of s.missedRules) console.log(`  rule missing: ${r}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
