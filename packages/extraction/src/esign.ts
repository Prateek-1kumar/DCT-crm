import { datesIn } from "@dct/shared";
import type { TextPage } from "./textlayer";

/**
 * The dates of signature an e-signature record prints (a signing certificate, an audit trail), read from the page's own
 * text, no AI. The record is never read by the model (ADR-002), but a contract that takes effect on its last signature
 * dates itself there, so the review suggests that date. Never evidence: a person confirms it on the page.
 */

/**
 * An event word names what the date after it is, in any vendor's wording: "Signed: 3/4/2024", "Signature Date: 2023-08-16",
 * "Completed … 22-Oct-2025", "Executed on". "Sent", "Viewed", "Created", "Emailed … for signature" and the like are other
 * events. The event word nearest before a date (since the date before it) decides; none, and the date is nobody's signing.
 */
const EVENT = /\b(?:(e-?signed|signed|signature\s+date|date\s+signed|signing\s+complete[d]?|completed?|executed)|sent|resent|viewed|opened|delivered|created|e-?mailed|accepted|received|uploaded|generated|printed|expire[sd]?|declined|voided|reassigned|for\s+signature)\b/gi;
/** How far before a date its event word may sit: a label and a column's filler ("Completed  Security Checked  3/4/2024"). */
const REACH = 80;
const NUMERIC = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$/;

type Dated = { values: string[]; printed: string };

// a scan's or OCR's characters aren't the signed ones: a misread digit would be a wrong date offered
const textOf = (p: TextPage) => (p.source === "text" ? p.words.filter((w) => !w.hidden).map((w) => w.text).join(" ") : "");

/** The dates of signature on one page of an e-signature record, each with its readings (two for "3/4/2024"). Text pages only. */
export function signingDates(p: TextPage): Dated[] {
  const text = textOf(p);
  const dates = datesIn(text).sort((a, b) => a.from - b.from);
  return dates.flatMap((d, i) => {
    const before = text.slice(Math.max(d.from - REACH, dates[i - 1]?.to ?? 0), d.from);
    const last = [...before.matchAll(EVENT)].at(-1);
    return last?.[1] ? [{ values: d.values, printed: d.printed }] : [];
  });
}

/**
 * The latest date of signature in one document's e-signature record (its pages), or null when it prints none or can't be
 * read one way: an all-number date ("3/4/2024") reads month first and day first alike, and only another all-number date
 * on the record with a day over 12 ("3/14/2024", any event's) tells which. Still two ways, the record gives a date only
 * when both readings give the same latest one. Never a guess: a wrong date offered is worse than none.
 */
export function lastSigned(pages: TextPage[]): { date: string; printed: string; documentId: string; page: number } | null {
  const all = pages.flatMap((p) => signingDates(p).map((d) => ({ ...d, documentId: p.documentId, page: p.page })));
  // month first or day first, as the record's all-number dates that read one way show, any event's ("3/14/2024": month first)
  const orders = new Set(
    pages.flatMap((p) => datesIn(textOf(p))).flatMap((d) => {
      const m = NUMERIC.exec(d.printed);
      return m && d.values.length === 1 && Number(m[1]) !== Number(m[3]) ? [Number(m[1]) > 12 ? ("dm" as const) : ("md" as const)] : [];
    }),
  );
  if (orders.size > 1) return null; // the record contradicts itself
  // datesIn gives an all-number date month first, then day first
  const latest = (order: "md" | "dm") =>
    all.map((d) => ({ ...d, date: d.values[d.values.length > 1 && order === "dm" ? 1 : 0]! })).reduce<{ date: string; printed: string; documentId: string; page: number } | null>((a, b) => (!a || b.date > a.date ? b : a), null);
  const [md, dm] = orders.size ? [latest([...orders][0]!), latest([...orders][0]!)] : [latest("md"), latest("dm")];
  if (!md || !dm || md.date !== dm.date) return null;
  return { date: md.date, printed: md.printed, documentId: md.documentId, page: md.page };
}
