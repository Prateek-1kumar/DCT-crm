import { sampleMisses, sampleMissWords, samePerson, settled, type ReviewItem, type RulebookVersionDto, type SettingsDto, type StudySummaryDto, type VersionSummaryDto } from "@dct/shared";
import { formatDate } from "./format";
import { formatCents, parseDollars } from "./money";

/** The pipeline every contract goes through. */
const STAGES = ["Upload", "Reading", "Checking", "Needs you", "Approve", "Live"] as const;
export type Stage = (typeof STAGES)[number];
/** `byHand`: typed in by hand, so Reading and Checking are one step, "Typed by hand". */
export type StageState = { stage: Stage; failed?: boolean; needs?: number; byHand?: boolean };

export const KIND_LABEL: Record<ReviewItem["kind"], string> = {
  confirm_value: "Check a number",
  unaccounted: "Found in the contract",
  contract_problem: "Problem in the contract",
  interpretation: "How should we read this?",
  unclassified: "Bill by hand",
};

/** Why a question is here, in one line, without giving away the tool's reading. */
export function whyLine(i: Pick<ReviewItem, "reason" | "kind">): string {
  switch (i.reason) {
    case "spot_check":
      return "A random spot check. We pick a few numbers at random and ask a person to type them; it proves the checks are working.";
    case "SAMPLE":
      return "A random spot check. This number already matched the PDF, but we pick a few at random for a person to type: it's how we prove the checks miss nothing.";
    case "INTERPRETATION":
      return "How the contract words this decides how it's billed. Read the spot and pick what it means; we don't show our reading, so it can't steer you.";
    case "AMBIGUOUS_TERM":
      return "The wording can be read more than one way. Read the spot and pick what the contract means; we don't show our reading.";
    case "RETROACTIVE_NO_DATE":
      return "Without a start date, the new prices would be billed from the original contract's date. Type the date they apply from, or pick prospective only.";
    case "CORRECTION_NOT_CARRIED":
      return "Someone corrected this on the version in use, but the amendment's reading has a different value here, so the correction wasn't copied over.";
    case "CORRECTION_LOST":
      return "Someone corrected this on the version in use, but the amendment's reading doesn't have it. If it's still in the contract, it has to be billed by hand.";
    case "CAP_KIND_CHANGED":
      return "The kind of limit was changed, so this figure may mean something else now (an amount instead of a count, say). Type what the contract prints.";
    case "reported":
      return "Someone reported this as looking wrong.";
    case "VALUE_CONFLICT":
    case "conflict":
      return "This number didn't match the PDF's own text, so a person needs to read it.";
    case "ungrounded":
    case "UNGROUNDED_VALUE":
      return "We couldn't find this number where the contract should print it.";
    case "SCAN_VALUE":
      return "This contract is a scan, so this number can't be checked against its text.";
    case "SCAN_PAGE":
      return "This page is a scan, so it can't be searched for money terms. Only a person can say what's on it.";
    case "PICTURE_PAGE":
      return "Part of this page is a picture, and a picture can't be searched for money terms. Only a person can say what's in it.";
    case "UNACCOUNTED_TERM":
      return "This is in the contract, but not in the invoicing master. If it's a payment term, it goes on the list to bill by hand.";
    case "VISIT_TOTAL_MISMATCH":
    case "PER_PATIENT_TOTAL_MISMATCH":
      return "The contract's own numbers don't add up, so the contract itself is wrong here. Decide which number to bill, and note what to ask the sponsor.";
    case "REQUIRED_MISSING":
      return "The invoicing master has nothing typed here yet, so it would be approved empty. Type what the contract says.";
    case "HIDDEN_TEXT":
      return "This page has words nobody can see. They're never used as evidence, but someone should check they don't change the money.";
  }
  switch (i.kind) {
    case "unaccounted":
      return "This is in the contract, but not in the invoicing master yet.";
    case "unclassified":
      return "The invoicing master has no place for this kind of term yet, so it's billed by hand.";
    case "contract_problem":
      return "The contract itself doesn't line up here, so someone has to decide.";
    case "interpretation":
      return "The wording can be read more than one way. Pick what the contract means.";
    default:
      return "We couldn't confirm this automatically, so a person needs to read it.";
  }
}

/** For the question list: to do · done · differs (pick one) · can't tell. */
export const itemStatus = (i: ReviewItem): "todo" | "done" | "differs" | "cant_tell" =>
  i.outcome === "matched" || i.outcome === "chosen" ? "done" : i.outcome === "differs" ? "differs" : i.outcome === "cant_tell" ? "cant_tell" : "todo";

/** Still needs a person: unanswered, answered differently, or a blocking "Can't tell". */
export const needsYou = (items: ReviewItem[]) =>
  items.filter((i) => i.outcome === null || i.outcome === "differs" || (i.blocking && i.outcome === "cant_tell"));

/** Blocking first, otherwise in the order the checks listed them. */
export const queueOrder = (items: ReviewItem[]) => [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking));

/** About two minutes per question. */
export const minutesFor = (n: number) => Math.max(1, Math.round(n * 2));

/** For the contracts list. */
export function summaryStage(s: Pick<StudySummaryDto, "status" | "needsYou">): StageState {
  switch (s.status) {
    case "setting_up":
      return { stage: "Upload" };
    case "extracting":
      return { stage: "Reading" };
    case "extraction_failed":
      return { stage: "Reading", failed: true };
    case "live":
      return { stage: "Live" };
    default:
      return s.needsYou > 0 ? { stage: "Needs you", needs: s.needsYou } : { stage: "Approve" };
  }
}

/** Shortcuts into the contracts list (`/?view=…`), shown under Contracts in the sidebar. */
export const VIEWS = [
  { id: "needs-you", label: "Needs you", test: (s: StageState) => s.stage === "Needs you" },
  { id: "approval", label: "Waiting for approval", test: (s: StageState) => s.stage === "Approve" },
  { id: "live", label: "Live", test: (s: StageState) => s.stage === "Live" },
  { id: "failed", label: "Couldn't read", test: (s: StageState) => !!s.failed },
] as const;
export type ViewId = (typeof VIEWS)[number]["id"];

/** For a contract page: from its newest version, and the draft's questions once loaded. */
export function versionStage(latest: Pick<VersionSummaryDto, "status"> | undefined, draft: Pick<RulebookVersionDto, "review" | "byHand"> | undefined): StageState {
  if (!latest) return { stage: "Upload" };
  if (latest.status === "extracting") return { stage: "Reading" };
  if (latest.status === "failed") return { stage: "Reading", failed: true };
  if (latest.status !== "draft") return { stage: "Live" };
  const byHand = draft?.byHand || undefined;
  if (byHand && !draft!.review.length) return { stage: "Reading", byHand }; // still being typed
  const n = draft ? needsYou(draft.review).length : 0;
  return n > 0 ? { stage: "Needs you", needs: n, byHand } : { stage: "Approve", byHand };
}

/** The steps a stepper shows. */
export const stepsFor = (s: StageState): { stage: Stage; label: string }[] =>
  STAGES.filter((x) => !(s.byHand && x === "Checking")).map((x) => ({ stage: x, label: s.byHand && x === "Reading" ? "Typed by hand" : x }));

/** Plain words for where a contract is, and which step that is (1-based) out of how many. */
export function stageWords(s: StageState): { label: string; step: number; of: number } {
  const steps = stepsFor(s);
  const step = s.stage === "Live" ? steps.length : steps.findIndex((x) => x.stage === s.stage) + 1;
  const label = s.failed
    ? "Couldn't read"
    : s.stage === "Upload"
      ? "Details to confirm"
      : s.stage === "Reading"
        ? s.byHand
          ? "Typing by hand"
          : "Reading the contract"
        : s.stage === "Approve"
          ? "Waiting for approval"
          : s.stage;
  return { label, step, of: steps.length };
}

export const stageLabel = (s: StageState) =>
  s.failed ? "Couldn't read" : s.byHand && s.stage === "Reading" ? "Typing by hand" : s.stage === "Needs you" && s.needs ? `Needs you (${s.needs})` : s.stage;

export function pdfCheckLine(pdfCheck: RulebookVersionDto["pdfCheck"]): string {
  if (!pdfCheck)
    return "This PDF is a scan, so its numbers can't be checked against its text and you'll confirm more of them by hand. If you can, ask the sponsor for the signed DocuSign copy.";
  const n = new Intl.NumberFormat("en-US");
  return `${n.format(pdfCheck.matched)} of ${n.format(pdfCheck.values)} numbers match the contract PDF`;
}

/**
 * Mirrors the API's approval rules so the button can explain itself before the 409: every question settled (one not
 * needed to approve too), typing by hand marked done, every number backed by the PDF or a person, after a random spot
 * check missed every value of its kind proofread, and maker-checker (names compared as the API compares them). The API
 * stays the source of truth.
 */
export function approveState(
  version: Pick<RulebookVersionDto, "status" | "review" | "editors" | "rulebook" | "byHand" | "evidence" | "proofread">,
  settings: Pick<SettingsDto, "makerChecker"> | undefined,
  by: string | null,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (version.status !== "draft") reasons.push("Only a draft can be approved.");
  if (!version.rulebook) reasons.push("There is no invoicing master to approve yet.");
  if (version.byHand && !version.review.length) reasons.push("Typing isn't marked done yet, so nobody has re-typed the values.");
  const open = version.review.filter((i) => !settled(i)).length;
  if (open) reasons.push(`${open} ${open === 1 ? "question needs" : "questions need"} an answer first.`);
  const unconfirmed = version.evidence.filter((e) => e.status !== "confirmed" && e.status !== "attested").length;
  // a number that's unconfirmed because its question is open is counted once, as that question
  if (unconfirmed && !open) reasons.push(`${unconfirmed} ${unconfirmed === 1 ? "number isn't" : "numbers aren't"} confirmed by the PDF or a person yet.`);
  for (const m of sampleMisses(version)) if (m.left.length) reasons.push(sampleMissWords(m));
  if (!by) reasons.push("Choose your name first (bottom of the sidebar).");
  else if ((settings?.makerChecker ?? true) && version.editors.some((e) => samePerson(e, by)))
    reasons.push(`Maker-checker is on, and ${by} answered questions on this contract, so someone else has to approve it.`);
  return { allowed: reasons.length === 0, reasons };
}

type Input = NonNullable<ReviewItem["input"]>;

/** What the person typed → the value to send (cents for money), or a message. */
export function parseAnswer(input: Input, raw: string): { value: unknown } | { error: string } {
  const t = raw.trim();
  if (t === "") return { error: "Type what the contract says, or choose “Can't tell”." };
  switch (input) {
    case "money": {
      const c = parseDollars(t);
      return c === null || Number.isNaN(c) ? { error: "Type a dollar amount, like 1,234.56" } : { value: c };
    }
    case "percent":
    case "number": {
      const n = Number(t.replace(/[,%\s]/g, ""));
      return Number.isFinite(n) ? { value: n } : { error: "Type a number" };
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t } : { error: "Pick a date" };
    default:
      return { value: t };
  }
}

export function formatAnswer(input: ReviewItem["input"], v: unknown): string {
  if (v === null || v === undefined) return "nothing";
  if (input === "money" && typeof v === "number" && Number.isInteger(v)) return formatCents(v);
  if (input === "percent") return `${String(v)}%`;
  if (input === "date" && typeof v === "string") return formatDate(v);
  return String(v);
}
