# Workstream B: `@dct/extraction`

Scanned contract PDFs → `Rulebook` (Claude primary read + OpenAI cross-read) → deterministic contract checks → scoring against hand-checked golden files.

## Status

| Done | |
|---|---|
| PDF rendering | `mupdf` (WASM), no system binaries. Page count, render at DPI, rotation, crop, overlapping tiles. |
| Pipeline | classify every page (kind, readable, rotation, grid group) → term pages at ≤2150 px → grid pages re-rendered at 400 DPI, upright, as ~1900 px tiles + overview → one terms call + one call per grid → `Rulebook.parse` |
| Cross-read | OpenAI reads the same images independently into a second Rulebook; each primary `prov.crossCheck` set to agree/disagree |
| Checks | All 13 `ContractAnomalyCode`s, pure code, unit-tested |
| Scoring | Field-by-field vs `data/golden/*.json`; golden-vs-golden = 100% (synthetic + all 4 real goldens) |
| Fake mode | `EXTRACTION_FAKE=1` → synthetic study (`fixtures/fake-extraction.json`, not a real contract) |
| Live eval | **Not run: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are empty in `.env`.** Ready to run. |

## API (for Workstream A)

```ts
import { identifyDocuments, extractStudy, runContractChecks, renderPage, pageCount, ExtractionLimitError } from "@dct/extraction";

const out = await extractStudy({ documents, onProgress });          // ExtractionOutput
const anomalies = runContractChecks(out.rulebook, {
  crossRead: out.crossRead,
  pages: out.pages,   // enables UNREADABLE_PAGE
  notes: out.notes,   // enables note-based AMBIGUOUS_TERM / RETROACTIVE_NO_DATE
});
```

- `ExtractionOutput` has the PHASE-1 fields plus two extras: `notes` (things the schema has no field for yet, see below; **store them with the version** so re-running checks after a correction keeps those anomalies) and `warnings` (e.g. "cross-read skipped").
- `runContractChecks(rulebook, { crossRead })` (exactly as in PHASE-1) still works; `pages`/`notes` are optional.
- Also exported: `pageCount(pdfPath)` (for `DocumentDto.pageCount`), `ExtractionLimitError`, `RENDER_LIMITS`.
- Anomaly ids are `CODE:jsonPointer` (with `#2`… on a repeat), stable across runs of the same rulebook.
- The package loads no `.env` itself; the API process must have `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`, `OPENAI_MODEL`) in its environment.

## How to run

```sh
pnpm --filter @dct/extraction test         # unit tests (mocked AI, synthetic PDFs)
pnpm --filter @dct/extraction typecheck
pnpm --filter @dct/extraction eval         # live: 4 real contracts → data/extractions/<name>.json, then score (skips cleanly if no key)
pnpm --filter @dct/extraction eval shah    # one contract
pnpm --filter @dct/extraction score        # score saved outputs, no AI calls
```

- Repo root (for `.env`, `data/`) defaults to two levels above the package; override with `DCT_ROOT=/path/to/checkout` (needed when running from a git worktree, which has no `data/`).
- Env: `ANTHROPIC_API_KEY` (required for live), `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `OPENAI_API_KEY` + `OPENAI_MODEL` (both needed for the cross-read; no default model), `OPENAI_PRICE_PER_MTOK="in,out"` (USD per million tokens, for the OpenAI cost line; 0 if unset), `EXTRACTION_GRID_DPI` (default 400, max 600), `EXTRACTION_FAKE=1`.
- Golden JSON: `data/golden/{copd,mcallen,hcwc,shah}.json`, converted by hand from `EXPECTED.md` (git-ignored). Gaps in EXPECTED.md, so not scored: HCWC protocol number, HCWC telephone-visit count (scored once), HCWC Arm B visit totals, McAllen procedure rows.
- Golden grids can carry `rows` (every grid row, cells in visit order), scored as one check per row in "grid rows". `python3 -I scripts/golden-grid-from-xlsx.py <budget.xlsx> <golden.json>` fills them from the sponsor's budget spreadsheet, and refuses unless the sheet's visit totals equal a golden grid's (so a draft budget is never written as truth). COPD: 68 rows × 16 visits from `data/contracts/copd-native/EFC18243 Ex A-1 Final 26May25.xlsx`; only its grid sheet matches the signed contract, its conditional-procedure and site-cost sheets are a pre-negotiation draft.
- `copd-native` golden = COPD against the signed DocuSign original (`data/contracts/copd-native/`), which has a text layer; `copd` is the image-only print of the same 20 pages.
- With `DCT_ROOT` set, the unit tests also check every real golden file scores 100% against itself.

## Decisions

- **Claude call** (`src/llm.ts`, the only place models are called): `@anthropic-ai/sdk` `beta.messages.stream(...).finalMessage()`, `thinking: {type: "adaptive"}`, `output_config: {effort, format: json_schema}`, `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`. `stop_reason: "refusal"` (after fallback) and `max_tokens` throw. The schema comes from the SDK's `betaZodOutputFormat` transform but parsing is ours (zod), so usage is counted even when a reply fails validation; one retry on a bad parse. Timeout 15 min, 3 SDK retries.
- **OpenAI call**: official `openai` SDK, Responses API, `json_schema` with `strict: false` (the shared schemas have optional fields, which strict mode forbids), zod validates. Model only from `OPENAI_MODEL`; unset → `crossRead: null`. A failed cross-read is a warning, not a failed extraction.
- **AI schemas reuse the shared zod schemas** (`src/prompts.ts`); only grid `cells` become a list, since structured outputs can't express records. A test checks every AI schema converts to a structured-output-compatible JSON schema.
- **Image sizes** stay under Claude's vision limits (2576 px long edge, ~3.75 MP): bigger images get downscaled server-side, which would waste the high-DPI render. Term pages ≤ 2150 px, grid tiles 1900 px square with 8% overlap. A letter page at 400 DPI is 6 tiles; on the McAllen detailed grid a tile reads cleanly.
- **Rotation**: detected by the classifier per page (sideways grids), applied before rendering.
- **Multi-document studies**: all documents' term pages go into one terms call (so terms from master + work order + amendment merge in one read); every document's grids are read; `referencedDocuments[].present` is decided against the uploaded list.
- **Security**: on text pages, bank details (a bank sentence's account, routing and IBAN words: `bankRects`) are painted black in every image sent to a model (ADR-001 §9); scans have no text to find them by, so there the system prompt tells the models to ignore them. After parsing, in any string (list items too): IBANs and runs of 8+ digits, whole or grouped by spaces or hyphens (not ISO dates), become `[redacted]`; a string about a bank that still carries an account or SWIFT code is replaced whole; quotes mentioning bank/routing/account/SWIFT/IBAN are dropped. Nothing logs contract text; the eval prints amounts and field names only.
- **Checks, notable rules**
  - Tolerance: ±$1 when `rounding = printed_amounts`, else ±1 cent.
  - `PER_PATIENT_TOTAL_MISMATCH` accepts a printed total equal to all visits minus one contiguous block of visits (McAllen "double-blind only" skips the open-label block; unscheduled/ET at the end), with ±$1 per visit when rounded. Heuristic: could hide a mismatch that equals some block sum.
  - `OVERHEAD_LABEL_MISMATCH`: aggregate overhead ÷ procedure subtotal and ÷ (procedure + non-procedure) over the grid's visits; flagged if neither is within 0.5 points of the label.
  - `DUPLICATE_ITEM`: a priced (not "invoiceable") grid cell whose row matches an invoiceable by code, exact name, or a shared word plus the same amount.
  - `GRID_CONFLICT`: ≥2 grids with the same `arm` whose visit totals or per-patient totals differ, while `governingGridId` is null.
  - `AI_DISAGREEMENT`: rulebooks flattened to stable keys (grid arm, visit code, item code+name, deadline kind), compared field by field; an item one read lacks entirely is one anomaly, not one per field.
  - `TEXT_LAYER_MISMATCH` (digital PDFs only): after the reads, each page's embedded text is parsed (mupdf, no AI) into the money amounts printed on it, stored as `pages[].printed` (cents; digit runs of 8+ without separators are dropped, so account/phone numbers are never kept). Every amount the AI read must be printed on the page its prov cites; one anomaly per item, with the pages where the amount *is* printed. Scans have no text layer, so it stays silent on them. Replayed on the saved COPD read against the signed DocuSign PDF: 788/789 amounts on their cited page; the one flag is a real wrong page reference (admin fee cited on p.4, printed on p.9). Ceiling: a cell misread as another price on the same page passes.
  - Severity: blocker = GRID_CONFLICT, HEADER_MISMATCH, RETROACTIVE_NO_DATE, UNREADABLE_PAGE; info = LOW_CONFIDENCE; rest warning.

## Proposed shared-schema changes (not made; `packages/shared` untouched)

1. `Rulebook.ambiguities: { topic, path, prov }[]`: AMBIGUOUS_TERM wording issues (HCWC overhead on stipends, Shah overhead in site costs) have no home today; carried as `ExtractionOutput.notes`.
2. `appliesFrom.retroactive: boolean` (or a `retroactive` flag on the rulebook): Shah's "retroactive, no date". Today detected from a `notes` entry or a quote containing "retroactiv".
3. `Rulebook.unreadablePages` or page info on the version: UNREADABLE_PAGE needs `ExtractionOutput.pages` passed in.
4. `GridVisit.inPerPatientTotal` or `perPatientTotals[].visitCodes`: makes PER_PATIENT_TOTAL_MISMATCH exact instead of the block heuristic.
5. `GridProcedure.cells` as an array (`{visit, value}[]`) would match what structured outputs can produce; the record form forces a conversion step.

## Known accuracy

No live numbers yet (no keys). Expected weak spots, in order:
1. Grid digits in tiny sideways type (cents like 14.2666667, 356.666667 on McAllen). Mitigated by 400 DPI tiles + the cross-read; AI_DISAGREEMENT and VISIT_TOTAL_MISMATCH should surface misreads.
2. Grids spanning pages or tiles: the model must join rows across tiles/pages; overlap areas can be double-counted.
3. Invoiceables vs site fees filed under different headings (scoring accepts either).
4. Visit codes differ between the two reads → spurious AI_DISAGREEMENT (keyed by visit code).

## Cost per contract (estimate, not measured)

Claude Opus 5.5 at $4 / $20 per MTok: ~150–250k input tokens (classification ~1.3k/page, term pages ~4.5k each, ~6 tiles × ~4.7k per grid page) and ~60–100k output tokens (adaptive thinking at `high` effort + JSON). Roughly **$2–3.50 per contract** for the primary read (Shah lowest, McAllen highest); the OpenAI cross-read adds its own model's price. The eval prints measured cost per contract.

## Resource limits

All in `CONFIG` (`packages/extraction/src/extract.ts`); render limits are `RENDER_LIMITS` (`src/render.ts`, also exported and reachable as `CONFIG.render`).

| Limit | Default | On exceed |
|---|---|---|
| `render.timeoutMs` | 30 s | one mupdf call (draw a page, read its text) is stopped and its worker replaced; `RenderTimeoutError`, and that page fails at once from then on |
| `render.maxDpi` | 600 | requested DPI clamped (applies to `renderPage` and grid tiles; `EXTRACTION_GRID_DPI` above 600 is clamped) |
| `render.maxPixels` | 40 MP per image | full page downscaled to fit; an oversize tile/clip is rejected (`RangeError`) |
| page number | 1 ≤ page ≤ pageCount, integer | `RangeError` (renderPage gets page numbers from user requests) |
| `render.maxTilesPerPage` | 12 | tile DPI lowered until the page fits; `RangeError` if it can't fit at any DPI |
| `maxPagesPerDoc` | 100 | `ExtractionLimitError` before any rendering or AI call (extract and identify) |
| `maxPagesTotal` | 200 across all documents of a study | `ExtractionLimitError` before any rendering or AI call (extract and identify) |
| `maxTilesPerExtraction` | 60 | tile layout is computed and charged first; `ExtractionLimitError` before that page's pixmaps are allocated |
| `maxImagesPerExtraction` | 300 (classification + term pages + grid overviews + tiles; or one identify call) | `ExtractionLimitError` before the images that would exceed it are rendered |

## Cost decision (2026-10-26): $1 per contract maximum

- **No Opus.** Sonnet 5.5 reads terms and grids; Haiku 5.5 sorts pages and identifies documents.
- **Cross-read:** Haiku re-reads contract terms only (`CROSS_READ=haiku`, the default). Budget grids aren't cross-read (`CROSS_READ_GRIDS=1` turns that back on); they're verified by arithmetic, and a re-read is triggered when a few totals don't add up.
- **Why not OpenAI:** gpt-5.5 cost more than the primary read ($1–2.30 per contract), and on McAllen every disagreement checked against the golden answers was its misread.
- **Image sizes:** terms pages at 1568 px (Claude's recommended size). Grid tiles unchanged (400 DPI).
- **Effort:** medium on terms and grids; a re-read runs once at high effort.
- **Guard:** a runaway cap on real spend, `EXTRACTION_MAX_USD` (default $20 per contract; user decision 2026-10-28): checked before every model call, which then fails with `ExtractionLimitError`. Calls already running can still finish, so the overshoot is at most their cost. Each call's output (thinking included) is bounded by its kind (`CONFIG.maxOutputTokens`: 8K classify/identify, 32K terms, 64K grid). Grid re-reads run only while `spent + 1.5 × that grid's estimate` stays under the cap.
- **Offline estimates** (no AI calls, page types replayed from earlier runs): Shah $0.46, COPD $0.54, McAllen $0.81, HCWC $0.81.
- **Measured before this change** (Sonnet + gpt-5.5 cross-read of everything): $1.46, $2.16, $3.53, $3.84.
- **Not live-tested yet** (user will run): re-measure with `pnpm eval <name>`.
