import { amountsAt, amountsIn, normalise } from "../checks/text";
import type { Transcription } from "./transcribe";

/** A printed row or line that carries money, as one reader saw it. `cents` keeps one slot per table column, null where a cell holds no amount. */
export interface MoneyRow {
  label: string;
  top: number;
  bottom: number;
  columns: string[];
  texts: string[];
  cents: (number | null)[];
  /** The reader wasn't sure of a character, or saw handwriting or a strike-through: never accepted on agreement alone. */
  doubtful: boolean;
}

const cellCents = (text: string) => {
  const found = amountsIn(text);
  return found.length === 1 ? found[0]! : null;
};

export function moneyRows(t: Transcription): MoneyRow[] {
  const rows = t.tables.flatMap((table) =>
    table.rows.map((r) => ({
      label: r.label,
      top: r.top,
      bottom: r.bottom,
      columns: table.columns.slice(1),
      texts: r.cells.map((c) => c.text),
      cents: r.cells.map((c) => cellCents(c.text)),
      doubtful: r.cells.some((c) => c.unsure || c.marks.length > 0),
    })),
  );
  const lines = t.lines.map((l) => ({
    label: amountsAt(l.text).reduceRight((t, a) => t.slice(0, a.start) + t.slice(a.end), l.text).trim(),
    top: l.top,
    bottom: l.bottom,
    columns: [],
    texts: [l.text],
    cents: amountsIn(l.text),
    doubtful: l.unsure || l.marks.length > 0,
  }));
  return [...rows, ...lines].filter((r) => r.cents.some((c) => c !== null));
}

const key = (label: string) => normalise(label).replace(/[^a-z0-9]/g, "");
const overlap = (a: MoneyRow, b: MoneyRow) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const same = (a: MoneyRow, b: MoneyRow) => a.cents.length === b.cents.length && a.cents.every((c, i) => c === b.cents[i]);

export interface Dispute {
  id: string;
  a: MoneyRow | null;
  b: MoneyRow | null;
}

/**
 * Pairs each row of one reading with the other's: same label first, then the row that overlaps it most on the page.
 * Rows that differ in any cell (blank cells included, so a value one column over is a difference), or that only one
 * reader saw, are disputes.
 */
export function compareReadings(a: MoneyRow[], b: MoneyRow[]): { agreed: MoneyRow[]; disputes: Dispute[] } {
  const left = new Set(b);
  const agreed: MoneyRow[] = [];
  const disputes: Dispute[] = [];
  for (const row of a) {
    const candidates = [...left];
    const match =
      candidates.find((r) => key(r.label) === key(row.label) && key(row.label) && overlap(r, row) > 0) ??
      candidates.filter((r) => overlap(r, row) > 0).sort((p, q) => overlap(q, row) - overlap(p, row))[0];
    if (match) left.delete(match);
    if (match && same(row, match) && !row.doubtful && !match.doubtful) agreed.push(row);
    else disputes.push({ id: `d${disputes.length + 1}`, a: row, b: match ?? null });
  }
  for (const row of left) disputes.push({ id: `d${disputes.length + 1}`, a: null, b: row });
  return { agreed, disputes };
}
