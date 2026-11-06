import { Region, type Accounted, type Grid, type Question, type Relation, type Rulebook, type Study, type Term } from "@dct/shared";
import { z } from "zod";
import { SCAN_PAGE_REASON, checks } from "../checks";
import { citeGrid, citeTerm } from "../checks/cells";
import { checkRelation } from "../checks/relations";
import { pdfReader } from "../pdf";
import type { LoadedDoc } from "../types";
import { SCAN_NOTE } from "./prompt";
import { normalizeAccounted, normalizeGrid, normalizeQuestion, normalizeRelation, normalizeStudy, normalizeTerm, type Parsed } from "./normalize";

export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
}

export interface ToolOutcome {
  content: string | ImageBlock[];
  isError: boolean;
  /** What the trace keeps of the result (never an image). */
  summary: string;
  /** One plain-English line for the person watching the read. */
  progress: string;
}

export type Ending = "done" | "finishes_exhausted";

const MAX_PAGES_PER_READ = 15;
const MAX_SEARCH_HITS = 60;
const MAX_PROBLEM_LINES = 80;
const MAX_SHOWN = 5;

const NOT_READ = "Not read";
const NO_STUDY: Study = { protocol: NOT_READ, sponsor: NOT_READ, payer: null, siteEntity: NOT_READ, siteNumber: null, pi: null, effectiveDate: null, documents: [] };

const ReadArgs = z.object({ doc: z.string(), pages: z.array(z.number().int()).min(1) });
const ViewArgs = z.object({ doc: z.string(), page: z.number().int(), region: Region.optional(), dpi: z.number().int().positive().optional() });
const SearchArgs = z.object({ pattern: z.string().min(1) });
const StudyArgs = z.object({ study: z.unknown() });
const TermsArgs = z.object({ terms: z.array(z.unknown()) });
const GridArgs = z.object({ grid: z.unknown() });
const RelationsArgs = z.object({ relations: z.array(z.unknown()) });
const AccountedArgs =z.object({ items: z.array(z.unknown()) });
const QuestionsArgs = z.object({ questions: z.array(z.unknown()) });

const argIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const withMore = (lines: string[], shown: number) => (lines.length > shown ? [...lines.slice(0, shown), `and ${lines.length - shown} more`] : lines);

function pageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return `${sorted.length === 1 ? "page" : "pages"} ${runs.join(", ")}`;
}

function text(content: string, progress: string, isError = false): ToolOutcome {
  return { content, isError, summary: content.replace(/\s*\n\s*/g, " | ").slice(0, 200), progress };
}

export function createSession(docs: LoadedDoc[], maxFinishes: number) {
  let study: Study | null = null;
  const terms = new Map<string, Term>();
  const grids = new Map<string, Grid>();
  const accounted = new Map<string, Accounted>();
  const questions = new Map<string, Question>();
  const relations = new Map<string, Relation>();
  const state: { finishes: number; ending: Ending | null } = { finishes: 0, ending: null };

  const rulebook = (): Rulebook => ({
    study: study ?? NO_STUDY,
    terms: [...terms.values()],
    grids: [...grids.values()],
    accounted: [...accounted.values()],
    questions: [...questions.values()],
    ...(relations.size ? { relations: [...relations.values()] } : {}),
  });

  const findDoc = (name: string) => docs.find((d) => d.name === name);
  const unknownDoc = (name: string) => `There is no document called "${name}". The documents are: ${docs.map((d) => d.name).join(", ")}.`;
  const rejected = (tool: string, issues: string[]) => text(`Not saved. ${withMore(issues, MAX_SHOWN).join("\n")}`, `Correcting a mistake in ${tool}: ${issues[0]}`, true);

  function storeAll<T>(items: unknown[], normalize: (raw: unknown) => Parsed<T>, store: (value: T) => void, label: string): string[] {
    const failures: string[] = [];
    items.forEach((raw, i) => {
      const result = normalize(raw);
      if (result.ok) return store(result.value);
      const id = typeof raw === "object" && raw !== null && "id" in raw ? String(raw.id) : `#${i + 1}`;
      failures.push(`${label} ${id}: ${result.issues.slice(0, 3).join("; ")}`);
    });
    return failures;
  }

  const storedReport = (what: string, count: number, failures: string[], total: number) =>
    text(
      `Saved ${plural(count, what)} (${total} in all).` + (failures.length ? ` NOT saved, fix and send again:\n${withMore(failures, MAX_SHOWN).join("\n")}` : ""),
      failures.length ? `Saved ${plural(count, what)}; ${failures.length} needed fixing` : `Saved ${plural(count, what)}`,
      failures.length > 0,
    );

  const handlers: Record<string, (input: unknown) => Promise<ToolOutcome> | ToolOutcome> = {
    read_pages(input) {
      const args = ReadArgs.safeParse(input);
      if (!args.success) return rejected("read_pages", argIssues(args.error));
      const doc = findDoc(args.data.doc);
      if (!doc) return text(unknownDoc(args.data.doc), `Looking for ${args.data.doc}`, true);
      const wanted = args.data.pages.slice(0, MAX_PAGES_PER_READ);
      const out = wanted.map((n) => {
        const page = doc.pages[n - 1];
        if (!page) return `=== ${doc.name} p${n} ===\n(this document has only ${doc.pages.length} pages)`;
        const body = { text: page.layout, scan: `(${SCAN_NOTE})\n${page.layout}`, image: "(IMAGE page: no text layer, use view_page)" }[page.kind];
        return `=== ${doc.name} p${n} ===\n${body}`;
      });
      if (args.data.pages.length > wanted.length) out.push(`Only the first ${MAX_PAGES_PER_READ} pages were returned; ask for the rest separately.`);
      return text(out.join("\n"), `Reading ${pageList(wanted)} of ${doc.name}`);
    },

    async view_page(input) {
      const args = ViewArgs.safeParse(input);
      if (!args.success) return rejected("view_page", argIssues(args.error));
      const { doc: name, page, region, dpi } = args.data;
      const doc = findDoc(name);
      if (!doc) return text(unknownDoc(name), `Looking for ${name}`, true);
      try {
        const png = await pdfReader.render(doc, page, { region, dpi });
        const image: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
        return { content: [image], isError: false, summary: `image of p${page}${region ? " (region)" : ""}, ${Math.round(png.length / 1024)} KB`, progress: `Looking closely at ${region ? "part of " : ""}page ${page} of ${name}` };
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), `Couldn't render page ${page} of ${name}`, true);
      }
    },

    search(input) {
      const args = SearchArgs.safeParse(input);
      if (!args.success) return rejected("search", argIssues(args.error));
      let pattern: RegExp;
      try {
        pattern = new RegExp(args.data.pattern, "i");
      } catch (err) {
        return text(`Bad regex: ${err instanceof Error ? err.message : String(err)}`, `Fixing a search pattern`, true);
      }
      const hits = docs.flatMap((d) =>
        d.pages.flatMap((p) => p.layout.split("\n").filter((line) => pattern.test(line)).map((line) => `${d.name} p${p.page}: ${line.trim().slice(0, 200)}`)),
      );
      const shown = hits.slice(0, MAX_SEARCH_HITS);
      if (hits.length > shown.length) shown.push(`(showing ${shown.length} of ${hits.length} matches; narrow the pattern)`);
      return text(shown.join("\n") || "No matches.", `Searching every document for "${args.data.pattern}"`);
    },

    put_study(input) {
      const args = StudyArgs.safeParse(input);
      if (!args.success) return rejected("put_study", argIssues(args.error));
      const result = normalizeStudy(args.data.study);
      if (!result.ok) return rejected("put_study", result.issues);
      study = result.value;
      return text("Saved the study details.", "Noting the study details and each document's role");
    },

    put_terms(input) {
      const args = TermsArgs.safeParse(input);
      if (!args.success) return rejected("put_terms", argIssues(args.error));
      let saved = 0;
      const notFound: string[] = [];
      const cited = (raw: unknown): Parsed<Term> => {
        const result = normalizeTerm(raw);
        const why = result.ok ? citeTerm(result.value, docs) : [];
        return why.length ? { ok: false, issues: why } : result;
      };
      const failures = storeAll(
        args.data.terms,
        cited,
        (t) => {
          const problem = checks.checkQuote(t.source, docs);
          const onText = findDoc(t.source.doc)?.pages.find((p) => p.page === t.source.page)?.kind === "text";
          terms.set(t.id, { ...t, evidence: onText && !problem ? "quote" : "none" });
          if (problem) notFound.push(`${t.id}: ${problem}`);
          saved++;
        },
        "Term",
      );
      const outcome = storedReport("term", saved, failures, terms.size);
      if (!saved) return outcome;
      const quotes = notFound.length ? ` Quotes not found: ${notFound.join("; ")}.` : " All quotes found on their pages.";
      return { ...outcome, content: outcome.content + quotes, summary: (outcome.summary + quotes).slice(0, 300), progress: notFound.length ? `${outcome.progress}; ${plural(notFound.length, "quote")} not found on the page` : outcome.progress };
    },

    put_grid(input) {
      const args = GridArgs.safeParse(input);
      if (!args.success) return rejected("put_grid", argIssues(args.error));
      const result = normalizeGrid(args.data.grid);
      if (!result.ok) return rejected("put_grid", result.issues);
      const grid = result.value;
      const uncited = citeGrid(grid, docs);
      if (uncited.length) return rejected("put_grid", uncited);
      grids.set(grid.id, grid);
      const where = `Budget '${grid.name}' on p.${grid.pages[0]}`;
      const { problems, unproven } = checks.checkGrid(grid, docs);
      if (!problems.length && !unproven.length) return text("PROVEN: all printed arithmetic holds and every cell is covered.", `${where}: all printed totals add up`);
      const lines = [
        ...(problems.length ? ["Arithmetic problems:", ...problems.slice(0, 40)] : []),
        ...(unproven.length ? [`${plural(unproven.length, "cell")} not proven: no printed total covers them. Capture the printed row, subtotal or total lines.`] : []),
      ];
      return text(lines.join("\n"), problems.length ? `${where}: ${plural(problems.length, "problem")} with the totals` : `${where}: totals add up, but ${plural(unproven.length, "cell")} have no printed total backing them`);
    },

    put_relations(input) {
      const args = RelationsArgs.safeParse(input);
      if (!args.success) return rejected("put_relations", argIssues(args.error));
      let saved = 0;
      // only a relation that holds is kept: one that fails would prove nothing and could never be fixed after the compile
      const holding = (raw: unknown): Parsed<Relation> => {
        const result = normalizeRelation(raw);
        const why = result.ok ? checkRelation(result.value, rulebook(), docs) : null;
        return why ? { ok: false, issues: [why] } : result;
      };
      const failures = storeAll(args.data.relations, holding, (r) => (relations.set(`${r.doc} ${r.result}`, r), saved++), "Relation");
      return storedReport("relation", saved, failures, relations.size);
    },

    put_accounted(input) {
      const args = AccountedArgs.safeParse(input);
      if (!args.success) return rejected("put_accounted", argIssues(args.error));
      let saved = 0;
      const failures = storeAll(args.data.items, normalizeAccounted, (a) => (accounted.set(JSON.stringify(a), a), saved++), "Item");
      return storedReport("accounted amount", saved, failures, accounted.size);
    },

    put_questions(input) {
      const args = QuestionsArgs.safeParse(input);
      if (!args.success) return rejected("put_questions", argIssues(args.error));
      let saved = 0;
      const failures = storeAll(args.data.questions, normalizeQuestion, (q) => (questions.set(q.id, q), saved++), "Question");
      return storedReport("question", saved, failures, questions.size);
    },

    finish() {
      if (!study) return text("There are no study details yet: call put_study first.", "Waiting for the study details", true);
      state.finishes++;
      // proving amounts on scanned pages is the harness's job after the compile, so it can't be fixed here
      const problems = checks.runChecks(rulebook(), docs).problems.filter((p) => p.message !== SCAN_PAGE_REASON);
      if (!problems.length) {
        state.ending = "done";
        return text("ALL CHECKS PASS. Done.", "Checking the whole rulebook: all checks pass");
      }
      const last = state.finishes >= maxFinishes;
      if (last) state.ending = "finishes_exhausted";
      const lines = problems.map((p) => `${p.check === "unaccounted" ? "UNACCOUNTED" : `${p.check.toUpperCase()} ${p.id}`}: ${p.message}`);
      const head = `Finish ${state.finishes} of ${maxFinishes}: ${plural(problems.length, "thing")} to fix. ` + (last ? "That was the last finish: what remains goes to the accountant." : "Fix these, then call finish again.");
      return text([head, ...withMore(lines, MAX_PROBLEM_LINES)].join("\n"), `Checking the whole rulebook: ${plural(problems.length, "thing")} to fix`);
    },
  };

  async function run(name: string, input: unknown): Promise<ToolOutcome> {
    const handler = handlers[name];
    if (!handler) return text(`There is no tool called "${name}".`, `Skipping an unknown tool (${name})`, true);
    try {
      return await handler(input);
    } catch (err) {
      return text(`The tool failed: ${err instanceof Error ? err.message : String(err)}`, `A tool step failed (${name})`, true);
    }
  }

  return { run, rulebook, state };
}
