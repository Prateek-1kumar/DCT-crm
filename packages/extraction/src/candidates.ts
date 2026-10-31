import { parseCents } from "@dct/shared";

/**
 * The cents a noisy OCR word may mean (the senior engineer's guide, Step 2.2, `parse_ocr_numeric_candidates`), all by string
 * and integer, never float math: every candidate is built as text and read by `parseCents`, so an OCR word can't become an
 * amount the master couldn't hold (a third decimal is no candidate).
 *
 * Owner's decision: for words of OUR OCR only (the binder never calls this for a PDF's own text), a read value matches a word
 * when it is any of these (of the rules that are on: two are off by default, see `OFF_BY_DEFAULT`). The old exact rule is overridden for exactly these noise classes, nothing wider. The plain parse is
 * always one of them, so a clean price never loses a match it had.
 *
 * Deviations from the guide's Python, each on the safe side:
 * - the plain reading is `parseCents`' (grouped commas only), where the guide dropped every comma ("185,00" was also 18500
 *   dollars): a malformed grouping is no candidate;
 * - the guide's "-45" → ".45" (its colon/hyphen rule has nothing before the hyphen to test) can't happen: a digit must come first;
 * - the leading-5 rule is for words with no "$" (the guide stripped the "$" first, so "$526" lost a 5 as well), and it
 *   never yields zero ("50.00" is not a free visit);
 * - "4.070.00" (dot thousands and dot decimal) is read as the dot rule intends, which the guide's regex missed.
 * - the leading-5 rule needs three digits or more ("526", "574", "530.171") and skips a word that ends in a two-decimal fraction
 *   ("55.00", "185,00", "574:00"). Measured on the four scans (ocr-eval, 2026-10-31): the guide's form confirmed 3 more values
 *   in all and let 15 planted digit errors through (COPD 12, HCWC 2, Shah 1: a printed "55.00" or "55" matched a read of 5.00
 *   or 5, the dropped digit). Narrowed as above it gained 0 confirmed values on every scan with our OCR, so it is now off by
 *   default too (`OFF_BY_DEFAULT`): a rule that gains nothing and can only let a wrong value match is dead weight. The code
 *   stays, one switch from on. Switchable in `RULES`.
 */
export type Rule = "decimal" | "thousands" | "missingPoint" | "dollarAsFive";
export const RULES: readonly Rule[] = ["decimal", "thousands", "missingPoint", "dollarAsFive"];

const cents = (s: string) => parseCents(s);

/** What `s` can mean by the first three rules (the leading "$" is already dealt with). */
function shapes(s: string, rules: ReadonlySet<Rule>): number[] {
  const out: (number | null)[] = [];
  // a comma, as the decimal point, before two digits; whatever comes before it is whole dollars, grouped by dots or commas or not
  const eu = /^(\d+(?:[.,]\d{3})*),(\d{2})$/.exec(s);
  if (rules.has("decimal") && eu) out.push(cents(`${eu[1]!.replace(/[.,]/g, "")}.${eu[2]}`));
  // a dot as the thousands separator: "530.171" is 530171 dollars; "4.070.00" is 4070.00
  const dots = /^(\d+(?:\.\d{3})+)(?:\.(\d{2}))?$/.exec(s);
  if (rules.has("thousands") && dots) out.push(cents(`${dots[1]!.replace(/\./g, "")}${dots[2] ? `.${dots[2]}` : ""}`));
  return out.filter((x): x is number => x !== null);
}

/**
 * Rules that are off unless asked for. missingPoint ("4500" is also 45.00) gained no confirmed value on the four scans, and
 * with it on a printed whole price that ends in 00 confirmed a read one hundredth of it: the planted decimal-point error got
 * through 81 times on one contract and 52 on another (ocr-eval, 2026-10-31). dollarAsFive ("526" is also 26) gained no
 * confirmed value on any scan with our OCR (senior engineer's review, owner's decision: no dead heuristics). Both of the guide's
 * rules stay here, one switch from on.
 */
export const OFF_BY_DEFAULT: ReadonlySet<Rule> = new Set<Rule>(["missingPoint", "dollarAsFive"]);

export function ocrCandidates(raw: string, off: ReadonlySet<Rule> = OFF_BY_DEFAULT): Set<number> {
  const rules = new Set(RULES.filter((r) => !off.has(r)));
  const out = new Set<number>();
  const add = (n: number | null | undefined) => n != null && out.add(n);
  // whitespace goes as the binder's own `cents` takes it; a trailing full stop or comma ends the sentence
  const word = raw.replace(/\s+/g, "").replace(/[.,;:]+$/, "");
  if (!/\d/.test(word) || word.length > 24) return out;
  add(cents(raw));
  const marked = /\$|USD/i.test(word);
  // only a currency mark in front is dropped; a "$" anywhere else in the word is no price's
  let t = word.replace(/^(\(?)(?:US\$|USD|\$)/i, "$1");
  // a colon or hyphen before two final digits is a decimal point ("47:00", "172-00")
  if (rules.has("decimal")) t = t.replace(/(?<=\d)[:-](\d{2})$/, ".$1");
  add(cents(t));
  shapes(t, rules).forEach(add);
  // a point lost before "00": "4500" is 45.00 (as cents, the digits themselves)
  if (rules.has("missingPoint") && /^\d+00$/.test(t)) add(cents(`${t.slice(0, -2)}.00`));
  // a "$" read as 5: "526" is 26, "574" is 74, "530.171" is 30171 dollars
  if (rules.has("dollarAsFive") && !marked && /^5\d\d/.test(t) && !/[.,]\d{2}$/.test(t)) {
    const rest = t.slice(1);
    add(cents(rest) || null);
    shapes(rest, rules).filter((n) => n > 0).forEach(add);
  }
  return out;
}
