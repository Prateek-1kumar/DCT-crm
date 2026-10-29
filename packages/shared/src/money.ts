/**
 * Amounts and percentages as contracts print them and people type them, read one way everywhere: the binder, the
 * bill-by-hand list, answers, search and the web. By string, never float math on amounts.
 */

// A full stop, comma or colon after the number ends the sentence; it isn't part of the number ("$7,455.00.").
const tail = (s: string) => s.trim().replace(/[.,;:]+$/, "");
// Digits grouped by thousands ("12,000") or not ("12000"); a comma anywhere else ("1,23") isn't an amount.
const WHOLE = "\\d{1,3}(?:,\\d{3})+|\\d+";
const AMOUNT = new RegExp(`^([-−])?\\s*(?:US\\$|USD|\\$)?\\s*([-−])?\\s*(${WHOLE})?(?:\\.(\\d{0,2}))?$`, "i");

/**
 * Integer cents of an amount: "$1,234.56", "1234.5", "US$ 98", "-12.05", "$7,455.00.". In brackets, "(1,500.00)" is a
 * credit and comes out below zero (a bracket on one side only isn't), unless `restates`: brackets that restate an amount in words ("Three Thousand Dollars
 * ($3,000.00)", the binder decides from the word before). null for anything else, a third decimal too: the master holds
 * whole cents, so a fraction of one is asked, never rounded into a match.
 */
export function parseCents(text: string, { restates = false } = {}): number | null {
  let t = tail(text);
  const bracket = /^\((.*)\)$/.exec(t);
  // a bracket closed in another word ("($500.00 per visit)") opens a remark, not a credit
  t = bracket ? tail(bracket[1]!) : t.replace(/^\(|\)$/, "");
  const m = AMOUNT.exec(t);
  if (!m || (!m[3] && !m[4]) || (m[1] && m[2])) return null;
  const cents = Number.parseInt((m[3] ?? "0").replace(/,/g, ""), 10) * 100 + Number.parseInt((m[4] ?? "").padEnd(2, "0"), 10);
  if (!Number.isSafeInteger(cents)) return null;
  return (!!bracket && !restates) !== !!(m[1] || m[2]) ? -cents : cents;
}

/**
 * A percentage or plain number: "1.5%", "1.5%.", "40 percent", "45", "1,000". null when it isn't one (a word, "4,5",
 * "%" alone): never NaN, and never 0 for nothing.
 */
export function parsePercent(text: string): number | null {
  const m = new RegExp(`^([-−])?\\s*(${WHOLE})?(?:\\.(\\d+))?\\s*(?:%|percent|per\\s*cent)?$`, "i").exec(tail(text));
  if (!m || (!m[2] && !m[3])) return null;
  const n = Number(`${m[1] ? "-" : ""}${(m[2] ?? "0").replace(/,/g, "")}.${m[3] ?? "0"}`);
  return Number.isFinite(n) ? n : null;
}
