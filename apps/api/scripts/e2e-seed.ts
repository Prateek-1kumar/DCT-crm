// e2e only (pnpm e2e), after e2e-reset: a synthetic contract with a draft rulebook, so the browser can walk every screen
// without a model. Refuses anything but a *_e2e database.
import { checks, pdfReader } from "@dct/harness";
import type { Question, Rulebook } from "@dct/shared";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { config } from "../src/config.js";
import { createDb } from "../src/db/index.js";
import { documents, parties, studies, studyDocuments, versions } from "../src/db/schema.js";
import { pdfPath, savePdf } from "../src/lib/storage.js";

const dbName = new URL(config.databaseUrl).pathname.slice(1);
if (!dbName.endsWith("_e2e")) throw new Error(`e2e-seed refuses to touch database "${dbName}": needs a *_e2e database`);

const DOC = "Example CTA.pdf";
const LINES = [
  "Clinical Trial Agreement, Exhibit B: Budget",
  "The Sponsor will pay the Site a startup fee of $5,000.00 upon site activation.",
  "An archiving fee of $750.00 is payable at study close-out.",
  "Payment is due within 45 days of receipt of an invoice.",
  "The insurance limit of $2,000,000.00 is not a payment to the Site.",
  "Per-patient budget",
  "Item              Visit 1     Visit 2     Total",
  "Physical exam     $100.00     $200.00     $300.00",
  "Total             $100.00     $200.00     $300.00",
];

const file = await PDFDocument.create();
const font = await file.embedFont(StandardFonts.Courier);
const page = file.addPage([612, 792]);
LINES.forEach((line, i) => page.drawText(line, { x: 48, y: 740 - i * 18, size: 9, font }));
const hash = await savePdf(Buffer.from(await file.save()));
const loaded = { ...(await pdfReader.load(pdfPath(hash))), name: DOC };

const source = (quote: string) => ({ doc: DOC, page: 1, quote });
const term = (over: Partial<Rulebook["terms"][number]> & Pick<Rulebook["terms"][number], "id" | "category" | "name" | "source">): Rulebook["terms"][number] => ({
  amountCents: null, unit: null, billing: "auto_paid", trigger: null, cap: null, formula: null, conditions: null,
  holdbackApplies: "n/a", overheadApplies: "n/a", deadline: null, evidence: "quote", houseRuleIds: [], notes: null, ...over,
});

const reviewer: Question = {
  id: "review:0", kind: "decision", origin: "reviewer", about: { target: "term", id: "archiving" },
  question: "Is the archiving fee paid once, or each year records are stored?",
  context: "The contract says the archiving fee is payable at close-out, but not whether storage beyond that is paid again.",
  source: source("An archiving fee of $750.00 is payable at study close-out."),
  options: [
    { label: "Once, at close-out", patches: [{ target: "term", id: "archiving", set: { unit: "one time" } }] },
    { label: "Each year of storage", patches: [{ target: "term", id: "archiving", set: { unit: "per year" } }] },
  ],
  suggestion: { option: 0, reason: "The clause names a single payment at close-out." },
  state: "open", blocking: false, readings: [], resolution: null,
};

const draft: Rulebook = {
  study: {
    protocol: "EX-101", sponsor: "Example Pharma", payer: null, siteEntity: "Discovery Clinical Trials", siteNumber: null, pi: null, effectiveDate: null,
    documents: [{ doc: DOC, role: "cta", hasMoney: true, supersedes: [], effectiveFrom: null, retroactive: false, notes: null }],
  },
  terms: [
    term({ id: "startup", category: "site_fee", name: "Startup fee", amountCents: 500000, unit: "one time", billing: "unknown", trigger: "site activation", source: source("startup fee of $5,000.00 upon site activation") }),
    term({ id: "archiving", category: "site_fee", name: "Archiving fee", amountCents: 75000, unit: "one time", billing: "invoice", trigger: "study close-out", source: source("An archiving fee of $750.00 is payable at study close-out.") }),
    term({ id: "terms", category: "payment_terms", name: "Payment terms", deadline: "45 days from invoice", source: source("Payment is due within 45 days of receipt of an invoice.") }),
  ],
  grids: [{
    id: "budget", name: "Per-patient budget", arm: null, doc: DOC, pages: [1], visits: ["Visit 1", "Visit 2"], overheadPct: null,
    rows: [{ name: "Physical exam", code: null, unitCostCents: null, cells: [10000, 20000], printedRowTotalCents: 30000 }],
    subtotal: null, overhead: null, additions: [], total: [10000, 20000], grandTotalCents: 30000, cellsReadTwice: [], acceptedAsPrinted: false,
  }],
  accounted: [{ doc: DOC, page: 1, amountCents: 200000000, reason: "Insurance limit, not a payment to the site" }],
  questions: [reviewer],
};
const report = checks.runChecks(draft, [loaded]);
const rulebook: Rulebook = { ...draft, questions: [...report.required, ...draft.questions] };

const { db, pool } = createDb(config.databaseUrl);
await db.transaction(async (tx) => {
  const by = "E2E Setup";
  const [sponsor] = await tx.insert(parties).values({ kind: "sponsor", name: "Example Pharma", createdBy: by }).returning();
  const [site] = await tx.insert(parties).values({ kind: "site", name: "Discovery Clinical Trials", createdBy: by }).returning();
  const [study] = await tx.insert(studies).values({ protocol: "EX-101", sponsorId: sponsor!.id, siteId: site!.id, createdBy: by }).returning();
  const pages = loaded.pages.map((p) => ({ page: p.page, kind: p.kind, chars: p.raw.length, firstLine: p.firstLine }));
  const [doc] = await tx.insert(documents).values({ sha256: hash, name: DOC, bytes: 0, pages, createdBy: by }).returning();
  await tx.insert(studyDocuments).values({ studyId: study!.id, documentId: doc!.id, addedBy: by });
  await tx.insert(versions).values({ studyId: study!.id, number: 1, status: "draft", documentIds: [doc!.id], rulebook, problems: report.problems, createdBy: by });
});
await pool.end();
console.log(`e2e seeded: ${rulebook.questions.length} questions, ${report.problems.length} problems`);
