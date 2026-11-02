/**
 * pnpm --filter @dct/extraction native   the native-PDF gate (ADR-003 P2), no AI
 *
 * For every answer key in data/golden whose contract has its own text, reads its budget grids by code (readTextGrids)
 * and scores them against the key: grid rows exactly right (unit price and every cell), visit totals, per-patient
 * totals, and the contract's own arithmetic on what was read (identities checked and failed). Then plants errors in the
 * read (a digit changed, a number moved one column over, a price replaced by a word, a column's header words removed, a
 * column's header copied over its neighbour's, an "X" in an empty visit cell; the last three again with the quantity column taken
 * out, since its sum catches them all) and counts how many that change money the reader catches: every one must be. A plant that changes only a code or a name is counted apart (no sum can see it; the binder matches
 * labels against the page). Prints counts only, never contract text or amounts. Repo root = DCT_ROOT, else three levels up.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BudgetGrid, parseCents, Rulebook } from "@dct/shared";
import { makeRulebook } from "../test/helpers";
import { bindEvidence, reviewFromEvidence } from "../src/binder";
import { readTextGrids, type TextGrid } from "../src/gridtext";
import { Golden } from "../src/score";
import { readTextLayer, type TextPage } from "../src/textlayer";

const root = process.env.DCT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const goldenDir = join(root, "data/golden");

/** The rows of a grid as the key holds them: unit price and cells in visit order (null where none). */
const rowsOf = (g: BudgetGrid) => g.procedures.map((p) => ({ unitCents: p.unitCents, cells: g.visits.map((v) => (typeof p.cells[v.code] === "number" ? (p.cells[v.code] as number) : null)) }));

/** The grids a read would use, as `extractWith` does: those that close, on pages no failed grid touches. */
const used = (read: TextGrid[]) => {
  const unsure = new Set(read.filter((g) => g.failed.length).flatMap((g) => g.pages));
  return read.filter((g) => !g.failed.length && g.pages.every((p) => !unsure.has(p)));
};

/**
 * Re-run the read on changed pages' text. null: the plant changed nothing that was read (a number outside every grid).
 * Else caught when no grid the read would use carries the change: each one used is one of the unplanted read's, as it was.
 */
function caught(pages: TextPage[], id: string, plant: (pages: TextPage[]) => boolean, before: string[]): boolean | "label" | null {
  const copy = structuredClone(pages);
  if (!plant(copy)) return null;
  const read = used(readTextGrids(copy, id));
  if (JSON.stringify(read.map((g) => JSON.stringify(money(g.grid)))) === JSON.stringify(before)) return JSON.stringify(read.map((g) => g.grid)) === JSON.stringify(used(readTextGrids(pages, id)).map((g) => g.grid)) ? null : "label";
  return read.every((g) => before.includes(JSON.stringify(money(g.grid))));
}

/**
 * The page's figure columns, as [left, right] spans: the x-centres of its numbers on lines of three or more, split at gaps
 * wider than 8 pt. A rough copy of the reader's own, only to know where to plant.
 */
function strips(p: TextPage): [number, number][] {
  const xs = p.words.filter((w) => /^\$?\d[\d,.]*$/.test(w.text)).map((w) => (w.rect[0] + w.rect[2]) / 2).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && x - last[1] <= 8) last[1] = x;
    else out.push([x, x]);
  }
  return out;
}
const isFigure = (t: string) => /^\(?\$?\d[\d,]*(?:\.\d+)?\)?$/.test(t);
const inStrip = (w: TextPage["words"][number], [a, b]: [number, number]) => (w.rect[0] + w.rect[2]) / 2 >= a - 4 && (w.rect[0] + w.rect[2]) / 2 <= b + 4;

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
    const all = readTextGrids(pages, "d");
    const grids = used(all);
    // a table that fails (not a budget grid, or one this reader can't read whole) is left to the model: its pages are listed
    const out: Record<string, unknown> = { grids: grids.length, closes: all.filter((g) => !g.failed.length).length, identities: grids.reduce((a, g) => a + g.checked, 0), failed: grids.flatMap((g) => g.failed), leftToModel: [...new Set(all.filter((g) => g.failed.length).flatMap((g) => g.pages))] };
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
    const before = grids.map((g) => JSON.stringify(money(g.grid)));
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
    // a price replaced by a word ("X", as a schedule marks a visit): the reader must not drop it and close
    const word = pick(200).map(([pi, wi]) => caught(pages, "d", (ps) => ((ps[pi]!.words[wi]!.text = "X"), true), before));
    // The plants a quantity column hides: with one, a row's cells must add up to quantity × unit price, so a cell lost to any of
    // them is caught by that sum. They are planted again on the pages with the quantity column taken out (its header and its
    // figures), where only the visits' own sums are left, and the reader must still fail on each.
    const gridPages = [...new Set(grids.flatMap((g) => g.pages))].map((n) => pages.findIndex((p) => p.page === n));
    const units = new Set(grids.flatMap((g) => g.grid.procedures.map((p) => p.unitCents)));
    const visits = Math.max(...grids.map((g) => g.grid.visits.length));
    const layout = gridPages.map((pi) => {
      const ss = strips(pages[pi]!);
      const at = ss.map((st) => pages[pi]!.words.filter((w) => isFigure(w.text) && inStrip(w, st) && units.has(parseCents(w.text) ?? Number.NaN)));
      const u = at.reduce((best, ws, i) => (ws.length > at[best]!.length ? i : best), 0);
      return { pi, ss, unit: at[u]!, visit: ss.slice(u + 1, u + 1 + visits), qty: grids.some((g) => g.qty.some((q) => q !== null)) ? ss[u - 1] : undefined };
    });
    const noQty = structuredClone(pages);
    for (const l of layout) if (l.qty) noQty[l.pi]!.words = noQty[l.pi]!.words.filter((w) => !inStrip(w, l.qty!));
    const noQtyCloses = JSON.stringify(used(readTextGrids(noQty, "d")).map((g) => JSON.stringify(money(g.grid)))) === JSON.stringify(before);
    // the grid as read is no longer used whole: what an "X" in an empty cell must cause, since it changes no figure read
    const dropped = (base: TextPage[], plant: (ps: TextPage[]) => void) => {
      const copy = structuredClone(base);
      plant(copy);
      const read = used(readTextGrids(copy, "d")).map((g) => JSON.stringify(money(g.grid)));
      return !before.every((b) => read.includes(b));
    };
    const blanks = layout.flatMap((l) => l.unit.flatMap((uw) => l.visit.filter((st) => !pages[l.pi]!.words.some((w) => inStrip(w, st) && w.rect[1] < uw.rect[3] && w.rect[3] > uw.rect[1])).map((st) => ({ pi: l.pi, uw, x: (st[0] + st[1]) / 2 }))));
    const someBlanks = blanks.filter((_, i) => i % Math.max(1, Math.floor(blanks.length / 200)) === 0).slice(0, 200);
    const blankWord = (base: TextPage[]) => someBlanks.map((b) => dropped(base, (ps) => void ps[b.pi]!.words.push({ ...b.uw, text: "X", rect: [b.x - 3, b.uw.rect[1], b.x + 3, b.uw.rect[3]] })));
    const columns = layout.flatMap((l) => l.ss.map((st) => [l.pi, st] as const));
    // every column of a grid page, its header words removed: a column with no name must fail, never be left out
    const unnamed = (base: TextPage[]) => columns.map(([pi, st]) => caught(base, "d", (ps) => {
      const n = ps[pi]!.words.length;
      ps[pi]!.words = ps[pi]!.words.filter((w) => isFigure(w.text) || !inStrip(w, st));
      return ps[pi]!.words.length < n;
    }, before));
    // every column's header words copied over its right-hand neighbour's: two columns of one name must fail
    const twice = (base: TextPage[]) => columns.flatMap(([pi, st], ci) => {
      const next = columns[ci + 1];
      if (!next || next[0] !== pi) return [];
      return [caught(base, "d", (ps) => {
        const p = ps[pi]!;
        const dx = (next[1][0] + next[1][1]) / 2 - (st[0] + st[1]) / 2;
        const words = p.words.filter((w) => !isFigure(w.text) && inStrip(w, st));
        if (!words.length) return false;
        p.words = [...p.words.filter((w) => isFigure(w.text) || !inStrip(w, next[1])), ...words.map((w) => ({ ...w, rect: [w.rect[0] + dx, w.rect[1], w.rect[2] + dx, w.rect[3]] as typeof w.rect }))];
        return true;
      }, before)];
    });
    // a plant that changed money must be caught, every one; one that changed only a code or a name is counted apart
    const count = (xs: (boolean | "label" | null)[]) => `${xs.filter((x) => x === true).length}/${xs.filter((x) => typeof x === "boolean").length}`;
    const labels = (xs: (boolean | "label" | null)[]) => xs.filter((x) => x === "label").length;
    const [u1, t1] = [unnamed(pages), twice(pages)];
    const [u2, t2] = noQtyCloses ? [unnamed(noQty), twice(noQty)] : [[], []];
    out.planted = {
      digit: count(digit), movedOneColumn: count(moved), nonNumericCell: count(word), wordInEmptyCell: count(blankWord(pages)), headerRemoved: count(u1), duplicateHeader: count(t1),
      withoutQuantity: noQtyCloses ? { wordInEmptyCell: count(blankWord(noQty)), headerRemoved: count(u2), duplicateHeader: count(t2) } : "the grid doesn't close without its quantity column: not planted",
      labelOnly: [digit, moved, word, u1, t1, u2, t2].reduce((a, xs) => a + labels(xs), 0),
    };
    console.log(`[${key.name}]`, JSON.stringify(out, null, 1));
  }
}

main().then(() => process.exit(0), (e) => (console.error(e instanceof Error ? e.name : "Error"), process.exit(1)));
