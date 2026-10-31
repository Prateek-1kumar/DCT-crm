/**
 * pnpm --filter @dct/extraction native   the native-PDF gate (ADR-003 P2), no AI
 *
 * For every answer key in data/golden whose contract has its own text, reads its budget grids by code (readTextGrids)
 * and scores them against the key: grid rows exactly right (unit price and every cell), visit totals, per-patient
 * totals, and the contract's own arithmetic on what was read (identities checked and failed). Then plants errors in the
 * read (a digit changed, a number moved one column over) and counts how many that change money the arithmetic catches:
 * every one must be. A plant that changes only a code or a name is counted apart (no sum can see it; the binder matches
 * labels against the page). Prints counts only, never contract text or amounts. Repo root = DCT_ROOT, else three levels up.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BudgetGrid, Rulebook } from "@dct/shared";
import { makeRulebook } from "../test/helpers";
import { bindEvidence, reviewFromEvidence } from "../src/binder";
import { readTextGrids, type TextGrid } from "../src/gridtext";
import { Golden } from "../src/score";
import { readTextLayer, type TextPage } from "../src/textlayer";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const goldenDir = join(root, "data/golden");

/** The rows of a grid as the key holds them: unit price and cells in visit order (null where none). */
const rowsOf = (g: BudgetGrid) => g.procedures.map((p) => ({ unitCents: p.unitCents, cells: g.visits.map((v) => (typeof p.cells[v.code] === "number" ? (p.cells[v.code] as number) : null)) }));

/**
 * Re-run the read on changed pages' text. null: the plant changed nothing that was read (a number outside every grid).
 * Else caught when the read no longer closes, so it would go to the model and a person, never be used as is.
 */
function caught(pages: TextPage[], id: string, plant: (pages: TextPage[]) => boolean, before: string): boolean | "label" | null {
  const copy = structuredClone(pages);
  if (!plant(copy)) return null;
  const read = readTextGrids(copy, id);
  if (JSON.stringify(read.map((g) => money(g.grid))) === before) return JSON.stringify(read.map((g) => g.grid)) === JSON.stringify(readTextGrids(pages, id).map((g) => g.grid)) ? null : "label";
  return !read.length || read.some((g) => g.failed.length > 0);
}

/** A grid's money only: the figures the arithmetic guards. A code or name is matched against the page by the binder. */
const money = (g: BudgetGrid) => ({ visits: g.visits.map(({ prov: _p, ...v }) => v), procedures: g.procedures.map((p) => [p.unitCents, p.cells, p.category]), perPatient: g.perPatientTotals.map((t) => t.cents) });

/** Every price-like word of the grid pages, as [page index, word index]: where errors are planted. */
const priced = (pages: TextPage[], grids: TextGrid[]) => {
  const on = new Set(grids.flatMap((g) => g.grid.procedures.map((p) => p.prov.source!.page)));
  return pages.flatMap((p, pi) => (on.has(p.page) ? p.words.flatMap((w, wi) => (/^\$?\d[\d,]*$/.test(w.text) && Number(w.text.replace(/[$,]/g, "")) >= 10 ? [[pi, wi] as const] : [])) : []));
};

async function main() {
  for (const f of readdirSync(goldenDir).filter((x) => x.endsWith(".json")).sort()) {
    const key = Golden.parse(JSON.parse(readFileSync(join(goldenDir, f), "utf8")));
    const pdf = join(root, "data/contracts", key.file);
    if (!existsSync(pdf)) continue;
    const pages = await readTextLayer(pdf, "d");
    if (!pages.some((p) => p.source === "text")) {
      console.log(`[${key.name}] not a native PDF: skipped`);
      continue;
    }
    const grids = readTextGrids(pages, "d");
    const out: Record<string, unknown> = { grids: grids.length, closes: grids.filter((g) => !g.failed.length).length, identities: grids.reduce((a, g) => a + g.checked, 0), failed: grids.flatMap((g) => g.failed) };
    key.grids.forEach((kg, i) => {
      const g = grids[i]?.grid;
      if (!g) return void (out[`grid ${i + 1}`] = "not read");
      const read = rowsOf(g);
      const right = (kg.rows ?? []).filter((r, ri) => read[ri] && read[ri]!.unitCents === r.unitCents && JSON.stringify(read[ri]!.cells) === JSON.stringify(r.cells)).length;
      const cells = (kg.rows ?? []).reduce((a, r) => a + r.cells.filter((c) => c !== null).length, 0);
      const cellsRight = (kg.rows ?? []).reduce((a, r, ri) => a + r.cells.filter((c, ci) => c !== null && read[ri]?.cells[ci] === c).length, 0);
      out[`grid ${i + 1}`] = {
        rows: `${right}/${kg.rows?.length ?? 0}`, cells: `${cellsRight}/${cells}`, readRows: read.length,
        visitTotals: `${kg.visitTotals.filter((t, ti) => g.visits[ti]?.totalCents === t).length}/${kg.visitTotals.length}`,
        perPatient: `${kg.perPatient.filter((t, ti) => g.perPatientTotals[ti]?.cents === t).length}/${kg.perPatient.length}`,
      };
    });
    // the read as the app binds it: every grid value checked against the PDF's own text, and what it would ask about the
    // grids (the synthetic rest of the master holds nothing to bind: no items, fees or terms)
    const rb = Rulebook.parse({ ...makeRulebook(), documents: [{ id: "d", kind: "work_order", title: "Work order", date: null }], budgetGrids: grids.map((g) => g.grid), invoiceables: [], siteFees: [], screenFail: null, deadlines: [] });
    const bound = bindEvidence(rb, pages);
    const onGrid = bound.evidence.filter((e) => e.path.startsWith("/budgetGrids/"));
    const status = (st: string) => onGrid.filter((e) => e.status === st).length;
    const asked = reviewFromEvidence(bound.evidence, [], rb, bound.tableChecks).filter((i) => i.path?.startsWith("/budgetGrids/"));
    out.bound = { values: onGrid.length, confirmed: status("confirmed"), conflict: status("conflict"), ungrounded: status("ungrounded"), held: onGrid.filter((e) => e.held).length, gridQuestions: asked.length };
    // planted errors, each on its own copy of the pages: all must be caught by the arithmetic
    const spots = priced(pages, grids);
    const before = JSON.stringify(grids.map((g) => money(g.grid)));
    const pick = (n: number) => spots.filter((_, i) => i % Math.max(1, Math.floor(spots.length / n)) === 0).slice(0, n);
    const digit = pick(200).map(([pi, wi]) => caught(pages, "d", (ps) => {
      const w = ps[pi]!.words[wi]!;
      const d = w.text.search(/\d/);
      w.text = w.text.slice(0, d) + String((Number(w.text[d]) + 1) % 10 || 1) + w.text.slice(d + 1);
      return true;
    }, before));
    const moved = pick(200).map(([pi, wi]) => caught(pages, "d", (ps) => {
      const w = ps[pi]!.words[wi]!;
      const step = 35; // about one visit column over, right
      w.rect = [w.rect[0] + step, w.rect[1], w.rect[2] + step, w.rect[3]];
      return true;
    }, before));
    // a plant that changed money must be caught, every one; one that changed only a code or a name is counted apart
    const count = (xs: (boolean | "label" | null)[]) => `${xs.filter((x) => x === true).length}/${xs.filter((x) => typeof x === "boolean").length}`;
    const labels = (xs: (boolean | "label" | null)[]) => xs.filter((x) => x === "label").length;
    out.planted = { digit: count(digit), movedOneColumn: count(moved), labelOnly: labels(digit) + labels(moved) };
    console.log(`[${key.name}]`, JSON.stringify(out, null, 1));
  }
}

main().then(() => process.exit(0), (e) => (console.error(e instanceof Error ? e.name : "Error"), process.exit(1)));
