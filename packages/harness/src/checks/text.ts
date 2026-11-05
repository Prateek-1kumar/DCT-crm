import { parseCents } from "@dct/shared";

// The bare form takes unseparated thousands ("1746.00"), which a printed budget often has; missing one is the unsafe error.
const AMOUNT = /(?:US\$|USD|\$)\s?\d[\d,]*(?:\.\d{2})?|\b(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\b/g;

export function amountsAt(text: string): { text: string; cents: number; start: number; end: number }[] {
  return [...text.matchAll(AMOUNT)].flatMap((m) => {
    const cents = parseCents(m[0]);
    return cents === null ? [] : [{ text: m[0], cents, start: m.index, end: m.index + m[0].length }];
  });
}

export const amountsIn = (text: string): number[] => amountsAt(text).map((a) => a.cents);

export function usd(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${cents < 0 ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
