import { BudgetGrid, DocumentKind, GridCell, GridProcedure, Rulebook, SourceRef } from "@dct/shared";
import { z } from "zod";

/**
 * Schemas the models fill. They reuse the shared Rulebook pieces; the only change is that
 * structured outputs can't express records, so grid cells come back as a list.
 */

/**
 * The last four are not read and not swept (EXCLUDED_PAGE_KINDS in @dct/shared). "boilerplate" stays for generic legal text
 * and cover sheets, which are read as before; it used to cover e-signature certificates too, and stored pages still hold it.
 */
export const PageKind = z.enum(["terms", "budget_grid", "invoiceables", "signatures", "boilerplate", "esign_certificate", "esign_disclosure", "reference_appendix", "non_content"]);
export type PageKind = z.infer<typeof PageKind>;

export const AiPages = z.object({
  pages: z.array(
    z.object({
      page: z.number().int(),
      kind: PageKind,
      readable: z.boolean(),
      /** Clockwise rotation that makes the page upright. */
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      /** Same label on consecutive pages that continue one budget grid; null if not a grid page. */
      gridGroup: z.string().nullable(),
    }),
  ),
});
export type AiPages = z.infer<typeof AiPages>;

export const AiIdentify = z.object({
  documents: z.array(z.object({ id: z.string(), kind: DocumentKind, title: z.string(), date: z.string().nullable() })),
  studyGuess: z.object({ sponsor: z.string().nullable(), protocol: z.string().nullable(), siteName: z.string().nullable(), investigator: z.string().nullable() }),
});

const AiNote = z.object({
  kind: z.enum(["ambiguous", "retroactive_no_date"]),
  topic: z.string(),
  path: z.string().nullable(),
  source: SourceRef.nullable(),
});

/**
 * Contract terms, read in three requests: structured outputs cap union-typed parameters (16) and
 * total grammar size per schema, and the full terms schema exceeds both.
 */
export const AiTermsStudy = Rulebook.pick({ study: true, documents: true, referencedDocuments: true, rounding: true, appliesFrom: true }).extend({
  notes: z.array(AiNote),
});
export const AiTermsPayment = Rulebook.pick({ overhead: true, payment: true, holdback: true, deadlines: true, overpayment: true });
export const AiTermsItems = Rulebook.pick({ invoiceables: true, screenFail: true, siteFees: true });
export const AiTerms = AiTermsStudy.extend(AiTermsPayment.shape).extend(AiTermsItems.shape);
export type AiTerms = z.infer<typeof AiTerms>;

/**
 * What a table prints beside a row, read so the binder can check it against the scan's own digits (ADR-002, the senior engineer):
 * the row's Quantity and its own Total column. Neither goes into the rulebook: extract.ts takes them out as `printedRows`.
 */
const PrintedBesideRow = { printedQty: z.number().nullable().optional(), printedRowTotalCents: z.number().int().nullable().optional() };
export const AiGrid = BudgetGrid.omit({ id: true }).extend({
  procedures: z.array(GridProcedure.extend({ cells: z.array(z.object({ visit: z.string(), value: GridCell })), ...PrintedBesideRow })),
});
export const AiGrids = z.object({ grids: z.array(AiGrid) });
export type AiGrid = z.infer<typeof AiGrid>;

/**
 * The grid read when a token map goes with each image (EXTRACTION_TOKEN_MAP): a cell, and a visit's own sums, may carry the
 * id of the token they were read from. Optional on purpose (no token for a value the text pass missed), and only ever a claim:
 * extract.ts drops an id that isn't in the map of that call, and nothing here changes what confirms a value.
 */
export const AiGridsAnchored = z.object({
  grids: z.array(
    AiGrid.extend({
      procedures: z.array(GridProcedure.extend({ cells: z.array(z.object({ visit: z.string(), value: GridCell, source_token_id: z.string().nullable() })), ...PrintedBesideRow })),
      visitTokens: z.array(z.object({ visit: z.string(), field: z.enum(["procedureSubtotal", "overhead", "nonProcedure", "total"]), source_token_id: z.string() })).optional(),
    }),
  ),
  /** Amounts in the image the model is sure are not a fee (a code, a page number, a repeat of a price it read, an insurance limit). Only a claim: the sweep drops one only when its own rules agree (sweep.ts). */
  nonFee: z.array(z.object({ source_token_id: z.string(), why: z.enum(["code", "page_number", "repeat", "insurance_limit", "other"]) })).optional(),
});
export type AiGridsAnchored = z.infer<typeof AiGridsAnchored>;

// ---------------------------------------------------------------- prompts

export const SYSTEM = `You transcribe clinical trial agreements (CTAs, work orders, amendments, budgets) for a clinical research site's finance team. The pages are scanned images, often tilted or sideways, with small print.

Rules:
- Transcribe what is printed. Never invent a value. If something is not stated, use null (or "unspecified"/"none" where the schema offers it) and give it a low confidence.
- Money is integer US cents: $1,234.50 → 123450. Percentages are plain numbers: 35% → 35.
- Every "prov" says where the value is: doc and page exactly as given in the image labels (page 0 when the value is not stated anywhere), loc (e.g. "Exhibit A §3", "grid row 'ECG', column V2"), and for rules (caps, deadlines, payment terms) a short exact quote of at most 25 words, else "".
- conf is your honest probability that the value is exactly right. Use < 0.8 when the print is blurry, a digit is uncertain, or you had to infer.
- Ignore payee bank details completely: never output bank names, account numbers, routing/ABA/SWIFT/IBAN numbers or tax IDs, anywhere, including quotes.
- Dates are ISO YYYY-MM-DD.`;

export const classifyPrompt = (documentId: string, filename: string, n: number) => `These are all ${n} pages of document "${filename}" (documentId ${documentId}), in order, at low resolution.
For each page give:
- kind: "budget_grid" (a visit-by-procedure payment table or a per-visit budget summary), "invoiceables" (tables or lists of invoiceable items, site costs, start-up/close-out fees, screen-fail terms), "terms" (contract text with payment, overhead, holdback, deadline, invoicing, amendment or party/study details), "signatures" (signature pages), "boilerplate" (legal text with no money terms, cover sheets with nothing else), or one of four kinds that are NOT read at all:
  - "esign_certificate": a page that only records how the document was electronically signed (a certificate or audit trail: signers, timestamps, addresses, envelope or tracking details).
  - "esign_disclosure": an electronic-signature vendor's legal notice about consent to electronic records and signatures (withdrawing consent, paper copies, software requirements).
  - "reference_appendix": reference material that sets no payment: lists of drug or product codes, protocol appendices, procedure-code lists without prices.
  - "non_content": a blank page, a separator or a cover sheet that holds only a title, names or a few words: no table and no number.
  Use one of those four only when you are sure the WHOLE page is that and nothing else. If the page prints any dollar amount, fee, payment, percentage or deadline term, it is NOT one of them: use "terms", "invoiceables" or "budget_grid". The one exception is an e-signature vendor's own notice (for example its copy-fee line), which stays "esign_disclosure". When in doubt, never pick one of the four: a page wrongly skipped can hide money, and a page wrongly read only costs a little. A contract's own clauses (insurance, indemnity, confidentiality) are "terms" or "boilerplate", never one of the four.
- readable: false only if the page is too degraded to read even at high resolution.
- rotation: the clockwise rotation (0, 90, 180, 270) needed to make the text upright. Budget tables are often printed sideways.
- gridGroup: for budget_grid pages, the key of the group of patients (arm or cohort) the table prices, short and as the page prints it (e.g. "Arm A", "Cohort 2"); when the table names no arm, its title (e.g. "Site Budget Worksheet"). Tables for different arms or cohorts must get different keys, even on consecutive pages, and consecutive pages of the same table the same key. null otherwise.`;

export const identifyPrompt = (docs: { id: string; filename: string }[]) => `These are the first pages of ${docs.length} uploaded document(s):
${docs.map((d) => `- documentId ${d.id}: "${d.filename}"`).join("\n")}
For each document give its kind (master_agreement, work_order, adoption, amendment, budget, other), a short title and its date (effective or execution date) if printed.
Then guess the study: sponsor (the company that owns the study, not a CRO), protocol number, site name (the contracting site entity) and principal investigator. Use null for anything you cannot see.`;

type TermsPart = "study" | "payment" | "items";
const TERMS_PARTS: Record<TermsPart, string> = {
  study: "Part 1 of 3: study, documents, referencedDocuments, rounding, appliesFrom and notes.",
  payment: "Part 2 of 3: overhead, payment, holdback, deadlines and overpayment.",
  items: "Part 3 of 3: invoiceables, screenFail and siteFees.",
};

export const termsPrompt = (docs: { id: string; filename: string; kind: string | null }[], part: TermsPart) => `${TERMS_PARTS[part]} Fill only the fields in the schema; the other parts are read separately.

Uploaded documents for this study:
${docs.map((d) => `- documentId ${d.id}: "${d.filename}"${d.kind ? ` (${d.kind})` : ""}`).join("\n")}

The images are every page with contract terms, invoiceables, site costs or budget tables. The per-visit budget grid itself is read separately: don't transcribe visit columns, but do read any contract clauses, fee lists or footnotes printed on the same pages. Extract the study's money terms:
- study: sponsor (the company that owns the study), payingAgent (CRO or payment agent that actually pays, e.g. PPD, IQVIA, Synteract; null if the sponsor pays directly — a CRO that only negotiated the budget is not a paying agent), protocol, siteName (the contracting site entity), investigator, effectiveDate (of the latest uploaded document whose terms govern — for an amendment, the amendment's effective date, not the original agreement's).
- documents: one entry per uploaded documentId above with kind, title and date.
- referencedDocuments: every other agreement these documents rely on (master/base CTA, earlier amendments, budgets, exhibits incorporated by reference). present = true only if it is one of the uploaded documents above.
- overhead: pct and which lines it applies to.
- payment: how visits are paid (auto from EDC/eCRF or by invoice), frequency, net days and what starts the clock, invoice address, what each invoice must reference, and conditions before payment.
- invoiceables: every separately billable item (unscheduled visits, SAE reports, re-consent, imaging, mileage, hotel, meals, eCOA compliance, amendments, ...). amountCents = the base/budget amount; amountWithOverheadCents = the amount in a "with overhead" column when one is printed. basis, frequency as written, cap, requiresPreApproval, requiredDocs.
- screenFail: amount (or basis "per_procedure" when paid per procedure performed), cap ("ratio_to_randomized" with ratio and n for "1 SF per 1 randomized, max N"; "blocks_with_reauth" with n for "not to exceed N, then sponsor re-authorises"; "count" for a plain maximum; "none"), how it is paid, required docs.
- siteFees: start-up/administrative, IRB, pharmacy, archiving, advertising, close-out, annual fees, pre-screening and similar one-off or periodic fees, with trigger and due days.
- holdback: percent withheld, what it applies to, release conditions. null if none.
- deadlines: only these kinds, when stated: invoice_days_from_expense, invoice_months_after_study_close, final_invoice_days_after_closeout, query_resolution_days, dispute_days_after_final_payment, edc_entry_business_days; with the consequence.
- overpayment: refund days and whether the sponsor may offset against later payments. null if not stated.
- rounding: "printed_amounts" if the budget is rounded (e.g. to whole dollars) and printed amounts govern, "cents" if exact cents, else "unspecified".
- appliesFrom: for an amendment, the date its terms apply from; null if none is given.
- notes: add {kind:"retroactive_no_date"} when the amendment says it applies retroactively but gives no start date. Add {kind:"ambiguous"} for each money term whose wording is genuinely unclear (e.g. whether overhead applies to stipends, whether site-cost amounts already include overhead, an invoiceable with no amount), with path = JSON pointer of the affected value (e.g. "/overhead/appliesTo") and the source.`;

const TILES = "Each page is given as an overview image followed by overlapping high-resolution tiles (row/column of the tile is in its label). Read the numbers from the tiles; use the overview only to see the layout. Overlapping areas appear in two tiles: count them once.";

/** Said once to the reader of a grid image that comes with a token map (never a terms page); the grid read also asks for each value's token. */
const TOKEN_HELP = "Next to each image you may get a TOKEN MAP: the words a text pass found in it, one entry per printed line of the image from top to bottom, as [y0, y1, [id, text, x0, x1], ...] with the words left to right and the boxes in the image's own pixels. A number is shown as its shape, every digit a \"#\" (\"$###.##\"): read every figure from the image itself, never from the map. The map only tells you where each word is, so you can point at it: a cell is the word on its row's line at its column's x position.";
const TOKEN_ANCHOR = " For every cell give the id of the token it is printed in as source_token_id, and for every visit subtotal, overhead, non-procedure amount and total printed in the grid give it in visitTokens (visit code, field, id), using only ids from the map next to the image you read it in. source_token_id is null only when no token holds the value; never make an id up. A token of the map that holds an amount and is none of your cells or sums, and that you are sure is not a fee (a code, a page number, a footnote or summary that repeats a price you already read, an insurance or liability limit), goes in nonFee with its id and why; leave out anything you are unsure of.";

export const gridPrompt = (documentId: string, pages: number[], tiles: boolean, how: { tokens?: boolean } = {}) => `Budget grid on documentId ${documentId}, page(s) ${pages.join(", ")}. ${
  tiles ? TILES : "Each page is given as one image."
}${how.tokens ? ` ${TOKEN_HELP}${TOKEN_ANCHOR}` : ""}
Transcribe every grid on these pages (a page may hold one grid, or a grid may continue across pages). For each grid:
- label (its title), arm (e.g. "Arm A De Novo"; null if the study has one arm), statedOverheadPct exactly as labelled on the grid (even if the numbers compute differently), header.investigator and header.siteName as printed on this grid page (null if not printed).
- visits in column order: code (as printed, e.g. "V1", "SCR", "W2"), name, order (1, 2, ...), procedureSubtotalCents, overheadCents, nonProcedureCents (staff fees, stipends and other non-procedure lines) as printed in the subtotal rows (null if no such row), totalCents = the printed visit total, autopay (true unless the grid says the visit is invoiced).
- procedures: every row, including duplicate codes on separate rows. code, name, unitCents (unit price before overhead), overheadApplied, category ("non_procedure" for staff fees, stipends, travel, bonuses; else "procedure"), and cells = one entry per visit column where the row has a value: {visit: the visit code, value: printed cents, or "invoiceable" when the cell says Inv/Invoiceable}. Leave out empty cells. printedQty: the number in the row's Quantity (Qty, Total Quantity) column, null when the table has none. printedRowTotalCents: the amount in the row's own Total column (the row added across the visits, in cents), null when the table has none; read it only from that column, never compute it.
  Rows that are billed separately and NOT included in the visit total — e.g. a grid section headed "Invoiceable", "Other costs", "To be invoiced", local labs, mammograms, patient travel or stipends invoiced per visit — must use "invoiceable" in every cell where they occur, even when a price is printed there (record the price as unitCents). Only rows that make up the printed visit total get priced cells.
- perPatientTotals: every printed per-patient/per-subject total with its label. A total for several patients (the per-patient total times a number of patients, such as a whole-study estimate) is not a per-patient total: include it only with that number of patients in its label.
Transcribe printed numbers; do not recompute or correct them, even if they look inconsistent.`;
