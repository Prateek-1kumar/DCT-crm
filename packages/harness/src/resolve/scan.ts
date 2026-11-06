import { applyPatches, type Patch, type Question, type Region, type Source } from "@dct/shared";
import { needsProof } from "../checks";
import { findQuote } from "../checks/coverage";
import { usd } from "../checks/text";
import type { CheckReport, Doubt, Page, Word } from "../types";
import { askPages, cellLabel, onScan, personId, printQuestion, proven, raise, raiseUnread, raiseZoomed, readCell, same, shown, termLabel, tryAsk, values } from "./read";
import type { Run } from "./run";

const PAD = 0.015;

const MARKS: Partial<Record<Doubt, string>> = { handwritten: "handwritten", struck_out: "struck out", initialed: "initialed" };

interface Spot {
  source: Source;
  about: Question["about"];
  label: string;
  /** The id of the question raised when reads disagree, shared by the cells of one grid. */
  questionId: string;
  /** The id of the one question raised for the term, or for all the cells of the grid, that go straight to a person. */
  personId: string;
  current: number;
  /** What was transcribed at this spot: the quote's lines, or none when the quote can't be found. */
  words: Word[];
  /** Where to look closer; undefined when the spot can't be found, so the whole page is shown. */
  crop?: Region;
  /** A cell of a grid whose arithmetic fails, which rereadScanGrids reads with the whole grid. A marked cell, or one whose row can't be found, is still asked about here. */
  failing: boolean;
  patch(value: number): Patch;
}

const lineBand = (words: Word[], text: string): [number, number] | null => {
  const boxes = findQuote(words, text);
  return boxes.length ? [Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[3]))] : null;
};

const wordsIn = (page: Page, band: [number, number] | null) => (band ? page.words.filter((w) => (w.y0 + w.y1) / 2 >= band[0] && (w.y0 + w.y1) / 2 <= band[1]) : []);

function spotsOf(run: Run, report: CheckReport): Spot[] {
  const pageOf = (doc: string, n: number) => run.docs.find((d) => d.name === doc)?.pages.find((p) => p.page === n);
  const spots: Spot[] = [];

  for (const t of run.rulebook.terms) {
    const page = pageOf(t.source.doc, t.source.page);
    if (page?.kind !== "scan" || !needsProof(t, page)) continue;
    const band = lineBand(page.words, t.source.quote);
    spots.push({
      source: t.source, about: { target: "term", id: t.id }, label: termLabel(t), questionId: `read:${t.id}`, personId: personId(t.id), current: t.amountCents!, words: wordsIn(page, band),
      crop: band ? [0, Math.max(0, band[0] - PAD), 1, Math.min(1, band[1] + PAD)] : undefined, failing: false,
      patch: (v) => ({ target: "term", id: t.id, set: { amountCents: v } }),
    });
  }

  for (const g of run.rulebook.grids) {
    if (!onScan(run, g.doc, g.pages)) continue;
    const pages = g.pages.flatMap((n) => pageOf(g.doc, n) ?? []);
    const failing = (report.grids[g.id]?.problems.length ?? 0) > 0;
    // a failing grid's marked cells must reach a person whatever the arithmetic says, so every number in it is looked at
    const cells = failing ? g.rows.flatMap((r, row) => r.cells.flatMap((_, col) => ({ row, col }))) : (report.grids[g.id]?.unproven ?? []);
    for (const { row, col } of cells) {
      const current = g.rows[row]!.cells[col];
      if (typeof current !== "number") continue;
      const name = g.rows[row]!.name;
      const page = pages.find((p) => findQuote(p.words, name).length) ?? pages[0]!;
      const band = lineBand(page.words, name);
      spots.push({
        source: { doc: g.doc, page: page.page, quote: "" }, about: { target: "grid", id: g.id }, label: cellLabel(g, row, col), questionId: `read:${g.id}`, personId: personId(g.id),
        current, words: wordsIn(page, band), failing,
        // from the top of the page, so the visit headings above the row are in the picture
        crop: band ? [0, 0, 1, Math.min(1, band[1] + PAD)] : undefined,
        patch: (v) => ({ target: "grid", id: g.id, set: { [`rows.${row}.cells.${col}`]: v } }),
      });
    }
  }
  return spots;
}

const grouped = <T>(items: T[], key: (t: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
};

const markOf = (s: Spot) => s.words.flatMap((w) => (w.doubt && MARKS[w.doubt]) || [])[0];

const NOT_FOUND = "could not be found on the page";

/** A marked value, or one whose spot can't be found to check for marks, is never settled by a reading: a person is asked. */
const whyPerson = (s: Spot) => markOf(s) ?? (s.crop ? undefined : NOT_FOUND);

/** Grid cells in one question are shown from the top of the page to the lowest of them on the first one's page, so all are in the picture. */
function remember(run: Run, id: string, spots: Spot[]) {
  const crop = spots.filter((s) => s.source.page === spots[0]!.source.page).map((s) => s.crop).filter((c): c is Region => c !== undefined).sort((a, b) => b[3] - a[3])[0];
  if (crop) run.crops.set(id, crop);
}

function personContext(group: Spot[]) {
  const [s] = group;
  if (s!.about?.target === "term") return markOf(s!) ? `p.${s!.source.page} shows this value ${markOf(s!)}` : "The spot for this amount could not be found on the page, so it could not be looked at closely.";
  const pages = new Set(group.map((x) => x.source.page)).size > 1;
  const list = group.map((x) => `${x.label}: ${usd(x.current)} (${whyPerson(x)}${pages ? `, p.${x.source.page}` : ""})`).join("; ");
  const one = group.length === 1;
  return `Check ${one ? "this value" : "these values"} on the page: ${one ? "it is" : "they are"} marked or couldn't be found to read closely. ${list}.`;
}

const about = (id: string, spots: Spot[]) => ({ id, about: spots[0]!.about, source: spots[0]!.source, question: printQuestion(spots[0]!.source, spots.map((s) => s.label)) });
const place = (s: Spot) => `p.${s.source.page} (${s.source.doc})`;

/**
 * For each amount the model wrote on a scanned page that arithmetic doesn't prove: a value marked handwritten, struck out or
 * initialed, or one whose spot can't be found, goes straight to a person; any other gets a zoomed second look at its spot by
 * the vision reader, who isn't shown the value. The same reading proves it (two_reads); a different one is asked.
 */
export async function relook(run: Run, report: CheckReport) {
  const spots = spotsOf(run, report);

  for (const group of grouped(spots.filter(whyPerson), (s) => s.personId)) {
    const [first] = group;
    const one = group.length === 1;
    remember(run, first!.personId, group);
    raise(run, {
      id: first!.personId,
      about: first!.about,
      source: first!.source,
      question: one ? printQuestion(first!.source, [first!.label]) : `What does p.${first!.source.page} of ${first!.source.doc} print for these ${group.length} values?`,
      context: personContext(group),
      readings: [],
      options: [{ label: one ? `Use ${usd(first!.current)}` : "Use the values as written", patches: group.map((s) => s.patch(s.current)) }],
    });
    run.log.push(`${place(first!)}: ${values(group.length)} marked on the page or not found there, so a person will be asked`);
  }

  const differ: { s: Spot; said: string | null }[] = [];
  const unread: Spot[] = [];
  for (const group of grouped(spots.filter((s) => !whyPerson(s) && !s.failing), (s) => JSON.stringify([s.source.doc, s.source.page, s.crop]))) {
    const { doc, page } = group[0]!.source;
    const answers = (await tryAsk(run, [run.openai], { doc, pages: [page], region: group[0]!.crop }, group))?.[0];
    if (!answers) {
      unread.push(...group);
      continue;
    }
    const confirmed = group.filter((s, i) => same(readCell(answers[i]!), s.current));
    if (confirmed.length) {
      run.rulebook = applyPatches(run.rulebook, proven(run.rulebook, confirmed.map((s) => s.patch(s.current))));
      run.log.push(`p.${page} (${doc}): a closer look confirms ${values(confirmed.length)} ✓`);
    }
    differ.push(...group.flatMap((s, i) => (confirmed.includes(s) ? [] : [{ s, said: answers[i]! }])));
  }

  // asked once per question id, after every look, so a later question never replaces an earlier one about the same grid
  for (const rows of grouped(differ, ({ s }) => s.questionId)) {
    const here = rows.map(({ s }) => s);
    remember(run, here[0]!.questionId, here);
    raiseZoomed(run, about(here[0]!.questionId, here), rows.map(({ s, said }) => {
      const read = readCell(said);
      return { label: s.label, whole: shown(s.current), read: said, keep: s.patch(s.current), use: typeof read === "number" ? s.patch(read) : null };
    }));
    run.log.push(`${place(here[0]!)}: a closer look read ${values(rows.length)} differently, so a person will be asked`);
  }
  for (const here of grouped(unread, (s) => s.questionId)) {
    const id = `${here[0]!.questionId}:unread`;
    remember(run, id, here);
    raiseUnread(run, about(id, here));
  }
}
