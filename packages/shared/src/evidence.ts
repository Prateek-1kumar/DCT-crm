import { z } from "zod";

/**
 * Evidence and review queue (docs/phase-1/adr-001-extraction-evidence.md).
 * A value is unconfirmed until the PDF's own text or a person confirms it.
 */

/** A spot on a contract page. */
export const PageBox = z.object({
  documentId: z.string(),
  page: z.number().int().positive(),
  /** x, y, width, height as fractions (0–1) of the page as stored in the PDF; null when only the page is known. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export type PageBox = z.infer<typeof PageBox>;

/** What backs one rulebook value. */
export const ValueEvidence = z.object({
  /** JSON pointer into the rulebook, e.g. "/budgetGrids/0/procedures/3/cells/V2". */
  path: z.string(),
  /** confirmed: the PDF text at that spot says the same · attested: a person typed or chose it · conflict: the PDF text says otherwise · ungrounded: not found on the page. */
  status: z.enum(["confirmed", "attested", "conflict", "ungrounded"]),
  where: z.array(PageBox),
  /** Text printed at that spot, e.g. "4,295.00"; null when nothing was found. */
  printed: z.string().nullable(),
  /** e.g. "page reference corrected from 4 to 9". */
  note: z.string().nullable(),
});
export type ValueEvidence = z.infer<typeof ValueEvidence>;

/**
 * confirm_value: type what the page says (conflicts, values not found, spot checks) · unaccounted: found in the contract but not in the master ·
 * contract_problem: the document itself is inconsistent · interpretation: how a clause should be read · unclassified: a money term the master can't hold yet.
 */
export const ReviewKind = z.enum(["confirm_value", "unaccounted", "contract_problem", "interpretation", "unclassified"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

/** Who did something: the name picked in "Who's working today?". Edge spaces are dropped, so one person is one name. */
export const Person = z.string().trim().min(1);
/** Whether two names are the same person: as typed, ignoring edge spaces and case. */
export const samePerson = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const ReviewAnswer = z.object({
  /** Typed value: cents for money, a number for % / days / counts, ISO date, or text. */
  value: z.unknown().optional(),
  optionId: z.string().optional(),
  cantTell: z.boolean().optional(),
  note: z.string().optional(),
  /**
   * Settled a mismatch that the PDF's text couldn't decide (a scan, or a value the check didn't find): it rests on this
   * person's reading of the page, and the note says where the page prints it. The approver sees these marked.
   */
  noPdfText: z.boolean().optional(),
  by: z.string(),
  at: z.string(),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

/** One thing a person must look at, shown one at a time. Never carries the tool's reading before it is answered (blind entry). */
export const ReviewItem = z.object({
  /** Stable within a version. */
  id: z.string(),
  kind: ReviewKind,
  /** Why it is here: an anomaly code, "spot_check", ... */
  reason: z.string(),
  path: z.string().nullable(),
  /** Plain-language question, e.g. "What amount is printed for the Visit 4 total?" */
  question: z.string(),
  /** What the person types; null for choice items. */
  input: z.enum(["money", "percent", "number", "date", "text"]).nullable(),
  /**
   * Choices, none pre-selected. `note`: picking this one needs a note, and this is what it asks, e.g. "What should we ask
   * the sponsor?" (a question that's not needed to approve clears by a reason from a fixed list plus a note, ADR-001 §6).
   */
  options: z.array(z.object({ id: z.string(), label: z.string(), note: z.string().optional() })),
  /**
   * A money term found in the PDF's text that the master doesn't hold (UNACCOUNTED_TERM): its words and figures, listed
   * to bill by hand if that's the answer. The question shows the same words.
   */
  term: z.object({ quote: z.string(), amounts: z.array(z.number().int()), pct: z.number().optional(), days: z.number().int().optional() }).optional(),
  where: z.array(PageBox),
  /** Must be settled before approval. */
  blocking: z.boolean(),
  answer: ReviewAnswer.nullable(),
  /** matched / chosen settle the item; differs keeps it open and fills `compare`; cant_tell leaves it for the approver. */
  outcome: z.enum(["matched", "differs", "chosen", "cant_tell"]).nullable(),
  /** Filled only after a typed answer differs from the reading. */
  compare: z.object({ typed: z.unknown(), read: z.unknown(), printed: z.string().nullable() }).nullable(),
  /** The approver reopened this answer with a note; cleared when it's answered again. */
  sentBack: z.object({ by: z.string(), note: z.string(), at: z.string() }).nullable(),
  /** "This looks wrong": who reported the value and why; kept once it's answered, as the record of why it was asked. */
  reported: z.object({ by: z.string(), note: z.string(), at: z.string() }).nullable().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const settled = (i: ReviewItem) => i.outcome === "matched" || i.outcome === "chosen";

/** "Looks right" from someone proofreading. Kept next to the version and never changes its numbers, so a live version takes them too. */
export const ProofreadMark = z.object({ path: z.string(), by: z.string(), at: z.string() });
export type ProofreadMark = z.infer<typeof ProofreadMark>;

/** POST /studies/:id/versions/:v/proofread: these values looked right to `by`. */
export const ProofreadBody = z.object({ paths: z.array(z.string()).min(1).max(5000), by: Person });

/**
 * POST /studies/:id/versions/:v/report: "This looks wrong" on any value. On a draft it adds a blocking confirm_value item;
 * on a live version it opens a correction draft (copy of the live version + that item). Returns the draft.
 */
export const ReportValueBody = z.object({ path: z.string(), note: z.string().min(1), by: Person });

/**
 * POST /studies/:id/versions/by-hand: blank draft for a contract that couldn't be read; every value typed is `attested`.
 * POST /studies/:id/versions/:v/by-hand/done (same body): typing finished; a different person re-types up to 10 random values blind.
 */
export const ByHandBody = z.object({ by: Person });

/** POST /studies/:id/versions/:v/send-back: the approver reopens answered questions with a note; the contract goes back to Needs you. */
export const SendBackBody = z.object({ itemIds: z.array(z.string()).min(1).max(1000), note: z.string().min(1), by: Person });

/** POST /studies/:id/versions/:v/review/:itemId. Also changes an earlier answer while the version is a draft. */
export const AnswerReviewBody = z.object({
  value: z.unknown().optional(),
  optionId: z.string().optional(),
  cantTell: z.boolean().optional(),
  /**
   * Required when settling a "differs" item: with a value other than the PDF's own text (why the text is wrong), or, where
   * the PDF's text prints nothing to decide it, with either value (where the page prints it).
   */
  note: z.string().optional(),
  by: Person,
});

// ---- Notes never give a withheld value away ----

const BLANK = "•••";
const MONTH = "january|february|march|april|may|june|july|august|september|october|november|december|(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\b\\.?";
const ORD = "(?:st|nd|rd|th)?";
const WORD = "zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen";
const JOIN = "[\\s-]+(?:and[\\s-]+)?";
// "one" is mostly a pronoun ("which one", "no one"): a number only inside a compound, as "one (1)", or before a unit
const ONE = `one(?:${JOIN}(?:${WORD}|one))+|one(?=\\s*\\(\\s*\\d|\\s+(?:per|days?|weeks?|months?|years?|percent|dollars?|cents?|times|business)\\b)`;
// Words a number after them only points at a place in the documents or names a row or visit. No withheld value is
// counted in weeks or visits; day, month and year are left out because days, months and dates are values.
const PLACE = "pages?|pp?\\.|pg\\.?|sections?|sec\\.|clauses?|articles?|paragraphs?|para\\.|exhibits?|attachments?|appendix|appendices|schedules?|amendments?|annex(?:es)?|addend(?:um|a)|tables?|rows?|lines?|columns?|col\\.|items?|visits?|weeks?|versions?|cpt|codes?";
// …unless a unit follows, which makes it a quantity again ("page 30 days" is 30 days)
const UNIT = "%|percent|per\\s*cent|days?\\b|business\\b|weeks?\\b|months?\\b|years?\\b|hours?\\b|dollars?\\b|cents?\\b|usd\\b|times\\b";
const NOTE_NUMBERS = new RegExp(
  [
    `(?<place>(?:\\b(?:${PLACE})|§§?)\\s*(?:no\\.?\\s*|#\\s*)?\\d+(?:\\.\\d+)*(?:\\([a-z\\d]{1,3}\\))*(?:\\s*[-–]\\s*\\d+(?:\\.\\d+)*)?(?!\\d|,\\d|\\.\\d|\\s*(?:${UNIT})))`,
    `(?<date>\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b|\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b(?:\\d{1,2}${ORD}\\s+(?:of\\s+)?)?(?:${MONTH})(?:\\s+\\d{1,2}${ORD}\\b)?(?:,?\\s+\\d{4})?\\b|\\b(?:q[1-4]\\s+\\d{4}|fy\\s?\\d{2,4})\\b)`,
    `(?<words>\\b(?:(?:${WORD})(?:${JOIN}(?:${WORD}|one))*|${ONE})\\b)`,
    `(?<code>\\b[a-z][a-z\\d]*(?:[-_][a-z\\d]+)*)`,
    `(?<num>\\d+(?:,\\d{3})*(?:\\.\\d+)?)`,
  ].join("|"),
  "gi",
);
const digits = (s: string) => s.replace(/\d+/g, BLANK);

/**
 * A note as it may be shown while the value it's about is withheld (blind entry): every number that could be, or
 * give away, a value is blanked, so "Should be $104, see page 4" reads "Should be $•••, see page 4".
 * - Blanked: amounts ($, commas, decimals), percentages, counts and durations (45 days, net 45), ordinals, every bare
 *   number, dates whole (2026-09-01, Sept 1, 2026; a month name on its own too, except "may"), and numbers in words
 *   ("forty-five", "ten (10)", as contracts print them; "one" only as a number: "twenty-one", "one (1)", "one day").
 * - Kept: numbers that only say where to look or name something: after page, §, section, clause, exhibit, attachment,
 *   schedule, amendment, table, row, line, column, item, visit, week, version or code (not when a unit follows); and
 *   codes that start with letters, in capitals or one or two letters (V2, SC003, NWP-418-02), except Net45 and USD100.
 * When in doubt, blank: a blanked number costs a look at the page, a shown one can steer a blind answer.
 */
export function blankNumbers(text: string): string {
  return text.replace(NOTE_NUMBERS, (m, place?: string, date?: string, words?: string, code?: string) => {
    if (place) return m;
    if (date) return /\d/.test(m) || !/^(?:may|[a-z]{3}\.?)$/i.test(m) ? BLANK : m;
    if (words) return BLANK;
    if (code) {
      if (!/\d/.test(m)) return m;
      if (/^(?:net|usd|eur|gbp|cad|aud|chf)[-_]?\d/i.test(m)) return digits(m);
      const head = /^[a-z]+/i.exec(m)![0];
      return head === head.toUpperCase() || (head.length <= 2 && !/[-_]/.test(m)) ? m : digits(m);
    }
    return BLANK;
  });
}
