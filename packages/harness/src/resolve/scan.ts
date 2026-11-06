import { ADDED_TO_GRID, CORRECTED_BY_SECOND_READ, SET_ASIDE, applyPatches, cellProofPatches, citationPatches, correctedCells, pageOfCell, valueAt, type Grid, type Patch, type Question, type Rulebook, type Source } from "@dct/shared";
import { checks, needsProof } from "../checks";
import { MARKS, checkCitations } from "../checks/cells";
import { onScan, printedAmounts, printsTotals } from "../checks/grid";
import { coverage, secondReadCell } from "../checks/coverage";
import { amountsAt, usd } from "../checks/text";
import { pdfReader } from "../pdf";
import { amountsOf, centsOf } from "../scan/cells";
import { diffReads, printsAmounts, verdictOf } from "../scan/diff";
import { MAX_SCAN_PIXELS, SCAN_DPI, type Transcription } from "../scan/transcribe";
import { SecondReadFailed, quarterTurn, verifyRead, verifyVersion } from "../scan/verify";
import type { CheckReport, Doubt, LoadedDoc, Page } from "../types";
import { asPrinted, cellLabel, personId, proven, raise, termLabel, tryApply, values } from "./read";
import type { Run } from "./run";

const marksText = (doubts: Doubt[]) => doubts.flatMap((d) => MARKS[d] ?? []).join(" and ") || "marked";

const NOT_CITED = "the rulebook does not say which cell of the page it was read from";
const UNALIGNED = "the second read could not be lined up with it";
const MISMATCH = "it does not match the cell it cites, so a second read of that cell can't vouch for it";
const TURNED = "the second read saw the page turned, so the two reads can't be compared";
const UNREAD = "This still needs a second read of the page, and it could not be done in this run. Start the read again to have the page read a second time.";
// a scanned value's answers each set a value, and nothing here takes a typed one
const ELSE = "If the page prints something else, leave this open and tell the team: it can't be approved until the value is put right.";

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
  /** A second read's different figure may stand when the arithmetic then holds, and only where the first read's arithmetic failed: sums that hold for both reads can't tell them apart. */
  checkable: boolean;
  patch(value: number | null): Patch;
}

const place = (s: Spot) => `p.${s.source.page} (${s.source.doc})`;


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
    const onScan = page?.kind === "scan";
    const about = { target: "term" as const, id: t.id };
    if (onScan && t.amountCents !== null && t.evidence !== "person") {
      spots.push({
        about, source: t.source, label: termLabel(t), path: "amountCents", cents: t.amountCents, cell: t.source.cell, checkable: true,
        unproven: needsProof(t, page) && t.id in report.quotes, patch: (v) => ({ target: "term", id: t.id, set: { amountCents: v } }),
      });
    }
    // a term's evidence speaks for its amount, so its cap is read again on every run (from the store after the first);
    // a cap a person changed no longer cites a cell, and a text page's cap is checked only where it cites one
    const cap = t.cap;
    const cell = t.source.capCell;
    if (cap?.kind === "amount" && cap.value !== null && (cell || (onScan && t.evidence !== "person"))) {
      spots.push({
        about, source: { ...t.source, page: cell ? pageOfCell(cell) : t.source.page }, label: `the cap of '${t.name}'`, path: "cap.value", cents: cap.value, cell,
        checkable: false, unproven: true, patch: (v) => ({ target: "term", id: t.id, set: { cap: { ...cap, value: v } } }),
      });
    }
  }

  for (const g of run.rulebook.grids) {
    if (!onScan(run.docs, g.doc, g.pages)) continue;
    const result = report.grids[g.id];
    const failing = (result?.problems.length ?? 0) > 0;
    const unproven = new Set((result?.unproven ?? []).map(({ row, col }) => `rows.${row}.cells.${col}`));
    const settled = new Set(g.cellsReadTwice.map(([row, col]) => `rows.${row}.cells.${col}`));
    const onText = printedAmounts(g, run.docs);
    const scanPage = g.pages.find((n) => pageOf(g.doc, n)?.kind === "scan")!;
    const visit = (j: number) => g.visits[j] ?? `#${j + 1}`;
    // no total covers a unit cost, so nothing but the reads proves it
    const add = (path: string, label: string, cents: unknown, { rowCell, unitCost = false }: { rowCell?: [number, number]; unitCost?: boolean } = {}) => {
      const cell = g.cellIds?.[path];
      if (typeof cents !== "number" || settled.has(path) || cell === null) return;
      if (cell === undefined && onText.has(Math.abs(cents))) return;
      spots.push({
        about: { target: "grid", id: g.id }, source: { doc: g.doc, page: cell ? pageOfCell(cell) : scanPage, quote: "" }, label, path, cents, cell, checkable: !unitCost && failing,
        unproven: unitCost || failing || unproven.has(path), rowCell, patch: (v) => ({ target: "grid", id: g.id, set: { [path]: v } }),
      });
    };
    g.rows.forEach((r, i) => {
      add(`rows.${i}.unitCostCents`, `the unit cost of row '${r.name}'`, r.unitCostCents, { unitCost: true });
      r.cells.forEach((c, j) => add(`rows.${i}.cells.${j}`, cellLabel(g, i, j), c, { rowCell: [i, j] }));
      add(`rows.${i}.printedRowTotalCents`, `the printed total of row '${r.name}'`, r.printedRowTotalCents);
    });
    for (const line of ["subtotal", "overhead", "total"] as const) g[line]?.forEach((c, j) => add(`${line}.${j}`, `the ${line} line at visit '${visit(j)}'`, c));
    g.additions.forEach((a, i) => a.cells.forEach((c, j) => add(`additions.${i}.cells.${j}`, `the '${a.name}' line at visit '${visit(j)}'`, c)));
    add("grandTotalCents", "the grand total", g.grandTotalCents);
  }
  return spots;
}

/**
 * A question a person answered settles a value it set to what the rulebook still has: it isn't asked again, whatever a later
 * read says. The rulebook doesn't keep which option was picked, so an option that set this very value stands for it.
 */
const answered = (run: Run, s: Spot) =>
  run.rulebook.questions.some(
    (q) =>
      q.origin === "check" &&
      q.state === "answered" &&
      q.options.some((o) =>
        o.patches.some(
          (p) => p.target === s.about.target && p.id === s.about.id && Object.entries(p.set).some(([k, v]) => (k === s.path ? v : s.path.startsWith(`${k}.`) ? valueAt(v, s.path.slice(k.length + 1)) : undefined) === s.cents),
        ),
      ),
  );

/** The id to ask under: an answered question keeps its own, so a new one about the same term or grid takes the next free id beside it. */
function freshId(run: Run, id: string) {
  const taken = (x: string) => run.rulebook.questions.some((q) => q.id === x);
  let fresh = id;
  for (let n = 2; taken(fresh); n++) fresh = `${id}:${n}`;
  return fresh;
}

/** The page's second read, from the store when an earlier run made it; null (and a log line) when it can't be made. */
async function secondRead(run: Run, doc: LoadedDoc, page: Page, first: Transcription): Promise<Transcription | null> {
  const version = verifyVersion(run.openai);
  // a read of the page turned another way saw a different picture
  const saved = (await run.scans?.verify?.get(doc.sha256))?.find((p) => p.page === page.page && p.version === version && p.rotation === page.rotation);
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
    id: freshId(run, personId(first.about.id)),
    about: first.about,
    source: first.source,
    question: one ? `What does p.${first.source.page} of ${first.source.doc} print for ${first.label}?` : `What does ${first.source.doc} print for these ${group.length} values?`,
    context: `Check ${one ? "this value" : "these values"} on the page: ${group.map((s) => `${s.label}: ${usd(s.cents)} (${why.get(s)}${pages ? `, p.${s.source.page}` : ""})`).join("; ")}. ${ELSE}`,
    readings: [],
    options: [{ label: one ? `Use ${usd(first.cents)}` : "Use the values as written", patches: group.map((s) => s.patch(s.cents)) }],
  }, false);
  run.log.push(`${place(first)}: ${values(group.length)} marked on the page or not settled by a second read, so a person will be asked`);
}

/** A page whose values all stand on their own but that still needs its second read, to find what the first read missed. */
function unreadPage(run: Run, doc: string, page: number) {
  const context = "Its second read checks that the first read missed no amount, and it could not be done in this run. Start the read again to have the page read a second time.";
  raise(run, { id: `read:${doc}:p${page}:unread`, about: null, source: { doc, page, quote: "" }, question: `Did the first read of p.${page} of ${doc} miss any amount?`, context, readings: [], options: [] });
}

/** Values the two reads disagree on: the second read's figures stand if they make the arithmetic hold; otherwise a person picks. */
function settleDifferences(run: Run, rows: { s: Spot; second: string }[]) {
  const [{ s }] = rows as [{ s: Spot; second: string }];
  // a grid cell the second read sees blank can be blank; anything else it can't read as one amount isn't offered
  const seconds = rows.map((r) => centsOf(r.second) ?? (!r.second.trim() && r.s.about.target === "grid" ? null : undefined));
  const offered = seconds.every((v) => v !== undefined);
  const usable = seconds.every((v) => typeof v === "number");
  const use = rows.map((r, i) => r.s.patch(seconds[i] as number | null));
  // a corrected cell rests on the second read, so a column total that adds up with it is enough
  const covered = (after: CheckReport) =>
    rows.every(({ s: x }) => {
      const at = (u: { row: number; col: number }) => u.row === x.rowCell?.[0] && u.col === x.rowCell[1];
      const grid = after.grids[x.about.id];
      return !x.rowCell || !grid?.unproven.some(at) || !!grid.bySumOnly?.some(at);
    });
  const before = run.rulebook;
  if (usable && rows.every((r) => r.s.checkable) && tryApply(run, use, covered)) {
    // the arithmetic holds with the second read's figures (§5.5), so they are proven, and the cells that print the first
    // read's figures are set aside; a term's own proof stays the checks' to give, as no arithmetic covers a changed term
    const corrected = correctedCells(before, citationPatches(before, use), CORRECTED_BY_SECOND_READ);
    const next = applyPatches(run.rulebook, cellProofPatches(run.rulebook, use));
    run.rulebook = { ...next, accounted: [...next.accounted, ...corrected] };
    run.log.push(`${place(s)}: the second read corrected ${values(rows.length)} and the totals now add up ✓`);
    return;
  }
  const one = rows.length === 1;
  const shown = (r: { second: string }) => r.second || "blank";
  raise(run, {
    id: freshId(run, `read:${s.about.id}`),
    about: s.about,
    source: s.source,
    question: one ? `What does p.${s.source.page} of ${s.source.doc} print for ${s.label}?` : `Two readings of ${s.source.doc} disagree on ${rows.length} values. What does the page print?`,
    context: `The page was read twice, independently, and the readings differ. ${rows.map((r) => `${r.s.label}: first read ${usd(r.s.cents)}, second read ${shown(r)}`).join("; ")}. ${ELSE}`,
    readings: [
      { model: `${run.openai.model} (first read)`, answer: rows.map((r) => `${r.s.label}: ${usd(r.s.cents)}`).join("; ") },
      { model: `${run.openai.model} (second read)`, answer: rows.map((r) => `${r.s.label}: ${shown(r)}`).join("; ") },
    ],
    options: [
      { label: one ? `Use the first reading (${usd(s.cents)})` : "Use the first readings", patches: rows.map((r) => r.s.patch(r.s.cents)) },
      ...(offered ? [{ label: one ? `Use the second reading (${typeof seconds[0] === "number" ? usd(seconds[0]) : "blank"})` : "Use the second readings", patches: use }] : []),
    ],
  }, false);
  run.log.push(`${place(s)}: a second read of the page reads ${values(rows.length)} differently, so a person will be asked`);
}

/** A scanned grid whose figures still don't add up, and that nothing else asks about: only a person can accept the print as it is. */
function askAsPrinted(run: Run, report: CheckReport) {
  const after = checks.runChecks(run.rulebook, run.docs);
  const open = (id: string) => run.rulebook.questions.some((q) => q.state === "open" && (q.id === id || q.id.startsWith(`${id}:`)));
  for (const g of run.rulebook.grids) {
    const problems = after.grids[g.id]?.problems ?? [];
    if (!report.grids[g.id]?.problems.length || !problems.length || !printsTotals(g) || !onScan(run.docs, g.doc, g.pages)) continue;
    if (open(`read:${g.id}`) || checks.checkGrid({ ...g, acceptedAsPrinted: true }, run.docs).problems.length) continue;
    const lead = open(personId(g.id))
      ? "The figures shown are as first read from the image; the ones that are marked, or that a second read could not settle, are asked about in the other question."
      : "A second read of the page sees exactly what the rulebook has, so the contract's own print is inconsistent.";
    raise(run, asPrinted(g, freshId(run, `read:${g.id}`), lead, problems), false);
    run.log.push(`p.${g.pages.join(",")} (${g.doc}): the figures of '${g.name}' don't add up as printed, so a person will be asked`);
  }
}

const words = (line: string) => (line.length >= 120 ? line.slice(0, line.lastIndexOf(" ")) : line).trim();

const TABLE_CELL = /^(p\d+\.t\d+)\.r(\d+)\.c(\d+)$/;
const tableCell = (id: string) => {
  const m = TABLE_CELL.exec(id);
  return m ? { table: m[1]!, row: Number(m[2]), col: Number(m[3]) } : undefined;
};
const unanimous = (xs: number[]) => (xs.length > 0 && xs.every((x) => x === xs[0]) ? xs[0] : undefined);

/**
 * The blank cell of a grid that sits at a printed cell the first read left empty, worked out from where the grid's other
 * cells are printed: its row's cells all in that printed row and its visit's all in that printed column, or the other way
 * round in a table printed sideways. undefined unless exactly one blank cell fits.
 */
function blankSlot(rulebook: Rulebook, doc: string, id: string) {
  const at = tableCell(id);
  if (!at) return undefined;
  const slots: { grid: Grid; row: number; col: number }[] = [];
  for (const grid of rulebook.grids.filter((g) => g.doc === doc)) {
    const printed = (path: RegExp) =>
      Object.entries(grid.cellIds ?? {}).flatMap(([key, cell]) => {
        const found = typeof cell === "string" && path.test(key) ? tableCell(cell) : undefined;
        return found?.table === at.table ? [found] : [];
      });
    grid.rows.forEach((r, row) =>
      r.cells.forEach((cell, col) => {
        if (cell !== null || grid.cellIds?.[`rows.${row}.cells.${col}`]) return;
        const line = printed(new RegExp(`^rows\\.${row}\\.`));
        const visit = printed(new RegExp(`^(rows\\.\\d+\\.cells|subtotal|overhead|total|additions\\.\\d+\\.cells)\\.${col}$`));
        const upright = unanimous(line.map((p) => p.row)) === at.row && unanimous(visit.map((p) => p.col)) === at.col;
        const sideways = unanimous(line.map((p) => p.col)) === at.col && unanimous(visit.map((p) => p.row)) === at.row;
        if (upright || sideways) slots.push({ grid, row, col });
      }),
    );
  }
  return slots.length === 1 ? slots[0] : undefined;
}

const rowOfCell = (cell: string) => cell.replace(/\.c\d+$/, "");
const missedId = (doc: string, page: number, cell: string) => `read:${doc}:p${page}:missed:${rowOfCell(cell).replace(/^p\d+\./, "")}`;

/**
 * One question per printed row of a scanned page about the amounts only its second read found: a fee the first read
 * dropped, or a figure the second read saw twice. A person adds the row as a fee (one term for the row, its one amount or
 * all of them in its formula, so a row and its own total aren't billed twice), or sets it aside. An amount in a cell of a
 * grid that the first read left blank goes into that cell instead. The first row also offers setting aside the whole page.
 */
function askMissed(run: Run) {
  for (const page of coverage(run.rulebook, run.docs).pages) {
    const missed = page.amounts.filter((a) => a.status === "missing" && a.secondRead !== undefined);
    if (!missed.length) continue;
    const { doc, page: n } = page;
    const overhead = run.rulebook.terms.some((t) => t.category === "overhead") || run.rulebook.grids.some((g) => g.overheadPct !== null);
    const taken = new Set(run.rulebook.terms.map((t) => t.id));
    const aside = (amounts: typeof missed) =>
      [...new Set(amounts.map((a) => a.secondRead!))].map((cell): Patch => ({ target: "accounted", id: cell, set: { doc, page: n, cell: secondReadCell(cell), reason: SET_ASIDE } }));
    const rows = grouped(missed, (a) => rowOfCell(a.secondRead!));

    rows.forEach((row, k) => {
      const slots = row.map((a) => ({ a, slot: a.firstReadBlank ? blankSlot(run.rulebook, doc, a.firstReadBlank) : undefined }));
      const fills = slots.flatMap(({ a, slot }) => (slot ? [{ a, ...slot }] : []));
      const rest = slots.flatMap(({ a, slot }) => (slot ? [] : [a]));
      const line = words(row[0]!.line);
      const patches: Patch[] = fills.flatMap(({ a, grid, row: r, col }): Patch[] => [
        { target: "grid", id: grid.id, set: { [`rows.${r}.cells.${col}`]: a.cents } },
        { target: "accounted", id: a.secondRead!, set: { doc, page: n, cell: secondReadCell(a.secondRead!), reason: ADDED_TO_GRID } },
      ]);
      if (rest.length) {
        const amounts = [...new Set(rest.map((a) => a.cents))];
        let id = `p${n}-added`;
        for (let j = 2; taken.has(id); j++) id = `p${n}-added-${j}`;
        taken.add(id);
        const name = amountsAt(line).reduceRight((t, a) => t.slice(0, a.start) + t.slice(a.end), line).replace(/\s+/g, " ").trim().slice(0, 80) || `Amount on p.${n}`;
        patches.push({
          target: "term", id,
          set: {
            category: "site_fee", name, amountCents: amounts.length === 1 ? amounts[0]! : null, unit: null, billing: "unknown", trigger: null, cap: null,
            formula: amounts.length === 1 ? null : `Amounts printed on this row of p.${n}: ${amounts.map(usd).join(", ")}`, conditions: null, holdbackApplies: "unclear", overheadApplies: overhead ? "unclear" : "n/a",
            deadline: null, source: { doc, page: n, quote: line }, evidence: "person", houseRuleIds: [], notes: "Found only by a second reading of the page; added by a person.",
          },
        });
      }
      const one = row.length === 1;
      const listed = row.map((a) => usd(a.cents)).join(", ");
      raise(run, {
        id: freshId(run, missedId(doc, n, row[0]!.secondRead!)),
        kind: "decision",
        about: null,
        missedRow: { doc, page: n, row: rowOfCell(row[0]!.secondRead!) },
        source: { doc, page: n, quote: "" },
        question: `A second reading of p.${n} of ${doc} found ${listed} on the row "${line}" that the first reading missed. ${one ? "Is it a fee?" : "Are they fees?"}`,
        context: `${one ? "It isn't" : "They aren't"} in the rulebook yet. Check the page. ${fills.length ? `Adding ${one ? "it" : "them"} puts ${one ? "it" : "each"} in the budget grid cell the first reading left blank${rest.length ? ", and the rest as a fee" : ""}; ` : `Add ${one ? "it" : "them"} if ${one ? "it is a fee" : "they are fees"} the site can bill; `}set ${one ? "it" : "them"} aside if ${one ? "it is" : "they are"} only an amount already in the rulebook, read twice.`,
        readings: [],
        options: [
          { label: one ? "It's a fee: add it" : "They're fees: add them", patches },
          { label: one ? "It isn't a separate amount: set it aside" : "They aren't separate amounts: set them aside", patches: aside(row) },
          ...(k === 0 && rows.length > 1 ? [{ label: "Set aside every amount on this page", patches: aside(missed) }] : []),
        ],
      }, false);
    });
    run.log.push(`p.${n} (${doc}): a second read found ${values(missed.length)} the first read missed, in ${rows.length} ${rows.length === 1 ? "row" : "rows"}, so a person will be asked`);
  }
}

/** Questions about amounts only a second read found that another answer has since settled, such as setting aside a whole page. */
export function closeSettledMissed(rulebook: Rulebook, docs: LoadedDoc[]): Rulebook {
  const key = (doc: string, page: number, row: string) => JSON.stringify([doc, page, row]);
  const stillMissing = new Set(coverage(rulebook, docs).pages.flatMap((p) => p.amounts.filter((a) => a.status === "missing" && a.secondRead !== undefined).map((a) => key(p.doc, p.page, rowOfCell(a.secondRead!)))));
  const settled = (q: Question) => q.origin === "check" && q.state === "open" && q.missedRow !== undefined && !stillMissing.has(key(q.missedRow.doc, q.missedRow.page, q.missedRow.row));
  return { ...rulebook, questions: rulebook.questions.map((q) => (settled(q) ? { ...q, state: "auto_resolved" as const } : q)) };
}

/**
 * Settles the amounts cited on scanned pages that arithmetic doesn't prove (§5.5). Each page with one gets a single blind
 * second read, compared with the first cell by cell by structure: agreement proves a value (two_reads); a difference stands
 * only if the arithmetic then holds, otherwise a person picks; a mark seen by either read, or a value the reads can't line
 * up, goes to a person. Positions are never used.
 */
export async function settleScans(run: Run, report: CheckReport) {
  const { marked } = checkCitations(run.rulebook, run.docs);
  const cellText = (doc: string, id: string) => run.docs.find((d) => d.name === doc)?.pages.find((p) => p.page === pageOfCell(id))?.cells?.find((c) => c.id === id)?.text ?? "";
  const spots = spotsOf(run, report).filter((s) => !answered(run, s));
  const why = new Map<Spot, string>();
  for (const s of spots) {
    const mark = marked.find((m) => m.target === s.about.target && m.id === s.about.id && m.path === s.path);
    if (mark) why.set(s, `${marksText(mark.doubts)} on the first read`);
    else if (s.unproven && s.cell === undefined) why.set(s, NOT_CITED);
    else if (s.unproven && !amountsOf(cellText(s.source.doc, s.cell!)).includes(s.cents)) why.set(s, MISMATCH);
  }

  const differ: { s: Spot; second: string }[] = [];
  const unread: Spot[] = [];
  const key = (doc: string, page: number) => JSON.stringify([doc, page]);
  const byPage = new Map(grouped(spots.filter((s) => s.cell), (s) => key(s.source.doc, s.source.page)).map((g) => [key(g[0]!.source.doc, g[0]!.source.page), g]));
  // every scanned page with money is read again, even where arithmetic proves every value, so a row the first read
  // dropped is found (coverage lists what only the second read has)
  const noMoney = new Set(run.rulebook.study.documents.filter((d) => !d.hasMoney).map((d) => d.doc));
  const hasMoney = (doc: LoadedDoc, page: Page | undefined) => !noMoney.has(doc.name) && !!page?.transcription && printsAmounts(page.transcription);
  for (const doc of run.docs) for (const page of doc.pages) if (hasMoney(doc, page) && !byPage.has(key(doc.name, page.page))) byPage.set(key(doc.name, page.page), []);

  for (const [at, group] of byPage) {
    const [name, n] = JSON.parse(at) as [string, number];
    const doc = run.docs.find((d) => d.name === name)!;
    const page = doc.pages.find((p) => p.page === n);
    const open = group.filter((s) => s.unproven && !why.has(s));
    if (!open.length && !hasMoney(doc, page)) continue;
    if (!page?.transcription) {
      open.forEach((s) => why.set(s, UNALIGNED));
      continue;
    }
    const second = await secondRead(run, doc, page, page.transcription);
    if (!second) {
      unread.push(...open);
      if (!open.length) unreadPage(run, doc.name, page.page);
      continue;
    }
    if (quarterTurn(second.rotation) !== 0) {
      open.forEach((s) => why.set(s, TURNED));
      run.log.push(`p.${page.page} (${doc.name}): the second read saw the page turned, so its ${values(open.length)} will be asked about`);
      continue;
    }

    // kept on the page itself, so the checks after this run, coverage included, see what only the second read found
    page.second = second;
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
    raise(run, { id: freshId(run, `read:${s.about.id}:unread`), about: s.about, source: s.source, question, context: UNREAD, readings: [], options: [] });
  }
  askAsPrinted(run, report);
  askMissed(run);
}
