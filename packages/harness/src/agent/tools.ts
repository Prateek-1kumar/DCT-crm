import type Anthropic from "@anthropic-ai/sdk";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const array = (items: unknown) => ({ type: "array", items });
const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const orNull = { type: ["string", "null"] };
// Amounts go in as printed ("$1,234.56") or as a number; the harness turns them into cents.
const amount = { type: ["string", "number", "null"] };
const oneOf = (...values: string[]) => ({ type: "string", enum: values });

// The shapes are spelled out because a bare object cost a rejected call or two per read; they guide the model and
// normalize.ts stays the judge of what is saved.
const STUDY = object(
  {
    protocol: string, sponsor: string, payer: orNull, siteEntity: string, siteNumber: orNull, pi: orNull, effectiveDate: orNull,
    documents: array(
      object(
        {
          doc: { type: "string", description: "The file's name exactly as in the inventory." },
          role: oneOf("cta", "work_order", "master_agreement", "amendment", "budget", "protocol", "other"),
          hasMoney: boolean,
          supersedes: { type: "array", items: string, description: "What it replaces, e.g. [\"Exhibit A of the CTA\"]; [] when nothing." },
          effectiveFrom: orNull,
          retroactive: boolean,
          notes: orNull,
        },
        ["doc", "role", "hasMoney", "supersedes", "effectiveFrom", "retroactive"],
      ),
    ),
  },
  ["protocol", "sponsor", "siteEntity", "documents"],
);

const TERM = object(
  {
    id: { type: "string", description: "Letters, digits and dashes; no colon." },
    category: oneOf("payment_terms", "invoicing", "holdback", "overhead", "site_fee", "recurring_fee", "invoiceable", "conditional_procedure", "screen_failure", "unscheduled_visit", "stipend_travel", "bonus", "cap_or_limit", "deadline", "other"),
    name: string,
    amount: { ...amount, description: "What is paid for ONE of the unit, as printed; never a line total. null when the term has no amount of its own." },
    unit: orNull,
    billing: oneOf("auto_paid", "invoice", "unknown"),
    billingBasis: {
      type: ["object", "null"],
      description: 'The contract\'s own words that say how THIS item is paid, required for billing "invoice" or "auto_paid" on a fee: {page, quote, doc (only when it is in another document)}. Without words that are on that page the billing is set to "unknown" and the accountant is asked.',
      properties: { doc: string, page: integer, quote: string },
    },
    trigger: orNull,
    cap: {
      type: ["object", "null"],
      properties: { kind: oneOf("count", "amount", "ratio", "hours", "none"), value: { ...amount, description: "A count, hours or a ratio's left side as a number; a dollar amount as printed for kind amount." }, period: orNull, text: string },
      required: ["kind"],
    },
    formula: orNull, conditions: orNull,
    holdbackApplies: oneOf("yes", "no", "unclear", "n/a"),
    overheadApplies: oneOf("included", "added", "no", "unclear", "n/a"),
    deadline: orNull, notes: orNull,
    source: object({ doc: string, page: integer, quote: string, cell: string, capCell: string }, ["doc", "page", "quote"]),
  },
  ["id", "category", "name", "billing", "source"],
);

const cellValues = { type: "array", description: "One per visit: an amount, the printed words, or null for blank; on a SCAN page each amount is {value, cell}." };
const gridAmount = { description: "An amount as printed, or null; on a SCAN page {value, cell}." };
const GRID = object(
  {
    id: string, name: string, arm: orNull, doc: string, pages: array(integer), visits: array(string),
    overheadPct: { type: ["string", "number", "null"] },
    rows: array(object({ name: string, code: orNull, unitCost: { description: "An amount, or null when the row prints none (never words such as \"Invoice\"); on a SCAN page {value, cell}." }, cells: cellValues, printedRowTotal: gridAmount }, ["name", "cells"])),
    subtotal: cellValues, overhead: cellValues,
    additions: array(object({ name: string, cells: cellValues }, ["name", "cells"])),
    total: cellValues, grandTotal: gridAmount,
  },
  ["id", "name", "doc", "pages", "visits", "rows"],
);

const FEE_TABLE = object(
  {
    id: string, name: string, doc: string, pages: array(integer),
    total: { description: "The printed total of the whole table (a total not to exceed), as printed, or null when none is printed; on a SCAN page {value, cell}." },
    lines: array(
      object(
        {
          name: string,
          total: { description: "The printed line total, or the printed total of a section, as printed; on a SCAN page {value, cell}." },
          quantity: { type: ["number", "string", "null"], description: "The printed quantity or stated maximum count; null when the line prints none." },
          termIds: { type: "array", items: string, description: "The ids of the terms paid out of this line: one for a plain line, several for a section total, [] when no term is paid from it." },
        },
        ["name", "total", "termIds"],
      ),
    ),
  },
  ["id", "name", "doc", "pages", "lines"],
);

const RELATION = object({ doc: string, kind: oneOf("sum", "product", "same"), result: string, operands: array(string), rate: string }, ["doc", "kind", "result", "operands"]);
const ACCOUNTED = object({ doc: string, page: integer, pages: array(integer), amount, cell: string, reason: string }, ["doc", "reason"]);

export const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "read_pages",
    description: "Text of pages with the columns kept aligned, up to 15 pages per call. SCAN pages come with the text a vision model read from the image: tables as rows of cells, each table, row and line with its id, and doubtful or marked-up values tagged {?}, {hw}, {x} or {in}. IMAGE pages have no text: use view_page.",
    input_schema: object({ doc: string, pages: array(integer) }, ["doc", "pages"]),
  },
  {
    name: "view_page",
    description: "Render a page (or a region of it) as an image. region = [x0, y0, x1, y1] as fractions 0-1 of the page, origin top-left; use it to zoom into dense grids and footnotes. dpi up to 300.",
    input_schema: object({ doc: string, page: integer, region: array({ type: "number" }), dpi: integer }, ["doc", "page"]),
  },
  {
    name: "search",
    description: "Case-insensitive regex search across the text of all documents. Returns document, page and line (at most 60 hits).",
    input_schema: object({ pattern: string }, ["pattern"]),
  },
  {
    name: "put_study",
    description: "Set the study details and every document's role and what it supersedes. documents is a list with one entry per file, each naming its file in doc; supersedes is a list. Replaces the earlier study.",
    input_schema: object({ study: STUDY }, ["study"]),
  },
  {
    name: "put_terms",
    description: "Add or replace rulebook terms (by id). Each term's source.quote is checked against its page; the result lists the quotes that were not found. On a SCAN page the amount must be the one printed in the cell or line source.cell names, on the row or line the quote is from (and a cap amount the one source.capCell names). Invalid terms are rejected with the reason.",
    input_schema: object({ terms: array(TERM) }, ["terms"]),
  },
  {
    name: "put_grid",
    description: "Add or replace one budget grid (by id). On a SCAN page every amount is {value, cell} and the grid is refused if a cell doesn't print its value, or one row's or one visit's amounts come from different printed rows or columns. Its arithmetic is checked at once against the contract's own printed subtotals, overhead and totals; problems are returned, or PROVEN when everything holds.",
    input_schema: object({ grid: GRID }, ["grid"]),
  },
  {
    name: "put_fee_table",
    description: "Add or replace one fee table (by id): the line totals, quantities and table total a table of site fees prints. They are never payable amounts; they prove the fee terms. Its arithmetic is checked at once: the lines add up to the printed table total, and a line's quantity × its one term's amount is the printed line total; problems are returned, or PROVEN when everything holds. Write the terms first. On a SCAN page every total is {value, cell} and the table is refused if a cell doesn't print its value.",
    input_schema: object({ feeTable: FEE_TABLE }, ["feeTable"]),
  },
  {
    name: "put_relations",
    description:
      "Arithmetic a SCAN page prints between its cells, which proves those cells when it holds. Each: {doc, kind, result, operands, rate}, every one a cell or line id as read_pages shows it, never a typed number. kind sum: result = the operands added up, plus rate (a cell printing a percent) on top when given (a fee plus 30% overhead = the fee with overhead). kind product: result = the one operand times rate (a cell printing a count such as 8.00, or a percent): unit cost × quantity = total, subtotal × 30% = overhead. For sum and product, the result and its operands are table cells in one printed row (or one printed column), the result after them; the rate may be any cell or line on the result's page. kind same: the one value a term or grid cites, printed again on a different page. Code evaluates each on the cells as read, to the cent: one that doesn't hold is refused with the reason and proves nothing, and the reply says which cells each one proves.",
    input_schema: object({ relations: array(RELATION) }, ["relations"]),
  },
  {
    name: "put_accounted",
    description:
      "Explain dollar amounts on pages that are deliberately NOT rulebook values: {doc, page, amount, reason} for one amount (on a SCAN page {doc, page, cell, reason} names the one cell), or {doc, pages: [..], reason} for whole pages (a budget superseded by an amendment, a sample invoice, insurance limits). Never use this to hide a billable amount.",
    input_schema: object({ items: array(ACCOUNTED) }, ["items"]),
  },
  {
    name: "put_questions",
    description:
      "Questions for the accountant: only what a person must decide. Each: {id, kind: reading | elsewhere | decision, about: {target: term | grid | study, id} or null, question, context, source: {doc, page, quote}, options: [{label, patches}], suggestion: {option (index), reason} or null}. patches is a list of {target, id, set} (may be empty); each set uses the rulebook's stored field names with money in integer cents. Never ask to confirm a value the checks prove.",
    input_schema: object({ questions: array({ type: "object" }) }, ["questions"]),
  },
  {
    name: "finish",
    description:
      "Run every check over the whole rulebook (grid arithmetic, quotes on their pages, every dollar amount in the documents accounted for). If problems remain you get them back and should fix them, then finish again; after the last allowed finish the remaining problems stand as open items for the accountant.",
    input_schema: object({}),
  },
];
