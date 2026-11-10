import type Anthropic from "@anthropic-ai/sdk";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const array = (items: unknown) => ({ type: "array", items });
const string = { type: "string" };
const integer = { type: "integer" };

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
    description: "Set the study details and every document's role and what it supersedes. Replaces the earlier study.",
    input_schema: object({ study: { type: "object" } }, ["study"]),
  },
  {
    name: "put_terms",
    description: "Add or replace rulebook terms (by id). Each term's source.quote is checked against its page; the result lists the quotes that were not found. On a SCAN page the amount must be the one printed in the cell or line source.cell names, on the row or line the quote is from (and a cap amount the one source.capCell names). Invalid terms are rejected with the reason.",
    input_schema: object({ terms: array({ type: "object" }) }, ["terms"]),
  },
  {
    name: "put_grid",
    description: "Add or replace one budget grid (by id). On a SCAN page every amount is {value, cell} and the grid is refused if a cell doesn't print its value, or one row's or one visit's amounts come from different printed rows or columns. Its arithmetic is checked at once against the contract's own printed subtotals, overhead and totals; problems are returned, or PROVEN when everything holds.",
    input_schema: object({ grid: { type: "object" } }, ["grid"]),
  },
  {
    name: "put_relations",
    description:
      "Arithmetic a SCAN page prints between its cells, which proves those cells when it holds. Each: {doc, kind, result, operands, rate}, every one a cell or line id as read_pages shows it, never a typed number. kind sum: result = the operands added up, plus rate (a cell printing a percent) on top when given (a fee plus 30% overhead = the fee with overhead). kind product: result = the one operand times rate (a cell printing a count such as 8.00, or a percent): unit cost × quantity = total, subtotal × 30% = overhead. For sum and product, the result and its operands are table cells in one printed row (or one printed column), the result after them; the rate may be any cell or line on the result's page. kind same: the one value a term or grid cites, printed again on a different page. Code evaluates each on the cells as read, to the cent: one that doesn't hold is refused with the reason and proves nothing, and the reply says which cells each one proves.",
    input_schema: object({ relations: array({ type: "object" }) }, ["relations"]),
  },
  {
    name: "put_accounted",
    description:
      "Explain dollar amounts on pages that are deliberately NOT rulebook values: {doc, page, amount, reason} for one amount, or {doc, pages: [..], reason} for whole pages (a budget superseded by an amendment, a sample invoice, insurance limits). Never use this to hide a billable amount.",
    input_schema: object({ items: array({ type: "object" }) }, ["items"]),
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
