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
  /** confirmed: the PDF text at that spot says the same · confirmed_by_math: the contract's own arithmetic (row, column, overhead and visit-total sums) proves it, whatever the text says at that spot · attested: a person typed or chose it · conflict: the PDF text says otherwise · ungrounded: not found on the page. */
  status: z.enum(["confirmed", "confirmed_by_math", "attested", "conflict", "ungrounded"]),
  where: z.array(PageBox),
  /** Text printed at that spot, e.g. "4,295.00"; null when nothing was found. */
  printed: z.string().nullable(),
  /** e.g. "page reference corrected from 4 to 9". */
  note: z.string().nullable(),
  /**
   * Every check passed except which visit each column of its table is (the headers didn't say): the id of that table check,
   * and it counts as confirmed only once a person confirms the mapping. The status stays not-confirmed until then.
   */
  held: z.string().optional(),
  /**
   * The read marks this cell "invoiceable" but the page prints nothing in it: the id of the blank check it's asked under
   * (one question per table, never one per cell).
   */
  blank: z.string().optional(),
});
export type ValueEvidence = z.infer<typeof ValueEvidence>;

/** Backed by the PDF's text or the contract's own sums, not a person. */
export const checkedByMachine = (status: ValueEvidence["status"]) => status === "confirmed" || status === "confirmed_by_math";

/** Cells the read calls "invoiceable" in a table that prints them blank: one question per table (reason BLANK_INVOICEABLE, its id = `id`). */
export type BlankCheck = {
  id: string;
  grid: number;
  page: number;
  table: PageBox;
  /** Indexes into the grid's procedures. */
  rows: number[];
  /** The cells' evidence paths; each is marked `blank: id`. */
  cells: string[];
  /** A table check (its id) whose column mapping is held: the group waits for it, and is rejected with it. Absent: the columns were agreed. */
  after?: string;
};

/** A scanned table whose columns line up with the visits by count and order though its headers don't match their names: one person confirms the mapping (a table check). */
export type TableCheck = {
  id: string;
  grid: number;
  page: number;
  columns: { box: PageBox; visit: string }[];
  /** The read's rows placed on the grid's rows by order, not by what they print (`procedure`: index into the grid's procedures); absent: none. */
  rows?: { box: PageBox; procedure: number }[];
};

/**
 * confirm_value: type what the page says (conflicts, values not found, "This looks wrong") · unaccounted: found in the contract but not in the master ·
 * contract_problem: the document itself is inconsistent · interpretation: how a clause should be read · unclassified: a money term the master can't hold yet.
 */
export const ReviewKind = z.enum(["confirm_value", "unaccounted", "contract_problem", "interpretation", "unclassified"]);
export type ReviewKind = z.infer<typeof ReviewKind>;

/**
 * Page kinds (the classifier's, kept with a version's pages) that are neither read by the model nor swept for money terms
 * (ADR-002): an e-signature record, an e-signature legal notice, a reference list with no payment terms, a blank separator or
 * cover sheet ("non_content": also found without the classifier, from the page's own words, see extract.ts). Versions stored
 * before them hold only the older kinds ("boilerplate" included), which are read and swept as before.
 */
export const EXCLUDED_PAGE_KINDS = ["esign_certificate", "esign_disclosure", "reference_appendix", "non_content"] as const;
export const isExcludedPage = (p: { kind: string }) => (EXCLUDED_PAGE_KINDS as readonly string[]).includes(p.kind);

const WHAT_EXCLUDED: Record<(typeof EXCLUDED_PAGE_KINDS)[number], string> = {
  esign_certificate: "an e-signature record",
  esign_disclosure: "an e-signature legal notice",
  reference_appendix: "a reference list with no payment terms",
  non_content: "a blank separator or cover sheet with no numbers",
};

/** "13", "13–14", "3, 13–14": consecutive page numbers run together. */
function pageRuns(pages: number[]): string {
  const runs: string[] = [];
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/**
 * What a draft says about the pages that weren't read: which, why, and where to look (the page viewer in Documents). A page
 * that prints a dollar amount is named, because the classifier can be wrong and an amount there is in no part of the master;
 * so is one whose amounts couldn't be checked (`money: null`: a scan with no text reading), which is said not to be clear.
 */
export function excludedPagesWords(pages: { filename: string; page: number; kind: string; money?: boolean | null }[]): string {
  const parts = [...new Set(pages.map((p) => p.filename))].flatMap((filename) =>
    (Object.keys(WHAT_EXCLUDED) as (keyof typeof WHAT_EXCLUDED)[]).flatMap((kind) => {
      const these = pages.filter((p) => p.filename === filename && p.kind === kind);
      return these.length ? [`page${these.length === 1 ? "" : "s"} ${pageRuns(these.map((p) => p.page))} of “${filename}” (${WHAT_EXCLUDED[kind]})`] : [];
    }),
  );
  const where = (these: typeof pages) => [...new Set(these.map((p) => p.filename))].map((f) => `page${these.filter((p) => p.filename === f).length === 1 ? "" : "s"} ${pageRuns(these.filter((p) => p.filename === f).map((p) => p.page))} of “${f}”`).join("; ");
  const [money, unknown] = [pages.filter((p) => p.money), pages.filter((p) => p.money === null)];
  const check =
    (money.length ? ` ${money.length === 1 ? "One of them prints" : "Some of them print"} a dollar amount: ${where(money)}. Look at ${money.length === 1 ? "it" : "them"} first.` : "") +
    (unknown.length ? ` The amounts on ${where(unknown)} could not be checked, so look at ${unknown.length === 1 ? "it" : "them"} first and add any fee by hand.` : "");
  return `These pages weren't read or searched for money terms, because they look like an e-signature record, an e-signature notice, a reference list or a blank separator or cover sheet: ${parts.join("; ")}.${check} Open them in Documents to make sure. A fee or payment on one of them is not in the invoicing master, so add it yourself.`;
}

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

/** One thing a person must look at, shown one at a time, with our reading and what we suggest (suggest, ADR-003). */
export const ReviewItem = z.object({
  /** Stable within a version. */
  id: z.string(),
  kind: ReviewKind,
  /** Why it is here: an anomaly code, "reported", ... */
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
  /**
   * Where the words a money term quotes are printed, one box per line: its whole sentence, which can run over lines its
   * figures (`where`) aren't on. Absent: `where`.
   */
  quoted: z.array(PageBox).optional(),
  /**
   * A total that doesn't add up (VISIT_TOTAL_MISMATCH, PER_PATIENT_TOTAL_MISMATCH): the total as printed, as it stood
   * when asked or as a person typed it since (answerQuestion), what "the total as printed" puts back after "the sum" was
   * picked. Never "the sum".
   */
  asPrinted: z.number().int().optional(),
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
  /**
   * One of a table check's picks (reason TABLE_CHECK): which table, and the visit the read gave the highlighted column,
   * which the pick is compared with, and which we suggest (suggest).
   */
  table: z.object({ id: z.string(), axis: z.enum(["column"]), expect: z.string() }).optional(),
  /**
   * A blank check on a table whose columns are still to be confirmed (reason BLANK_INVOICEABLE): the id of that table check.
   * Not answerable (409) while set; cleared when the table's picks are all right, and the question closed when they aren't.
   */
  after: z.string().optional(),
  /**
   * The clause the question shows (an interpretation's quote) and its page: questions citing the identical quote on the
   * same page are one card (`cards`), each still answered on its own. Absent: the question is a card of its own.
   */
  cites: z.object({ documentId: z.string(), page: z.number().int(), quote: z.string() }).optional(),
  /**
   * A date the contract ties to its last signature (the effective date, an amendment's start date): the latest date of
   * signature its e-signature record prints, and where, which we suggest (suggest). Never written by itself: a person
   * types or takes it, checked against the record's page in `where`.
   */
  signedOn: z.object({ date: z.string(), page: z.number().int(), printed: z.string() }).optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const settled = (i: ReviewItem) => i.outcome === "matched" || i.outcome === "chosen";

/**
 * Still needs a person ("needs you", in the API and the web alike): anything not settled, a "can't tell" too, on any
 * question. Approval takes every question settled (ADR-001 §6), so a contract with one left isn't waiting for approval.
 */
export const openItems = (items: ReviewItem[]) => items.filter((i) => !settled(i));

/** "Looks right" from someone proofreading. Kept next to the version and never changes its numbers, so a live version takes them too. */
export const ProofreadMark = z.object({ path: z.string(), by: z.string(), at: z.string() });
export type ProofreadMark = z.infer<typeof ProofreadMark>;

/** The marks once `by` has proofread `paths`: one per value, the latest. null when `by` marked them all already, so a repeat changes nothing. */
export function proofreadMarks(marks: ProofreadMark[], paths: string[], by: string, at: string): ProofreadMark[] | null {
  if (paths.every((p) => marks.some((m) => m.path === p && m.by === by))) return null;
  const out = new Map(marks.map((m) => [m.path, m]));
  for (const path of paths) out.set(path, { path, by, at });
  return [...out.values()];
}

/** POST /studies/:id/versions/:v/proofread: these values looked right to `by`. */
export const ProofreadBody = z.object({ paths: z.array(z.string()).min(1).max(5000), by: Person });

/**
 * POST /studies/:id/versions/:v/report: "This looks wrong" on any value. On a draft it adds a blocking confirm_value item;
 * on a live version it opens a correction draft (copy of the live version + that item). Returns the draft.
 */
export const ReportValueBody = z.object({ path: z.string(), note: z.string().min(1), by: Person });

/**
 * POST /studies/:id/versions/by-hand: blank draft for a contract that couldn't be read; every value typed is `attested`.
 * POST /studies/:id/versions/:v/by-hand/done (same body): typing finished; the contract's checks run and every value nobody
 * typed or picked is asked (nothing is re-typed, ADR-003).
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

/** What each review body's fields need, in plain words: a 400 names what's wrong (bodyProblem), in the API, and shown as is by the web. */
export const BODY_WORDS = {
  answer: { by: "Say who is answering.", optionId: "Pick one of the options.", cantTell: "Say whether you can tell.", note: "Write the note as text." },
  values: { path: "Say which value you're typing.", note: "Add a short note about the value.", by: "Say who is typing." },
  report: { path: "Pick a single value to report.", note: "Add a short note saying what looks wrong.", by: "Say who is reporting." },
  proofread: { paths: "Say which values you proofread.", by: "Say who is proofreading." },
  sendBack: { itemIds: "Pick the answers to send back.", note: "Add a note saying what to look at again.", by: "Say who is sending them back." },
  byHand: { by: "Say who is typing." },
  createStudy: { documentIds: "Pick the contract's files (up to 50).", by: "Say who is adding the contract." },
  confirmStudy: { sponsor: "Fill in the sponsor.", protocol: "Fill in the protocol.", siteName: "Fill in the site.", investigator: "Fill in the investigator.", by: "Say who is confirming the details." },
  extract: { documentIds: "Pick the files to add (up to 50).", by: "Say who is starting the read." },
  documentKind: { kind: "Pick what kind of document this is.", by: "Say who is setting the document's kind." },
  settings: { makerChecker: "Say whether maker-checker is on or off.", people: "List the people's names.", by: "Say who is changing the settings.", makerCheckerBy: "Pick your name first: turning maker-checker on or off is signed by whoever does it." },
  readAlerts: { ids: "Pick the alerts to mark as read (up to 100).", by: "Say who is reading the alerts." },
  signOff: { asOf: "Reload the page and approve again: it didn't say which version you saw.", note: "Write the note as text.", by: "Say who is approving." },
  budgetCheck: { by: "Say who is checking." },
} satisfies Record<string, { by: string } & Record<string, string>>;

/** A body's first problem as BODY_WORDS says it; one that isn't a body at all asks who it's from, as every body needs that. */
export function bodyProblem(error: z.ZodError, words: { by: string } & Record<string, string>): string {
  const field = error.issues[0]?.path[0];
  return (typeof field === "string" && words[field]) || words.by;
}
