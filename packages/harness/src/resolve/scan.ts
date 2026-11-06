import { applyPatches, parseCents, type Patch, type Source } from "@dct/shared";
import { checks, needsProof } from "../checks";
import { checkCitations } from "../checks/cells";
import { printedAmounts } from "../checks/grid";
import { amountsIn, usd } from "../checks/text";
import { pdfReader } from "../pdf";
import { diffReads, verdictOf } from "../scan/diff";
import { MAX_SCAN_PIXELS, SCAN_DPI, type Transcription } from "../scan/transcribe";
import { SecondReadFailed, verifyRead, verifyVersion } from "../scan/verify";
import type { CheckReport, Doubt, LoadedDoc, Page } from "../types";
import { asPrinted, cellLabel, onScan, personId, proven, raise, termLabel, tryApply, values } from "./read";
import type { Run } from "./run";

const MARKS: Partial<Record<Doubt, string>> = { handwritten: "handwritten", struck_out: "struck out", initialed: "initialed" };
const marksText = (doubts: Doubt[]) => doubts.flatMap((d) => MARKS[d] ?? []).join(" and ") || "marked";

const NOT_CITED = "the rulebook does not say which cell of the page it was read from";
const UNALIGNED = "the second read could not be lined up with it";
const TURNED = "the second read saw the page turned, so the two reads can't be compared";
const UNREAD = "This still needs a second read of the page, and it could not be done in this run. Start the read again to have the page read a second time.";

/** One amount the compile agent cited on a scanned page. */
interface Spot {
  about: { target: "term" | "grid"; id: string };
  source: Source;
  label: string;
  path: string;
  cents: number;
  /** The cell or line it cites; undefined when it cites none. */
  cell: string | undefined;
  /** Nothing proves it yet, so it needs the second read. A proven value is still asked about when either read sees it marked. */
  unproven: boolean;
  /** Set on a grid's row cell, so the totals check can tell whether a corrected one is covered. */
  rowCell?: [number, number];
  patch(value: number): Patch;
}

const pageOfCell = (id: string) => Number(/^p(\d+)\./.exec(id)?.[1]);
const place = (s: Spot) => `p.${s.source.page} (${s.source.doc})`;
const quarterTurn = (degrees: number) => (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;

/** A printed amount as one number: a cell with words beside its one amount ("$260.00 per visit") counts; null otherwise. */
const centsOf = (text: string) => {
  const found = amountsIn(text);
  return found.length === 1 ? found[0]! : parseCents(text);
};

const grouped = <T>(items: T[], key: (t: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
};

/**
 * Every amount on a scanned page that a person hasn't settled. A changed amount whose citation was dropped (null) rests on
 * whoever changed it, so it is left alone, as is a grid amount printed on one of the grid's text pages.
 */
function spotsOf(run: Run, report: CheckReport): Spot[] {
  const pageOf = (doc: string, n: number) => run.docs.find((d) => d.name === doc)?.pages.find((p) => p.page === n);
  const spots: Spot[] = [];
  for (const t of run.rulebook.terms) {
    const page = pageOf(t.source.doc, t.source.page);
    if (page?.kind !== "scan" || t.amountCents === null || t.evidence === "person" || t.source.cell === null) continue;
    spots.push({
      about: { target: "term", id: t.id }, source: t.source, label: termLabel(t), path: "amountCents", cents: t.amountCents, cell: t.source.cell,
      unproven: needsProof(t, page) && t.id in report.quotes, patch: (v) => ({ target: "term", id: t.id, set: { amountCents: v } }),
    });
  }

  for (const g of run.rulebook.grids) {
    if (!onScan(run, g.doc, g.pages)) continue;
    const result = report.grids[g.id];
    const failing = (result?.problems.length ?? 0) > 0;
    const unproven = new Set((result?.unproven ?? []).map(({ row, col }) => `rows.${row}.cells.${col}`));
    const settled = new Set(g.cellsReadTwice.map(([row, col]) => `rows.${row}.cells.${col}`));
    const onText = printedAmounts(g, run.docs);
    const scanPage = g.pages.find((n) => pageOf(g.doc, n)?.kind === "scan")!;
    const visit = (j: number) => g.visits[j] ?? `#${j + 1}`;
    const add = (path: string, label: string, cents: unknown, rowCell?: [number, number]) => {
      const cell = g.cellIds?.[path];
      if (typeof cents !== "number" || settled.has(path) || cell === null) return;
      // a printed line needs proof only while the totals fail, and then only through the cell it cites
      if (cell === undefined && (!rowCell || onText.has(Math.abs(cents)))) return;
      spots.push({
        about: { target: "grid", id: g.id }, source: { doc: g.doc, page: cell ? pageOfCell(cell) : scanPage, quote: "" }, label, path, cents, cell,
        unproven: failing || unproven.has(path), rowCell, patch: (v) => ({ target: "grid", id: g.id, set: { [path]: v } }),
      });
    };
    g.rows.forEach((r, i) => {
      r.cells.forEach((c, j) => add(`rows.${i}.cells.${j}`, cellLabel(g, i, j), c, [i, j]));
      add(`rows.${i}.printedRowTotalCents`, `the printed total of row '${r.name}'`, r.printedRowTotalCents);
    });
    for (const line of ["subtotal", "overhead", "total"] as const) g[line]?.forEach((c, j) => add(`${line}.${j}`, `the ${line} line at visit '${visit(j)}'`, c));
    g.additions.forEach((a, i) => a.cells.forEach((c, j) => add(`additions.${i}.cells.${j}`, `the '${a.name}' line at visit '${visit(j)}'`, c)));
    add("grandTotalCents", "the grand total", g.grandTotalCents);
  }
  return spots;
}

/** The page's second read, from the store when an earlier run made it; null (and a log line) when it can't be made. */
async function secondRead(run: Run, doc: LoadedDoc, page: Page, first: Transcription): Promise<Transcription | null> {
  const version = verifyVersion(run.openai);
  const saved = (await run.scans?.verify?.get(doc.sha256))?.find((p) => p.page === page.page && p.version === version);
  if (saved) return saved.transcription;
  const spent = run.budget.spent;
  let read: Transcription;
  try {
    const png = await pdfReader.render(doc, page.page, { dpi: SCAN_DPI, maxPixels: MAX_SCAN_PIXELS });
    read = await verifyRead(run.openai, png, first.tables.map((t, i) => ({ ordinal: i + 1, title: t.title })), run.budget);
  } catch (err) {
    run.log.push(`p.${page.page} (${doc.name}): left for a person (${err instanceof SecondReadFailed ? err.message : "the page could not be read a second time"})`);
    return null;
  } finally {
    run.usd += run.budget.spent - spent;
  }
  await run.scans?.verify?.put(doc.sha256, { page: page.page, version, rotation: page.rotation, transcription: read }).catch(() => {
    run.log.push(`p.${page.page} (${doc.name}): the second read couldn't be kept, so a later run will pay for it again`);
  });
  return read;
}

function askPerson(run: Run, group: Spot[], why: Map<Spot, string>) {
  const [first] = group as [Spot];
  const one = group.length === 1;
  const pages = new Set(group.map((s) => s.source.page)).size > 1;
  raise(run, {
    id: personId(first.about.id),
    about: first.about,
    source: first.source,
    question: one ? `What does p.${first.source.page} of ${first.source.doc} print for ${first.label}?` : `What does ${first.source.doc} print for these ${group.length} values?`,
    context: `Check ${one ? "this value" : "these values"} on the page: ${group.map((s) => `${s.label}: ${usd(s.cents)} (${why.get(s)}${pages ? `, p.${s.source.page}` : ""})`).join("; ")}.`,
    readings: [],
    options: [{ label: one ? `Use ${usd(first.cents)}` : "Use the values as written", patches: group.map((s) => s.patch(s.cents)) }],
  });
  run.log.push(`${place(first)}: ${values(group.length)} marked on the page or not settled by a second read, so a person will be asked`);
}

/** Values the two reads disagree on: the second read's figures stand if they make the arithmetic hold; otherwise a person picks. */
function settleDifferences(run: Run, rows: { s: Spot; second: string }[]) {
  const [{ s }] = rows as [{ s: Spot; second: string }];
  const seconds = rows.map((r) => centsOf(r.second));
  const usable = seconds.every((v) => v !== null);
  const use = rows.map((r, i) => r.s.patch(seconds[i]!));
  const covered = (after: CheckReport) => rows.every(({ s: x }) => !x.rowCell || !after.grids[x.about.id]?.unproven.some((u) => u.row === x.rowCell![0] && u.col === x.rowCell![1]));
  if (usable && tryApply(run, use, covered)) {
    run.log.push(`${place(s)}: the second read corrected ${values(rows.length)} and the totals now add up ✓`);
    return;
  }
  const one = rows.length === 1;
  const shown = (r: { second: string }) => r.second || "blank";
  raise(run, {
    id: `read:${s.about.id}`,
    about: s.about,
    source: s.source,
    question: one ? `What does p.${s.source.page} of ${s.source.doc} print for ${s.label}?` : `Two readings of ${s.source.doc} disagree on ${rows.length} values. What does the page print?`,
    context: `The page was read twice, independently, and the readings differ. ${rows.map((r) => `${r.s.label}: first read ${usd(r.s.cents)}, second read ${shown(r)}`).join("; ")}.`,
    readings: [
      { model: `${run.openai.model} (first read)`, answer: rows.map((r) => `${r.s.label}: ${usd(r.s.cents)}`).join("; ") },
      { model: `${run.openai.model} (second read)`, answer: rows.map((r) => `${r.s.label}: ${shown(r)}`).join("; ") },
    ],
    options: [
      { label: one ? `Use the first reading (${usd(s.cents)})` : "Use the first readings", patches: rows.map((r) => r.s.patch(r.s.cents)) },
      ...(usable ? [{ label: one ? `Use the second reading (${usd(seconds[0]!)})` : "Use the second readings", patches: use }] : []),
    ],
  });
  run.log.push(`${place(s)}: a second read of the page reads ${values(rows.length)} differently, so a person will be asked`);
}

/** A scanned grid whose figures still don't add up, and that nothing else asks about: only a person can accept the print as it is. */
function askAsPrinted(run: Run, report: CheckReport) {
  const after = checks.runChecks(run.rulebook, run.docs);
  const open = (id: string) => run.rulebook.questions.some((q) => q.id === id && q.state === "open");
  for (const g of run.rulebook.grids) {
    const problems = after.grids[g.id]?.problems ?? [];
    if (!report.grids[g.id]?.problems.length || !problems.length || !onScan(run, g.doc, g.pages)) continue;
    if (open(`read:${g.id}`) || open(`read:${g.id}:unread`) || checks.checkGrid({ ...g, acceptedAsPrinted: true }, run.docs).problems.length) continue;
    const lead = open(personId(g.id))
      ? "The figures shown are as first read from the image; the ones that are marked, or that a second read could not settle, are asked about in the other question."
      : "A second read of the page sees exactly what the rulebook has, so the contract's own print is inconsistent.";
    raise(run, asPrinted(g, `read:${g.id}`, lead, problems));
    run.log.push(`p.${g.pages.join(",")} (${g.doc}): the figures of '${g.name}' don't add up as printed, so a person will be asked`);
  }
}

/**
 * Settles the amounts cited on scanned pages that arithmetic doesn't prove (§5.5). Each page with one gets a single blind
 * second read, compared with the first cell by cell by structure: agreement proves a value (two_reads); a difference stands
 * only if the arithmetic then holds, otherwise a person picks; a mark seen by either read, or a value the reads can't line
 * up, goes to a person. Positions are never used.
 */
export async function settleScans(run: Run, report: CheckReport) {
  const { marked } = checkCitations(run.rulebook, run.docs);
  const spots = spotsOf(run, report);
  const why = new Map<Spot, string>();
  for (const s of spots) {
    const mark = marked.find((m) => m.target === s.about.target && m.id === s.about.id && m.path === s.path);
    if (mark) why.set(s, `${marksText(mark.doubts)} on the first read`);
    else if (s.unproven && s.cell === undefined) why.set(s, NOT_CITED);
  }

  const differ: { s: Spot; second: string }[] = [];
  const unread: Spot[] = [];
  for (const group of grouped(spots.filter((s) => s.cell), (s) => JSON.stringify([s.source.doc, s.source.page]))) {
    const open = group.filter((s) => s.unproven && !why.has(s));
    if (!open.length) continue;
    const doc = run.docs.find((d) => d.name === group[0]!.source.doc)!;
    const page = doc.pages.find((p) => p.page === group[0]!.source.page);
    if (!page?.transcription) {
      open.forEach((s) => why.set(s, UNALIGNED));
      continue;
    }
    const second = await secondRead(run, doc, page, page.transcription);
    if (!second) {
      unread.push(...open);
      continue;
    }
    if (quarterTurn(second.rotation) !== 0) {
      open.forEach((s) => why.set(s, TURNED));
      run.log.push(`p.${page.page} (${doc.name}): the second read saw the page turned, so its ${values(open.length)} will be asked about`);
      continue;
    }

    const diff = diffReads(page.page, page.transcription, second);
    const agreed: Spot[] = [];
    for (const s of group.filter((x) => !why.has(x))) {
      const verdict = verdictOf(diff, s.cell!, s.cents);
      if (verdict.outcome === "marked") why.set(s, `${marksText(verdict.marks ?? [])} on the second read`);
      else if (!s.unproven) continue;
      else if (verdict.outcome === "agree") agreed.push(s);
      else if (verdict.outcome === "differ") differ.push({ s, second: verdict.second ?? "" });
      else why.set(s, UNALIGNED);
    }
    if (agreed.length) {
      run.rulebook = applyPatches(run.rulebook, proven(run.rulebook, agreed.map((s) => s.patch(s.cents))));
      run.log.push(`${place(agreed[0]!)}: a second read of the page agrees on ${values(agreed.length)} ✓`);
    }
  }

  for (const group of grouped([...why.keys()], (s) => s.about.id)) askPerson(run, group, why);
  for (const rows of grouped(differ, (d) => d.s.about.id)) settleDifferences(run, rows);
  for (const group of grouped(unread, (s) => s.about.id)) {
    const [s] = group as [Spot];
    const question = group.length === 1 ? `What does p.${s.source.page} of ${s.source.doc} print for ${s.label}?` : `What does ${s.source.doc} print for these ${group.length} values?`;
    raise(run, { id: `read:${s.about.id}:unread`, about: s.about, source: s.source, question, context: UNREAD, readings: [], options: [] });
  }
  askAsPrinted(run, report);
}
