/**
 * pnpm --filter @dct/extraction evidence   bind the saved COPD read to the signed original's text layer (no AI calls)
 *
 * Repo root = DCT_ROOT, else two levels above this package. Prints counts only; never contract text or amounts.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Rulebook } from "@dct/shared";
import { bindEvidence, reviewFromEvidence } from "../src/binder";
import { printedAmounts } from "../src/checks";
import { readTextLayer } from "../src/textlayer";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pdf = join(root, "data/contracts/copd-native/WO 116264 - EFC18243 - signed 2025-08-22.pdf");
const rb = Rulebook.parse(JSON.parse(readFileSync(join(root, "data/extractions/copd.json"), "utf8")).rulebook);
const golden = JSON.parse(readFileSync(join(root, "data/golden/copd-native.json"), "utf8")) as {
  grids: { rows: { code: string | null; cells: (number | null)[] }[] }[];
  study: { effectiveDate: string | null };
  overheadPct?: number | null;
  netDays?: number | null;
  screenFail?: { n: number | null } | null;
  deadlines: { kind: string; value: number }[];
};

const pages = await readTextLayer(pdf, rb.documents[0]!.id);
console.log(`pages: ${pages.length} (${pages.filter((p) => p.source === "text").length} text, ${pages.filter((p) => p.source === "image_only").length} image only, ${pages.filter((p) => p.source === "ocr_layer").length} OCR layer); hidden words: ${pages.reduce((n, p) => n + p.hidden, 0)}`);

// Caps, due/refund days, dates and the grid's stated overhead % are bound since the I1 review (newly bound).
const family = (path: string) =>
  /\/cells\//.test(path) ? "grid cells"
  : /unitCents$/.test(path) ? "unit prices"
  : /statedOverheadPct$/.test(path) ? "grid overhead %"
  : /\/visits\/|perPatientTotals/.test(path) ? "visit totals"
  : /\/cap\//.test(path) ? "caps"
  : /dueDays$|refundDays$/.test(path) ? "due days"
  : /effectiveDate|appliesFrom/.test(path) ? "dates"
  : /^\/(invoiceables|siteFees|screenFail)/.test(path) ? "fees"
  : "rules";
const NEW = new Set(["grid overhead %", "caps", "due days", "dates"]);
const t0 = Date.now();
const { evidence, unaccounted } = bindEvidence(rb, pages);
console.log(`\nbound ${evidence.length} values in ${Date.now() - t0} ms`);
const fams = new Map<string, Record<string, number>>();
for (const e of evidence) {
  const f = fams.get(family(e.path)) ?? fams.set(family(e.path), { confirmed: 0, conflict: 0, ungrounded: 0 }).get(family(e.path))!;
  f[e.status] = (f[e.status] ?? 0) + 1;
}
for (const [f, c] of fams) console.log(`  ${f.padEnd(15)} ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(", ")}${NEW.has(f) ? "  (newly bound)" : ""}`);
const notes = new Map<string, number>();
for (const e of evidence) if (e.note) notes.set(`${family(e.path)}: ${e.note}`, (notes.get(`${family(e.path)}: ${e.note}`) ?? 0) + 1);
for (const [n, k] of notes) console.log(`  note × ${k}  ${n}`);

const byKind = new Map<string, Map<number, number>>();
for (const s of unaccounted) {
  const m = byKind.get(s.kind) ?? byKind.set(s.kind, new Map()).get(s.kind)!;
  m.set(s.where.page, (m.get(s.where.page) ?? 0) + 1);
}
console.log(`\nunaccounted: ${unaccounted.length}`);
for (const [k, m] of byKind) console.log(`  ${k.padEnd(12)} ${[...m].map(([p, n]) => `p.${p}: ${n}`).join(", ")}`);
const questions = reviewFromEvidence(evidence, unaccounted, rb);
const asked = new Map<string, number>();
for (const q of questions) {
  const k = q.path ? `${q.reason} (${family(q.path)})` : q.reason;
  asked.set(k, (asked.get(k) ?? 0) + 1);
}
console.log(`questions: ${questions.length}`);
for (const [k, n] of asked) console.log(`  ${k.padEnd(36)} ${n}`);

// Mutation test: one digit of one priced grid cell changed, re-bound; caught = not confirmed.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const misread = (c: number) => {
  const s = c % 100 ? (c / 100).toFixed(2) : String(c / 100);
  const at = [...s].flatMap((ch, i) => (/\d/.test(ch) ? [i] : []));
  const i = at[Math.floor(rand() * at.length)]!;
  return Math.round(Number(s.slice(0, i) + String((Number(s[i]) + 1 + Math.floor(rand() * 9)) % 10) + s.slice(i + 1)) * 100);
};
const ptr = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const g = rb.budgetGrids[0]!;
const cells = g.procedures.flatMap((p, pi) => Object.entries(p.cells).flatMap(([k, c]) => (typeof c === "number" ? [{ pi, k, c }] : [])));
const pageText = new Map(pages.map((p) => [p.page, printedAmounts(p.words.map((w) => w.text).join(" ")) ?? []]));
let [tried, caught, oldPass] = [0, 0, 0];
for (const { pi, k, c } of cells.sort(() => rand() - 0.5).slice(0, 300)) {
  const mutated = misread(c);
  const m = structuredClone(rb);
  m.budgetGrids[0]!.procedures[pi]!.cells[k] = mutated;
  const ev = bindEvidence(m, pages).evidence.find((e) => e.path === `/budgetGrids/0/procedures/${pi}/cells/${ptr(k)}`);
  tried++;
  if (ev?.status !== "confirmed") caught++;
  if (pageText.get(g.procedures[pi]!.prov.source!.page)?.includes(mutated)) oldPass++;
}
console.log(`\nmutation test: ${caught}/${tried} single-digit misreads caught (${((100 * caught) / tried).toFixed(1)}%); the old page-set check would pass ${oldPass} (${((100 * oldPass) / tried).toFixed(1)}%)`);

// Every other value, every neighbour one printed character away (a digit changed, dropped or added; a date's digit changed,
// still a real day). Each value is bound on its own, so round r gives every value its r-th neighbour in one pass.
const keys = (path: string) => path.split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
const get = (o: unknown, path: string) => keys(path).reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o);
const set = (o: unknown, path: string, v: unknown) => {
  const ks = keys(path);
  (ks.slice(0, -1).reduce<unknown>((x, k) => (x as Record<string, unknown>)[k], o) as Record<string, unknown>)[ks.at(-1)!] = v;
};
const realDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d);
};
const nearby = (v: number | string, inCents: boolean): (number | string)[] => {
  if (typeof v === "string") return [...v].flatMap((ch, i) => (/\d/.test(ch) ? [..."0123456789"].filter((d) => d !== ch).map((d) => v.slice(0, i) + d + v.slice(i + 1)) : [])).filter(realDay);
  const s = inCents ? (v / 100).toFixed(2) : String(v);
  const back = (t: string) => (inCents ? Math.round(Number(t) * 100) : Number(t));
  const out = new Set<number>();
  for (let i = 0; i <= s.length; i++) {
    const digit = i < s.length && /\d/.test(s[i]!);
    for (const d of "0123456789") {
      out.add(back(s.slice(0, i) + d + s.slice(i)));
      if (digit) out.add(back(s.slice(0, i) + d + s.slice(i + 1)));
    }
    if (digit && s.length > 1) out.add(back(s.slice(0, i) + s.slice(i + 1)));
  }
  out.delete(v);
  return [...out].filter(Number.isFinite);
};
const others = evidence.map((e) => e.path).filter((p) => !/\/cells\/|unitCents$/.test(p));
const inCents = (p: string) => /Cents$|\/cents$/.test(p) || (p.endsWith("/cap/n") && get(rb, p.replace(/\/n$/, "/kind")) === "amount");
const near = new Map(others.map((p) => [p, nearby(get(rb, p) as number | string, inCents(p))]));
const per = new Map<string, { tried: number; caught: number }>();
for (let r = 0; [...near.values()].some((vs) => r < vs.length); r++) {
  const m = structuredClone(rb);
  const changed = others.filter((p) => r < near.get(p)!.length);
  for (const p of changed) set(m, p, near.get(p)![r]);
  const after = new Map(bindEvidence(m, pages).evidence.map((e) => [e.path, e.status]));
  for (const p of changed) {
    const f = per.get(family(p)) ?? per.set(family(p), { tried: 0, caught: 0 }).get(family(p))!;
    f.tried++;
    if (after.get(p) !== "confirmed") f.caught++;
  }
}
console.log("  every other value, each one-character change:");
for (const [f, { tried, caught }] of per) console.log(`    ${f.padEnd(15)} ${caught}/${tried} caught`);

// The 593 cells against the hand-checked rows: each golden row paired with the read row of its code that matches best.
const visits = [...g.visits].sort((a, b) => a.order - b.order).map((v) => v.code);
const status = new Map(evidence.map((e) => [e.path, e]));
const unused = new Set(g.procedures.map((_, i) => i));
const tally = { right_confirmed: 0, right_flagged: 0, wrong_confirmed: 0, wrong_flagged: 0, text_equals_key: 0, missed_by_read: 0 };
for (const r of golden.grids[0]!.rows) {
  const hits = (pi: number) => visits.filter((v, i) => g.procedures[pi]!.cells[v] === (r.cells[i] ?? undefined)).length;
  const pi = [...unused].filter((i) => g.procedures[i]!.code === r.code).sort((a, b) => hits(b) - hits(a))[0];
  if (pi === undefined) continue;
  unused.delete(pi);
  visits.forEach((v, i) => {
    const read = g.procedures[pi]!.cells[v];
    const key = r.cells[i] ?? null;
    if (typeof read !== "number") return void (key !== null && tally.missed_by_read++);
    const e = status.get(`/budgetGrids/0/procedures/${pi}/cells/${ptr(v)}`);
    const ok = e?.status === "confirmed";
    tally[read === key ? (ok ? "right_confirmed" : "right_flagged") : ok ? "wrong_confirmed" : "wrong_flagged"]++;
    if (e?.printed && Math.round(Number(e.printed.replace(/[^\d.]/g, "")) * 100) === key) tally.text_equals_key++;
  });
}
console.log(`\nagainst the hand-checked rows (${cells.length} priced cells):`);
for (const [k, n] of Object.entries(tally)) console.log(`  ${k.replace(/_/g, " ").padEnd(16)} ${n}`);

// The rules the hand-checked key holds, read value against key.
const keyed: [string, unknown][] = [
  ["/study/effectiveDate/value", golden.study.effectiveDate],
  ["/overhead/pct/value", golden.overheadPct],
  ["/payment/netDays/value", golden.netDays],
  ["/screenFail/cap/n", golden.screenFail?.n],
  ...rb.deadlines.map((d, i): [string, unknown] => [`/deadlines/${i}/value`, golden.deadlines.find((k) => k.kind === d.kind)?.value]),
];
const rules = { right_confirmed: 0, right_flagged: 0, wrong_confirmed: 0, wrong_flagged: 0 };
for (const [path, key] of keyed) {
  const e = status.get(path);
  if (!e || key === undefined || key === null) continue;
  rules[`${get(rb, path) === key ? "right" : "wrong"}_${e.status === "confirmed" ? "confirmed" : "flagged"}`]++;
}
console.log(`\nrules against the hand-checked key (${Object.values(rules).reduce((a, b) => a + b, 0)} values):`);
for (const [k, n] of Object.entries(rules)) console.log(`  ${k.replace(/_/g, " ").padEnd(16)} ${n}`);
