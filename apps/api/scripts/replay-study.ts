/**
 * pnpm --filter @dct/api replay <studyId> [version] [--json <path>]    no AI, reads the dev database only
 *
 * Replays a saved read: takes the version's stored rulebook, reads its documents' text with our own OCR (cached beside each
 * PDF; a missing cache runs the local OCR, which costs nothing), and recomputes the evidence and the review list with the
 * code a read runs (reviewDraft, as in jobs.ts). Prints the counts, then the counts stored on that version, and says whether
 * they are the same. Every later change to the binder or the questions can report before/after on a real contract.
 *
 * Counts only: never contract text, quotes, amounts, file names or upload paths. The database is opened read-only (the
 * session refuses any write), and nothing here starts the server or the workers.
 *
 * Not replayed: the corrections an amendment carries forward from the live version (they need the live version's answers), and
 * what the model's read returned beside the rulebook but no version stores (the grid read's printed row totals and quantities,
 * `printedRows`; the token map's `anchors` and `nonFee`, off by default). The stored rulebook is what the people answering
 * left it as, so a version that has answers can differ from what was read. A table check draws its two columns at random,
 * so which columns its questions point at can differ; the counts don't.
 */
import { writeFileSync } from "node:fs";
import { and, desc, eq, lt } from "drizzle-orm";
import { besideOnLine, bindEvidence, gateSweep, lastSigned, readTextLayer, reviewFromEvidence, runContractChecks, solveGrids, type TextPage } from "@dct/extraction";
import { isExcludedPage, type ReviewItem, upgradeRulebook, type ValueEvidence } from "@dct/shared";
import { createDb } from "../src/db/index.js";
import { config } from "../src/config.js";
import { documents, rulebookVersions, studyDocuments } from "../src/db/schema.js";
import { reviewDraft } from "../src/review.js";

const tally = (xs: string[]) => Object.fromEntries(Object.entries(xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).sort(([a], [b]) => a.localeCompare(b)));

/** Counts of one review list and evidence ledger. `docs`: document ids in order, so a page is "doc 1 p3" and no id is printed. */
export function counts(review: ReviewItem[], evidence: ValueEvidence[], docs: string[]) {
  const page = (i: ReviewItem) => {
    const w = i.where[0];
    return w ? `doc ${docs.indexOf(w.documentId) + 1} p${w.page}` : "no page";
  };
  return {
    review: {
      total: review.length,
      byKindReasonBlocking: tally(review.map((i) => `${i.kind} / ${i.reason} / ${i.blocking ? "blocking" : "not blocking"}`)),
      byReason: tally(review.map((i) => i.reason)),
    },
    evidence: {
      total: evidence.length,
      byStatus: tally(evidence.map((e) => e.status)),
      held: evidence.filter((e) => e.held).length,
      blank: evidence.filter((e) => e.blank).length,
    },
    unaccountedByPage: tally(review.filter((i) => i.reason === "UNACCOUNTED_TERM").map(page)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonAt = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const [studyId, versionArg] = args.filter((a, i) => a !== "--json" && args[i - 1] !== "--json");
  if (!studyId || (args.includes("--json") && !jsonAt)) throw new Error("Usage: pnpm --filter @dct/api replay <studyId> [version] [--json <path>]");
  // ponytail: read-only is the session's own refusal of writes, not trust in this file; no pool of workers, one connection
  const { db, pool } = createDb(config.databaseUrl, { max: 1, options: "-c default_transaction_read_only=on" });
  try {
    const rows = await db
      .select()
      .from(rulebookVersions)
      .where(versionArg ? and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.version, Number(versionArg))) : eq(rulebookVersions.studyId, studyId))
      .orderBy(desc(rulebookVersions.version));
    const v = rows.find((r) => r.rulebook);
    if (!v?.rulebook) throw new Error("No version with a read was found for that study.");
    const docs = await db
      .select({ id: documents.id, filename: documents.filename, path: documents.storagePath, kind: documents.kind })
      .from(studyDocuments)
      .innerJoin(documents, eq(documents.id, studyDocuments.documentId))
      .where(eq(studyDocuments.studyId, studyId))
      .orderBy(studyDocuments.addedAt, documents.filename);
    // as the read had it: an earlier signed version makes this an amendment (its carried corrections are not replayed)
    const [earlier] = await db.select({ id: rulebookVersions.id }).from(rulebookVersions).where(and(eq(rulebookVersions.studyId, studyId), eq(rulebookVersions.status, "signed"), lt(rulebookVersions.version, v.version)));

    const rb = upgradeRulebook(v.rulebook);
    const anomalies = runContractChecks(rb, { crossRead: v.crossRead ? upgradeRulebook(v.crossRead) : null, pages: v.pages, notes: v.notes });
    const textByDoc = await Promise.all(docs.map((d) => readTextLayer(d.path, d.id, { ocr: true })));
    const pages: TextPage[] = textByDoc.flat();
    // as jobs.ts wires it, less what no version stores (above)
    const replayed = reviewDraft({ bindEvidence, reviewFromEvidence, solveGrids, gateSweep, besideOnLine, lastSigned }, rb, anomalies, pages, docs, {
      amendment: !!earlier || docs.some((d) => d.kind === "amendment"),
      excluded: v.pages.filter(isExcludedPage),
      solver: config.extractionSolver,
    });
    const ids = docs.map((d) => d.id);
    const now = counts(replayed.review, replayed.evidence, ids);
    const stored = counts(v.review, v.evidence, ids);
    const same = JSON.stringify(now) === JSON.stringify(stored);
    const report = {
      version: { number: v.version, status: v.status },
      documents: docs.length,
      pagesBySource: tally(pages.map((p) => p.source)),
      // ADR-002 PR 2: the solver (mode = EXTRACTION_SOLVER) and the sweep gate, counts and pointers only
      solver: replayed.solver ? { ...replayed.solver, failures: replayed.solver.failures.map((f) => ({ identity: f.identity, values: f.paths.length })) } : null,
      sweep: replayed.sweep ?? null,
      replay: now,
      stored,
      replayEqualsStored: same,
    };
    console.log(`Version ${v.version} (${v.status}), ${docs.length} document(s); pages by text source: ${JSON.stringify(report.pagesBySource)}`);
    for (const [name, c] of [["REPLAY (code as it is now)", now], ["STORED (on the version)", stored]] as const) {
      console.log(`\n== ${name}`);
      console.log(`review questions: ${c.review.total}`);
      for (const [k, n] of Object.entries(c.review.byKindReasonBlocking)) console.log(`  ${String(n).padStart(4)}  ${k}`);
      console.log(`evidence: ${c.evidence.total} values ${JSON.stringify(c.evidence.byStatus)}, held ${c.evidence.held}, blank ${c.evidence.blank}`);
      console.log(`unaccounted terms by page: ${JSON.stringify(c.unaccountedByPage)}`);
    }
    if (replayed.solver) console.log(`\nsolver (${replayed.solver.mode}): upgraded ${JSON.stringify(replayed.solver.upgraded)}, no page ${replayed.solver.noPage}, held would pass ${replayed.solver.heldWouldPass}, identities ${JSON.stringify(replayed.solver.identities)}`);
    if (replayed.sweep) console.log(`sweep gate: ${JSON.stringify(replayed.sweep)}`);
    console.log(`\nReplay equals stored: ${same ? "YES" : "NO (the code changed since the read, answers changed the stored rulebook, or the read's unstored printed row totals mattered)"}`);
    if (jsonAt) writeFileSync(jsonAt, `${JSON.stringify(report, null, 1)}\n`);
  } finally {
    await pool.end();
  }
}

// Not run when a test imports `counts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    // the error's code or name only: a file error's message would carry an upload's path
    console.error(`replay failed: ${err instanceof Error && !/ENOENT|EACCES/.test(err.message) ? err.message : (err as { code?: string }).code ?? "unknown error"}`);
    process.exit(1);
  });
}
