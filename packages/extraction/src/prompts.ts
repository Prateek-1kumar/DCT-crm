import { BudgetGrid, DocumentKind, GridCell, GridProcedure, Rulebook, SourceRef } from "@dct/shared";
import { z } from "zod";

/**
 * Schemas the models fill. They reuse the shared Rulebook pieces; the only change is that
 * structured outputs can't express records, so grid cells come back as a list.
 */

export const PageKind = z.enum(["terms", "budget_grid", "invoiceables", "signatures", "boilerplate"]);

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

export const AiNote = z.object({
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

export const AiGrid = BudgetGrid.omit({ id: true }).extend({
  procedures: z.array(GridProcedure.extend({ cells: z.array(z.object({ visit: z.string(), value: GridCell })) })),
});
export const AiGrids = z.object({ grids: z.array(AiGrid) });
export type AiGrid = z.infer<typeof AiGrid>;

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
- kind: "budget_grid" (a visit-by-procedure payment table or a per-visit budget summary), "invoiceables" (tables or lists of invoiceable items, site costs, start-up/close-out fees, screen-fail terms), "terms" (contract text with payment, overhead, holdback, deadline, invoicing, amendment or party/study details), "signatures" (signature pages), "boilerplate" (legal text with no money terms, e-signature certificates, cover sheets with nothing else).
- readable: false only if the page is too degraded to read even at high resolution.
- rotation: the clockwise rotation (0, 90, 180, 270) needed to make the text upright. Budget tables are often printed sideways.
- gridGroup: for budget_grid pages, a short label of the grid (e.g. "Arm A", "Site Budget Worksheet"); give consecutive pages of the same table the same label. null otherwise.`;

export const identifyPrompt = (docs: { id: string; filename: string }[]) => `These are the first pages of ${docs.length} uploaded document(s):
${docs.map((d) => `- documentId ${d.id}: "${d.filename}"`).join("\n")}
For each document give its kind (master_agreement, work_order, adoption, amendment, budget, other), a short title and its date (effective or execution date) if printed.
Then guess the study: sponsor (the company that owns the study, not a CRO), protocol number, site name (the contracting site entity) and principal investigator. Use null for anything you cannot see.`;

export type TermsPart = "study" | "payment" | "items";
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

export const gridPrompt = (documentId: string, pages: number[], tiles: boolean) => `Budget grid on documentId ${documentId}, page(s) ${pages.join(", ")}. ${
  tiles
    ? "Each page is given as an overview image followed by overlapping high-resolution tiles (row/column of the tile is in its label). Read the numbers from the tiles; use the overview only to see the layout. Overlapping areas appear in two tiles: count them once."
    : "Each page is given as one image."
}
Transcribe every grid on these pages (a page may hold one grid, or a grid may continue across pages). For each grid:
- label (its title), arm (e.g. "Arm A De Novo"; null if the study has one arm), statedOverheadPct exactly as labelled on the grid (even if the numbers compute differently), header.investigator and header.siteName as printed on this grid page (null if not printed).
- visits in column order: code (as printed, e.g. "V1", "SCR", "W2"), name, order (1, 2, ...), procedureSubtotalCents, overheadCents, nonProcedureCents (staff fees, stipends and other non-procedure lines) as printed in the subtotal rows (null if no such row), totalCents = the printed visit total, autopay (true unless the grid says the visit is invoiced).
- procedures: every row, including duplicate codes on separate rows. code, name, unitCents (unit price before overhead), overheadApplied, category ("non_procedure" for staff fees, stipends, travel, bonuses; else "procedure"), and cells = one entry per visit column where the row has a value: {visit: the visit code, value: printed cents, or "invoiceable" when the cell says Inv/Invoiceable}. Leave out empty cells.
- perPatientTotals: every printed per-patient/per-subject total with its label.
Transcribe printed numbers; do not recompute or correct them, even if they look inconsistent.`;
