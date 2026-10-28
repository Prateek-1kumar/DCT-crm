/**
 * Dates as contracts print them, read the way the binder reads them (packages/extraction/src/binder.ts), so an answer is
 * compared with a value's printed date the same way in the API and the in-browser sample server.
 */

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const month = (s: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(s.slice(0, 3).toLowerCase()) + 1;
/** The ISO date of a calendar day, or null when there is none (31 June). Two-digit years are 20xx. */
const iso = (y: number, m: number, d: number) => {
  const year = y < 100 ? 2000 + y : y;
  const t = new Date(Date.UTC(year, m - 1, d));
  return t.getUTCFullYear() === year && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
};
/**
 * How contracts print a date: 2025-08-22 · August 22, 2025 · Aug. 22nd 2025 · 22 August 2025 · 22-Aug-25 · the 22nd day of
 * August, 2025 · 8/22/2025 · 22.08.2025. All in numbers, it's read both ways (month/day and day/month): only a day over 12
 * or the same number twice makes it one date.
 * ponytail: dates in words ("the twenty-second day") aren't read; such a date is asked. Upgrade: number words.
 */
const DATES: [RegExp, (m: RegExpExecArray) => (string | null)[]][] = [
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m) => [iso(+m[1]!, +m[2]!, +m[3]!)]],
  [new RegExp(`\\b${MONTH}\\s?(\\d{1,2})(?:st|nd|rd|th)?,?\\s?(\\d{4})\\b`, "gi"), (m) => [iso(+m[3]!, month(m[1]!), +m[2]!)]],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s(?:day\\s)?of)?[\\s-]?${MONTH},?[\\s-]?(\\d{4}|\\d{2})\\b`, "gi"), (m) => [iso(+m[3]!, month(m[2]!), +m[1]!)]],
  [/\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})\b/g, (m) => [iso(+m[4]!, +m[1]!, +m[3]!), iso(+m[4]!, +m[3]!, +m[1]!)]],
];

/** The dates printed in a text, first reading first, with where each sits. */
export function datesIn(s: string): { values: string[]; printed: string; from: number; to: number }[] {
  const out: { values: string[]; printed: string; from: number; to: number }[] = [];
  for (const [re, read] of DATES)
    for (const m of s.matchAll(re)) {
      const [from, to] = [m.index, m.index + m[0].length];
      const values = [...new Set(read(m).filter((v): v is string => v !== null))];
      if (values.length && !out.some((d) => d.from < to && from < d.to)) out.push({ values, printed: m[0], from, to });
    }
  return out;
}

/**
 * The ISO date a printed text says ("Aug. 22nd, 2025" → "2025-08-22"), as the binder reads it; null unless it holds exactly
 * one date that can be read only one way. For comparing a typed date with a value's `printed` text.
 */
export function isoDate(text: string): string | null {
  const d = datesIn(text);
  return d.length === 1 && d[0]!.values.length === 1 ? d[0]!.values[0]! : null;
}
