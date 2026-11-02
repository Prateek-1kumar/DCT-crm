import { parseCents } from "./money";
import type { Rulebook } from "./rulebook";

/**
 * The sponsor's budget spreadsheet, checked against the grids read from the signed contract (ADR-003 P2). A check, never a
 * source: the signed contract is what's billed, so a difference is said (a notice), and nothing in the master is changed
 * or confirmed by it. Pure; the file is read by `readSheets` (`@dct/shared/xlsx`, which keeps ExcelJS out of the main entry).
 */

export type Cell = string | number | null;
export type Sheet = { name: string; rows: Cell[][] };

export type BudgetDifference = { what: string; contract: number | null; spreadsheet: number | null };
export type BudgetCheck = { sheet: string; compared: number; differences: BudgetDifference[] };

const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * A number cell as the decimal Excel shows: its 15 significant digits (so a formula's 76.99999999999999 is the 77 Excel
 * prints), never rounded to the cent. A string cell as it's written.
 */
const decimal = (c: Cell) => (typeof c === "number" ? String(Number(c.toPrecision(15))) : typeof c === "string" ? c.trim() : "");
/** An amount, or a figure that looks like one (digits, no words but a currency): a price cell, as opposed to a blank, a tick or a note. */
const amountLike = (c: Cell) => typeof c === "number" || (typeof c === "string" && /\d/.test(c) && !/[a-z]/i.test(c.replace(/US\$|USD/gi, "")));
/** Integer cents through parseCents, the one way amounts are read; null when the cell isn't an amount at all. */
const cents = (c: Cell) => (amountLike(c) ? parseCents(decimal(c)) : null);
/** A figure that looks like an amount but isn't one to the cent ("1.005", "1,23"): a difference, never rounded into a match. */
const unreadable = (c: Cell) => amountLike(c) && cents(c) === null;
const text = (c: Cell) => (typeof c === "string" ? c.trim() : "");

/**
 * Each grid against the sheet whose header row names most of its visits (four in five at least): the unit price and
 * every visit cell of each row, the row found by its code (in order, as codes repeat) or else by its name, and each
 * visit's total. A row on one side only is a difference too. Null when no sheet holds any grid's visits: not this
 * contract's budget.
 */
export function budgetCheck(rb: Pick<Rulebook, "budgetGrids">, sheets: Sheet[]): BudgetCheck | null {
  let best: BudgetCheck | null = null;
  for (const g of rb.budgetGrids) {
    const visits = g.visits.map((v) => norm(v.code));
    for (const sh of sheets) {
      const head = sh.rows.findIndex((r) => visits.filter((v) => r.some((c) => typeof c === "string" && norm(c) === v)).length >= Math.max(2, Math.ceil(visits.length * 0.8)));
      if (head < 0) continue;
      const header = sh.rows[head]!;
      const col = new Map(visits.map((v) => [v, header.findIndex((c) => typeof c === "string" && norm(c) === v)]));
      const first = Math.min(...[...col.values()].filter((i) => i >= 0));
      const unit = header.reduce<number>((at, c, i) => (i < first && /\b(?:budget|unit|price|fee|cost)\b/i.test(text(c)) && !/\btotal\b|with\s*oh/i.test(text(c)) ? i : at), -1);
      const code = header.findIndex((c, i) => i < first && /^(?:code|cpt)\b/i.test(text(c)));
      if (unit < 0) continue;
      // a row's name: its longest words left of the unit price (not its code, nor a mark like the overhead tick)
      const label = (r: Cell[]) => r.slice(0, unit).filter((c, i) => i !== code && typeof c === "string").map(text).reduce((a, b) => (b.length > a.length ? b : a), "");
      const body = sh.rows.slice(head + 1).filter((r) => amountLike(r[unit] ?? null) && !visits.some((v) => r.some((c) => typeof c === "string" && norm(c) === v)));
      const used = new Set<Cell[]>();
      const differences: BudgetDifference[] = [];
      let compared = 0;
      const say = (what: string, contract: number | null, cell: Cell) => {
        compared++;
        const spreadsheet = cents(cell);
        if (unreadable(cell)) differences.push({ what: `${what}: the spreadsheet's ${decimal(cell)} can't be read to the cent`, contract, spreadsheet: null });
        else if (contract !== spreadsheet) differences.push({ what, contract, spreadsheet });
      };
      for (const p of g.procedures) {
        const row =
          body.find((r) => !used.has(r) && p.code && code >= 0 && norm(String(r[code] ?? "")) === norm(p.code)) ??
          body.find((r) => !used.has(r) && words(label(r)) === words(p.name));
        if (!row) {
          differences.push({ what: `${p.name}: in the contract, not in the spreadsheet`, contract: p.unitCents, spreadsheet: null });
          continue;
        }
        used.add(row);
        say(`${p.name}: unit price`, p.unitCents, row[unit] ?? null);
        for (const v of g.visits) {
          const at = col.get(norm(v.code))!;
          const c = p.cells[v.code];
          if (c === "invoiceable" || at < 0) continue;
          const s = row[at] ?? null;
          if (c === undefined && !amountLike(s)) continue;
          say(`${p.name} at ${v.code}`, c ?? null, s);
        }
      }
      for (const r of body) if (!used.has(r)) differences.push({ what: `${label(r) || "A row"}: in the spreadsheet, not in the contract`, contract: null, spreadsheet: cents(r[unit] ?? null) });
      const totals = sh.rows.slice(head + 1).find((r) => /\btotal\b/i.test(label(r)) && !/sub\s*-?\s*total|per\s*(?:patient|subject)/i.test(label(r)) && !amountLike(r[unit] ?? null));
      if (totals) for (const v of g.visits) if (col.get(norm(v.code))! >= 0) say(`${v.code} visit total`, v.totalCents, totals[col.get(norm(v.code))!] ?? null);
      // the grid the sheet agrees with most (a revised grid beside the original, or another arm's): its prices that match
      const agree = (c: BudgetCheck) => c.compared - c.differences.length;
      const mine = { sheet: sh.name, compared, differences };
      if (!best || agree(mine) > agree(best)) best = mine;
    }
  }
  return best;
}

const dollars = (c: number | null) => (c === null ? "nothing" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);

/** The start of every notice a check leaves on a version, so a new check replaces the last one. */
export const BUDGET_CHECK = "The sponsor's budget spreadsheet";

/**
 * A version's notices after a write that changed its master (an answer, a typed value): the last check compared prices
 * that may have changed since, so its notice no longer says it matched; it says to check again (which replaces it).
 */
export const staleBudgetCheck = (warnings: string[]) =>
  warnings.map((w) => (w.startsWith(BUDGET_CHECK) ? `${BUDGET_CHECK} was checked before the invoicing master changed, so that check no longer holds: check the spreadsheet again.` : w));

/** The check in plain words, for the version's notices ("Worth knowing"): the signed contract is what's billed. */
export function budgetCheckWords(file: string, c: BudgetCheck): string {
  const head = `${BUDGET_CHECK} “${file}”`;
  if (!c.differences.length) return `${head} matches the signed contract: ${c.compared} prices compared (unit prices, every visit, the visit totals).`;
  const list = c.differences.slice(0, 10).map((d) => (d.contract !== null && d.spreadsheet !== null ? `${d.what}: contract ${dollars(d.contract)}, spreadsheet ${dollars(d.spreadsheet)}` : d.what));
  const more = c.differences.length > 10 ? `; and ${c.differences.length - 10} more` : "";
  return `${head} differs from the signed contract in ${c.differences.length} ${c.differences.length === 1 ? "place" : "places"} (${c.compared} prices compared). The signed contract is what's billed; ask the sponsor which is right: ${list.join("; ")}${more}.`;
}

/** Why a spreadsheet can't be checked, in plain words. */
export const noBudgetWords = (file: string) => `${file} has no sheet with this contract's visits in a header row, so it can't be checked against it. Is it this contract's budget?`;
