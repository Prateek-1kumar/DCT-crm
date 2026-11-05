import { Term, applyPatches, parseCents, parsePercent, type Patch, type Question, type Region, type Rulebook, type Source } from "@dct/shared";
import { checkQuote } from "../checks/quote";
import type { LoadedDoc } from "../types";
import type { Change, Finding, NewTerm } from "./schema";

// What a patch must never set: identity, and the proof only a check or a person earns.
const LOCKED = new Set(["id", "evidence", "cellsReadTwice"]);
const CELL_PATH = /^((rows|additions)\.\d+\.cells|subtotal|overhead|total)\.\d+$/;

function validRegion(r: number[] | null): Region | undefined {
  if (r?.length !== 4 || r.some((n) => !(n >= 0 && n <= 1))) return undefined;
  const [x0, y0, x1, y1] = r as Region;
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : undefined;
}

function converted(c: Change): [string, unknown] {
  if (c.target === "term") return c.field === "amount" ? ["amountCents", parseCents(c.value) ?? c.value] : [c.field, c.value];
  if (c.field === "overheadPct") return [c.field, parsePercent(c.value) ?? c.value];
  return [c.field, CELL_PATH.test(c.field) || c.field.endsWith("Cents") ? (parseCents(c.value) ?? c.value) : c.value];
}

// A change is kept only if the rulebook still validates with it and every change kept before it; a term change can't create a term.
function patchesOf(changes: Change[], rulebook: Rulebook): Patch[] {
  const kept: Patch[] = [];
  for (const c of changes) {
    const [key, value] = converted(c);
    if (LOCKED.has(key) || (c.target === "term" && !rulebook.terms.some((t) => t.id === c.id))) continue;
    const patch: Patch = { target: c.target, id: c.id, set: { [key]: value } };
    try {
      applyPatches(rulebook, [...kept, patch]);
      kept.push(patch);
    } catch {
      continue;
    }
  }
  return kept;
}

function newTerm(n: NewTerm, id: string, source: Source): Term | null {
  const { category, name, unit, billing, trigger, formula, conditions, deadline, notes } = n;
  const parsed = Term.safeParse({
    id, category, name, unit, billing, trigger, formula, conditions, deadline, notes,
    amountCents: n.amount === null ? null : (parseCents(n.amount) ?? n.amount),
    cap: null, holdbackApplies: "n/a", overheadApplies: "n/a", source, evidence: "none", houseRuleIds: [],
  });
  return parsed.success ? parsed.data : null;
}

const exists = (about: Finding["about"], rulebook: Rulebook) =>
  about.id !== null &&
  (about.target === "term"
    ? rulebook.terms.some((t) => t.id === about.id)
    : about.target === "grid"
      ? rulebook.grids.some((g) => g.id === about.id)
      : about.target === "study" && rulebook.study.documents.some((d) => d.doc === about.id));

// option is the suggestion's index among the options that survived, -1 when it points at one that didn't.
function choices(f: Finding, n: number, source: Source, rulebook: Rulebook): { options: Question["options"]; option: number } {
  const created = f.type === "missed_rule" && f.newTerm ? newTerm(f.newTerm, `rv_${n}`, source) : null;
  if (created) {
    return {
      options: [
        { label: "Add it to the rulebook", patches: [{ target: "term", id: created.id, set: created }] },
        { label: "No, leave the rulebook as it is", patches: [] },
      ],
      option: f.suggestion?.option ?? -1,
    };
  }
  const kept: number[] = [];
  const options = f.options.flatMap((o, i) => {
    const patches = patchesOf(o.changes, rulebook);
    if (o.changes.length && !patches.length) return [];
    kept.push(i);
    return [{ label: o.label, patches }];
  });
  return { options, option: kept.indexOf(f.suggestion?.option ?? -1) };
}

export function toQuestions(findings: Finding[], rulebook: Rulebook, docs: LoadedDoc[]): Question[] {
  return findings.flatMap((f, n): Question[] => {
    if (!docs.find((d) => d.name === f.doc)?.pages.some((p) => p.page === f.page)) return [];
    const region = validRegion(f.region);
    const source: Source = { doc: f.doc, page: f.page, quote: f.quote, ...(region && { region }) };
    if (checkQuote(source, docs)) source.quote = "";
    const { options, option } = choices(f, n, source, rulebook);
    return [
      {
        id: `review:${n}`,
        kind: f.kind,
        origin: "reviewer",
        about: exists(f.about, rulebook) ? { target: f.about.target as "term" | "grid" | "study", id: f.about.id! } : null,
        question: f.question,
        context: f.context,
        source,
        options,
        suggestion: f.suggestion && options[option] ? { option, reason: f.suggestion.reason } : null,
        state: "open",
        readings: [],
        resolution: null,
      },
    ];
  });
}
