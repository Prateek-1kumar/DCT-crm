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
 * Parse what a person typed ("$1,234.5", "1234", "-12.05") into integer cents by string
 * manipulation. Returns null for empty input, NaN for anything that isn't a money amount.
 */
export function parseDollars(input: string): number | null {
  const t = input.trim().replace(/[$,\s]/g, "");
  if (t === "") return null;
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[2] === "" && !m[3])) return Number.NaN;
  const whole = Number.parseInt(m[2] || "0", 10);
  const frac = Number.parseInt((m[3] ?? "").padEnd(2, "0") || "0", 10);
  const cents = whole * 100 + frac;
  return m[1] ? -cents : cents;
}
