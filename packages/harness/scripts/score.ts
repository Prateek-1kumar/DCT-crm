import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cell, Grid, Rulebook } from "@dct/shared";

interface KeyGrid {
  name: string;
  rows: { name: string; cells: (number | string | null)[] }[];
  subtotal: (number | string | null)[] | null;
  total: (number | string | null)[] | null;
  grandTotalCents: number | null;
}
interface Key {
  terms: { name: string; amountCents: number }[];
  grids: KeyGrid[];
  decisions: { id: string; question: string }[];
  missedRules: string[];
}

const [keyPath, outDir] = process.argv.slice(2);
if (!keyPath || !outDir) throw new Error("usage: score.ts <key.json> <outDir>");
const key = JSON.parse(readFileSync(keyPath, "utf8")) as Key;
const rb = JSON.parse(readFileSync(join(outDir, "rulebook.json"), "utf8")) as Rulebook;
const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8")) as Record<string, unknown>;

const same = (a: Cell | undefined, b: Cell | undefined) =>
  typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : (a ?? null) === (b ?? null);

const allCents = new Set<number>();
const collect = (v: unknown): void => {
  if (typeof v === "number" && Number.isInteger(v)) allCents.add(Math.abs(v));
  else if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === "object") Object.values(v).forEach(collect);
};
collect(rb.terms);
collect(rb.grids);

const cellsOf = (g: { rows: { cells: Cell[] }[] }) => g.rows.flatMap((r) => r.cells);
const overlap = (a: KeyGrid, b: Grid) => {
  const theirs = new Set(cellsOf(b).filter((c) => typeof c === "number"));
  return cellsOf(a).filter((c) => typeof c === "number" && theirs.has(c)).length;
};

const gridLines = key.grids.map((k) => {
  const g = rb.grids.find((x) => x.grandTotalCents !== null && x.grandTotalCents === k.grandTotalCents) ?? [...rb.grids].sort((x, y) => overlap(k, y) - overlap(k, x))[0];
  if (!g) return `  MISSING grid '${k.name}'`;
  const kc = cellsOf(k);
  const gc = cellsOf(g);
  const wrong = kc.filter((c, i) => !same(c, gc[i])).length;
  const totals = (k.total ?? []).filter((t, i) => !same(t, g.total?.[i])).length;
  return `  '${k.name}' → '${g.name}': ${kc.length - wrong}/${kc.length} cells match, ${totals} visit totals differ, grand ${g.grandTotalCents === k.grandTotalCents ? "matches" : `${g.grandTotalCents} vs key ${k.grandTotalCents}`}`;
});

const keyAmounts = new Set([...key.terms.map((t) => t.amountCents), ...key.grids.flatMap((g) => cellsOf(g).filter((c): c is number => typeof c === "number"))]);
const missing = key.terms.filter((t) => !allCents.has(Math.abs(t.amountCents)));
const unknownAmounts = rb.terms.filter((t) => t.amountCents !== null && !keyAmounts.has(Math.abs(t.amountCents)));

console.log(`cost $${summary.usd} · turns ${summary.turns} · finishes ${summary.finishes} · stop ${summary.stopReason}`);
console.log(`grids:\n${gridLines.join("\n")}`);
console.log(`key amounts missing from the rulebook (${missing.length}):`);
missing.forEach((t) => console.log(`  ${t.name}: ${t.amountCents}`));
console.log(`rulebook amounts not in the key, to review (${unknownAmounts.length}):`);
unknownAmounts.forEach((t) => console.log(`  ${t.id} ${t.name}: ${t.amountCents} (p.${t.source.page})`));
console.log(`questions raised (${rb.questions.length}):`);
rb.questions.forEach((q) => console.log(`  [${q.origin}/${q.kind}] ${q.question}`));
console.log(`expected decisions (${key.decisions.length}):`);
key.decisions.forEach((d) => console.log(`  ${d.id}: ${d.question}`));
if (key.missedRules.length) console.log(`rules the spike missed, look for them in terms: ${key.missedRules.join("; ")}`);
