import { parseCents } from "@dct/shared";

/** Money is integer cents. These helpers never do float math on amounts. */

const group = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 123456 → "$1,234.56"; -5 → "−$0.05"; null → "—". */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  if (!Number.isInteger(cents)) throw new Error(`Money must be integer cents, got ${cents}`);
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100); // integer quotient: exact for any safe integer
  const rem = abs % 100;
  const s = `$${group.format(dollars)}.${String(rem).padStart(2, "0")}`;
  return cents < 0 ? `−${s}` : s;
}

/** For editing: 123456 → "1234.56". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const abs = Math.abs(cents);
  const s = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${s}` : s;
}

/**
 * Parse what a person typed ("$1,234.5", "1234", "-12.05") into integer cents, as every amount is read (parseCents,
 * @dct/shared). Returns null for empty input, NaN for anything that isn't a money amount.
 */
export function parseDollars(input: string): number | null {
  if (input.trim() === "") return null;
  return parseCents(input) ?? Number.NaN;
}
