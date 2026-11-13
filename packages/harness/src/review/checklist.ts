import type { Question, Rulebook, Source } from "@dct/shared";
import { checkQuote } from "../checks/quote";
import type { LoadedDoc } from "../types";
import { TOPICS, TOPIC_IDS, type ChecklistEntry, type Finding, type TopicId } from "./schema";

/** What the review concluded on one topic, kept with the read so a scorer can see which topics were examined. */
export interface TopicResult {
  topic: TopicId;
  verdict: ChecklistEntry["verdict"] | "not_reported";
  doc: string | null;
  page: number | null;
  quote: string | null;
  /** Ids of the questions raised for this topic. */
  questions: string[];
  /** Plain English, when the model's entry did not hold up; null when it did. */
  problem: string | null;
}

const HEADINGS: [TopicResult["verdict"], string][] = [
  ["open", "needs a decision"],
  ["already_asked", "already asked"],
  ["contract_settles", "settled by the contract"],
  ["not_in_contract", "not in this contract"],
  ["not_reported", "not reported"],
];

/**
 * A topic the model marked as needing a person but wrote no usable question for. Asked in general words rather than
 * sent back to the model: a second call costs as much as the review, and losing the topic silently is the failure the
 * checklist exists to stop. It always holds up approval, since nobody has said what it is worth.
 */
function fallback(topic: TopicId, source: Source): Question {
  return {
    id: `review:topic:${topic}`,
    kind: "decision",
    origin: "reviewer",
    about: null,
    question: `Please check ${TOPICS[topic]}: does the rulebook handle it the way the contract does?`,
    context: "The second reader marked this as something a person must decide, but did not write up the question. Look at the contract for it before approving.",
    source,
    options: [
      { label: "Yes, I checked: the rulebook is right", patches: [] },
      { label: "No, the rulebook needs a change", patches: [] },
    ],
    suggestion: null,
    state: "open",
    blocking: true,
    readings: [],
    resolution: null,
  };
}

/**
 * Holds the model's checklist to what code can prove, without another model call. `raised` are the questions made from
 * `findings` (id `review:<position>`). Returns one result per topic, in the fixed order, and the fallback questions.
 */
export function checkChecklist(
  entries: ChecklistEntry[],
  findings: Finding[],
  raised: Question[],
  rulebook: Rulebook,
  docs: LoadedDoc[],
  log: string[],
): { topics: TopicResult[]; questions: Question[] } {
  const questions: Question[] = [];
  const topics = TOPIC_IDS.map((topic): TopicResult => {
    const [entry, ...repeats] = entries.filter((e) => e.topic === topic);
    const asked = raised.filter((q) => findings[Number(q.id.slice("review:".length))]?.topic === topic).map((q) => q.id);
    const { verdict = "not_reported" as const, doc = null, page = null, quote = null } = entry ?? {};
    const result: TopicResult = { topic, verdict, doc, page, quote, questions: asked, problem: null };
    const fail = (problem: string) => {
      result.problem = problem;
      log.push(`Second reader's checklist, ${TOPICS[topic]}: ${problem}`);
    };

    if (repeats.length) log.push(`Second reader's checklist, ${TOPICS[topic]}: reported more than once, so the first report was used`);
    if (asked.length) {
      // a question was raised, which is the safe outcome whatever the verdict said
      if (verdict !== "open") result.verdict = "open";
    } else if (!entry) {
      fail("the second reader did not report on this, so it was not checked");
    } else if (verdict === "open" || (verdict === "already_asked" && !rulebook.questions.some((q) => q.state === "open"))) {
      const cited: Source = { doc: doc ?? "", page: page ?? 0, quote: quote ?? "" };
      const onPage = docs.find((d) => d.name === cited.doc)?.pages.some((p) => p.page === cited.page);
      const source = onPage ? { ...cited, quote: checkQuote(cited, docs) ? "" : cited.quote } : { doc: docs[0]!.name, page: 1, quote: "" };
      questions.push(fallback(topic, source));
      result.questions = [`review:topic:${topic}`];
      fail(verdict === "open" ? "marked as needing a decision with no usable question, so a general question was raised" : "marked as already asked, but no question is open, so a general question was raised");
    } else if (verdict === "contract_settles") {
      const missing = doc === null || page === null || !quote ? "no quote was given" : checkQuote({ doc, page, quote }, docs);
      if (missing) fail("said to be settled by the contract, but the words quoted could not be found on the page cited, so this is not confirmed");
    }
    return result;
  });

  const summary = HEADINGS.flatMap(([verdict, heading]) => {
    const names = topics.filter((t) => t.verdict === verdict).map((t) => TOPICS[t.topic]);
    return names.length ? [`${heading}: ${names.join("; ")}`] : [];
  });
  log.push(`Second reader's checklist. ${summary.join(". ")}.`);
  return { topics, questions };
}
