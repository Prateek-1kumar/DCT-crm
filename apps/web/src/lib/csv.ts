/** One spreadsheet cell: a number stays a number so Excel can add it up. */
export type CsvCell = string | number | null | undefined;

// A cell that starts like a formula would run in Excel; contract text is not ours, so it is made plain text.
const plain = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

const cell = (v: CsvCell) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : plain(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export const toCsv = (rows: CsvCell[][]) => rows.map((r) => r.map(cell).join(",")).join("\r\n");

/** Integer cents as a plain number of dollars ("1234.56"), without float maths; blank for null. */
export function dollars(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  const abs = Math.abs(cents);
  return Number(`${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
}

export const fileSafe = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "export";

export function downloadCsv(name: string, rows: CsvCell[][]) {
  // the BOM makes Excel read the file as UTF-8, so "–" and "é" survive
  const url = URL.createObjectURL(new Blob(["﻿", toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileSafe(name)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
