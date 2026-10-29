# packages/extraction (`@dct/extraction`)

Everything that touches a PDF or a model: page counts, rendering and the text layer (mupdf, in a worker thread), the AI reads that produce a `Rulebook`, the evidence binder that checks every value against the PDF's own text, the deterministic contract checks, and scoring against hand-checked answer keys. No database, no HTTP. The API uses it only through `apps/api/src/extraction/port.ts`. Design: [ADR-001](../../docs/phase-1/adr-001-extraction-evidence.md); history and limits: [docs/phase-1/extraction.md](../../docs/phase-1/extraction.md). Repo rules: [AGENTS.md](../../AGENTS.md).

## Key files

| File | What it holds |
|---|---|
| `src/index.ts` | The public exports: `identifyDocuments`, `extractStudy`, `runContractChecks`, `renderPage`, `pageCount`, `readTextLayer`, `bindEvidence`, `reviewFromEvidence`, the limit errors, `ReadWarning` |
| `src/extract.ts` | The read pipeline and `CONFIG` (page, image and tile caps; `maxUsd`); `capped` (before every model call: the job's abort `signal`, then the spend cap; the signal also cancels the call in flight); bank masks for every image; `sanitize`/`scrub` of bank-like strings in every reply, identify's too; `ReadWarning` (what made a read weaker, by kind, with the reading's own `text`); fake mode switch |
| `src/llm.ts` | The only place a model is called (Anthropic SDK, optional OpenAI): timeouts, retries, prices, usage, a request's `signal`. A reply that isn't JSON is reported by error class and position, never with any of its text. `clientsFromEnv` picks models and the second reader |
| `src/prompts.ts` · `src/model-schema.ts` | The prompts and AI schemas (shared schemas, grid cells as a list); the compact provenance the model fills (converted with the Anthropic SDK's `betaZodOutputFormat` helper, which calls nothing) |
| `src/render.ts` · `src/mupdf-worker.mjs` | mupdf calls, run in a worker with a 30 s timeout per call; `RENDER_LIMITS`; page images, tiles, masks. `count` loads a page before counting, so a `/Count` the page tree doesn't hold is corrected: the upload, the read and the viewer agree |
| `src/textlayer.ts` | `readTextLayer`: visible words with boxes, each page's text source (`text`, `ocr_layer`, `image_only`), hidden text, `largePicture` (a text page with a picture big enough to hold prices: attested like a scan), `bankRects` (bank sentences, and account-like numbers on a bank label's line or the next two), the money-span inventory (every bank word is "…" in a span's stored text; each span keeps its sentence's `lines`). `amounts()`: `$`, `US$`, `USD 1,000`, `USD1,000`, `500.00 USD`; one the master can't hold ("$0.655") keeps `cents: null`, so it's swept and asked but confirms nothing. `centsOf` wraps `parseCents` (`@dct/shared`): a bracketed amount is negative, unless it restates words ("Three Thousand Dollars ($3,000.00)") |
| `src/binder.ts` | `bindEvidence` (each value to its spot: confirmed / conflict / ungrounded; unaccounted spans), `reviewFromEvidence` (the questions; a money term's `quoted` lines). Dates are read with `datesIn` from `@dct/shared` (`dates.ts`), the same reader answers are compared with. A single value is confirmed only when its line prints no other amount that could be it, else it's asked. A label matches a row only on a strict majority of its name's words. A conflict consumes nothing on its line or in its quote, so those amounts stay in the sweep; a limit on a fee's line ("up to 3 per subject") stays a term of its own. A rule's figure counts only from a sentence about its term (`ABOUT`). Two grids on one page each bind rows under their own header; one printed row confirms one grid's cells at most |
| `src/checks.ts` | `runContractChecks`: arithmetic and contract-defect checks, pure code. `GRID_CONFLICT` compares whole grids (`gridPrices`, a single cell included) |
| `src/score.ts` | Field-by-field scoring against `data/golden/*.json` |
| `src/fake.ts` · `fixtures/fake-extraction.json` | `EXTRACTION_FAKE=1`: a synthetic reading (the API uses its own fake, `apps/api/src/extraction/fake.ts`) |
| `scripts/` | `eval.ts` (live reads, **costs money**), `probe.ts` (live schema check, **costs a few cents**), `evidence.ts` (binds a saved read to the signed COPD original, no AI), `golden-grid-from-xlsx.py` (answer-key grid rows from a sponsor spreadsheet) |

## Commands

| Command | Does | Spends money |
|---|---|---|
| `pnpm --filter @dct/extraction test` | vitest; the AI is mocked, PDFs are synthetic | no |
| `pnpm --filter @dct/extraction typecheck` · `lint` | `tsc --noEmit`; ESLint, root `eslint.config.mjs` | no |
| `pnpm --filter @dct/extraction score [name]` | Scores saved reads in `data/extractions/` | no (reads `data/`) |
| `pnpm --filter @dct/extraction evidence` | Binds the saved COPD read to the signed original's text layer | no (reads `data/`) |
| `pnpm eval [name]` · `pnpm probe` | Live reads of the real contracts; live schema check | **yes: owner's approval first** |

The scripts load the repo-root `.env` and find `data/` two levels up, or under `DCT_ROOT` (set it when working in a git worktree, which has no `data/`). With `DCT_ROOT` set, three extra tests run against the real answer keys and the COPD original, without AI.

## Rules

- Only `src/llm.ts` builds a model client and calls a model, and only contracts go to it. (`src/model-schema.ts` imports the Anthropic SDK's schema helper, which makes no call.) `test/llm.test.ts` fails if `apps/*/src` or `packages/shared/src` imports an SDK.
- Every image sent to a model passes its page's bank mask (`masks` in `extract.ts`); every reply goes through `sanitize`/`scrub`. Add a new image path the same way. No error message, warning or log line quotes a model's reply.
- In a read, the abort signal and the spend cap are checked before every model call through the `capped` clients; don't add a call that bypasses them. (`identifyDocuments`, at most 3 pages per document on the fast model, isn't capped and its cost isn't recorded.) Each call's output is bounded by its kind (`CONFIG.maxOutputTokens`).
- Page and image limits are checked before anything is rendered or sent. Keep new work behind them.
- The text layer verifies; it is never given to the reader (ADR-001 §4). Two channels that can't see each other mean something when they agree.
- Text that no reader can see (`hidden`) is never evidence.
- No prompt or check may name a sponsor, CRO, drug, procedure or layout taken from a specific contract (ADR-001 §8).
- Never log or print contract text or amounts. The scripts print counts and scores only.
- `src/` loads no `.env`: the API process provides the environment.
- Changing an export means changing `ExtractionPort` in `apps/api/src/extraction/port.ts`. The API maps `ExtractionLimitError` and `RenderTimeoutError` to messages by class name (an upload whose page count times out is a 422), so keep those names and keep their messages plain English. A new `ReadWarning` kind fails the API's typecheck until `plainWarnings` words it.

## Pitfalls

- `mupdf-worker.mjs` is plain JavaScript on purpose: it runs as is under tsx, vitest and the API's bundle. It's found through this package's `exports` (`@dct/extraction/mupdf-worker`), because the bundle has no file beside it. Keep both.
- `fixtures/fake-extraction.json` is imported, not read from disk, for the same reason.
- Model ids and prices are in `src/llm.ts`. Defaults: `claude-sonnet-5-5` reads, `claude-haiku-5-5` sorts pages and identifies, Haiku re-reads terms (`CROSS_READ`). No Opus (cost decision, 2026-10-26).
- The 4 test contracts are image-only scans, while future contracts will be text PDFs (ADR-001 §1). A score on them says little about a new layout.
- The second read (`CROSS_READ`) and `LOW_CONFIDENCE` still run, but the API never asks about them: they are not evidence. ADR-001 plans to remove them.

## Testing

- `test/extract.test.ts` (pipeline with mocked clients, fake mode, the $20 cap, an aborted read), `test/evidence.test.ts` (text layer, inventory, binder, questions; mutation tests), `test/checks.test.ts`, `test/limits.test.ts` (render limits, the worker, bank masks and bank words in span text), `test/llm.test.ts` (reply parsing and retries, no reply text in errors, the abort signal; no model SDK outside this package), `test/prompts.test.ts` (AI schemas convert), `test/findings.test.ts` (review-finding regressions), `test/score.test.ts`.
- `test/helpers.ts` builds a small synthetic rulebook; the tests that need PDFs print synthetic ones themselves with mupdf (`mupdf.PDFDocument`), not pdf-lib. Never add a real contract to a test or fixture.
