# Scanned Pages Read by GPT: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scanned pages are read by one vision model (the OpenAI model) when a read starts. Claude writes the rulebook from those transcriptions. Any amount no arithmetic proves gets a zoomed re-look by the same model. Tesseract is gone.

**Architecture:** The OCR foundation (dffb5ab) already turns words from an image into a `Page` the agent, the checks and the reviewer read like a text page. This plan keeps that shape and swaps the source of the words:
- **Before:** tesseract running at upload.
- **After:** a GPT transcription made at read start, inside the read budget, and saved per file and page.
- **Resolver on scan pages:** one reader plus zoom, instead of the OCR match or two models.

**Tech Stack:** TypeScript, pdfjs-dist, @napi-rs/canvas, zod 4, the existing `Reader` (OpenAI Responses API), Fastify 5, Drizzle, Next.js 16, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-contract-harness-design.md`: §3 data handling, §5.1 "Scanned pages", §5.5 "On SCAN pages", §5.8 and §10 (2026-11-06).

## Global Constraints

- Only the OpenAI reader (`opts.openai`) ever sees a scanned page's image for transcription or re-look. Claude's `view_page` may still render scan pages (unmasked, owner decision 2026-11-06).
- Transcribed text is masked with the **text-page** bank rules before any model sees it. Scan pages have `maskBoxes: []`.
- Scanned pages add `SCAN_PAGE_USD = 0.40` to the budget for each page not yet transcribed. Each transcription call goes through the read's `Budget` (an estimate is held during the call, the actual cost is settled after).
- A page is paid for once. Each page is saved the moment its transcription returns, under a version string; a different version means transcribe again.
- Transcription effort is `"low"` (that is the benchmarked setting). Pages are rendered at 200 dpi, without the 2.5 MP cap `view_page` uses.
- No silent skip: a page whose transcription fails stops the read in plain English, naming the file and page. Pages already saved stay saved.
- Synthetic fixtures only. Never log contract text or model errors' messages (names only).
- Comments only for a non-obvious *why*. No comments that narrate code.
- No paid model calls in tests. All tests use fake readers.
- Conventional Commits, no AI attribution. Commit at each task's end only because the owner approved this plan.

## Review Focus

1. **Two transcribed lines at overlapping heights.** They must stay two lines, in reading order, and must not be merged into one garbled line by `groupLines`. Test in Task 1.
2. **Parallel page transcriptions saving to the same file's store.** Every page must survive. Test in Task 1.
3. **The budget runs out mid-scan.** Finished pages stay saved, the read fails naming how far it got, and a second read pays only for the rest. Test in Task 1.
4. **A struck-out printed amount with a handwritten replacement.** Neither is ever auto-proven, and the question carries the crop. Test in Task 2.
5. **Uploading a scanned file starts nothing and spends nothing.** Starting a read records the larger budget, and after the read the documents show scan pages with words. Test in Task 4.

---

### Task 1: Harness scan core (runs alone, first)

**Files:**
- Create: `packages/harness/src/scan/transcribe.ts` (moved from `src/vision/transcribe.ts`; drop `review()` and `REVIEW`), `src/scan/words.ts`, `src/scan/store.ts`, `src/scan/index.ts`
- Delete: `src/vision/` (compare.ts, settle.ts), `src/pdf/ocr.ts`, `scripts/ocr-bench.ts`, `test/ocr.test.ts`
- Modify: `src/types.ts`, `src/pdf/index.ts`, `src/pdf/page.ts`, `src/pdf/lines.ts` (remove every `ocr` branch: `OCR_BIC`, `couldBeNumber`, `ocrDigitCount`, `ocrLabelParts`, the fail-closed path), `src/read.ts`, `src/cli.ts`, `src/index.ts`
- Modify: `package.json` (remove `tesseract.js` and `@tesseract.js-data/eng`; `pnpm install`)
- Rename the `ocr` page kind to `scan` wherever the harness reads it (`checks/quote.ts`, `checks/coverage.ts`, `checks/index.ts`, `agent/*`, `review/index.ts`, `resolve/ocr.ts`). Keep this a mechanical rename; Tasks 2 and 3 change the behaviour.
- Test: `test/scan.test.ts`; update the fixtures in `test/words.ts` and other tests for the type changes.

**Interfaces (produces):**
```ts
// types.ts
export type PageKind = "text" | "scan" | "image";            // image = a scan not transcribed yet
export type Doubt = "unsure" | "handwritten" | "struck_out" | "initialed";
interface Word { text; x0; y0; x1; y1; doubt?: Doubt }        // `confidence` removed
interface Page { ...; rotation: number }                      // `confidence` removed
export interface ScanPage { page: number; version: string; rotation: number; words: Word[] }   // replaces OcrPage
export interface ScanStore { get(sha256: string): Promise<ScanPage[]>; put(sha256: string, page: ScanPage): Promise<void> }
// pdf
PdfReader.render(doc, page, opts?: { region?; dpi?; maxPixels?: number })   // maxPixels defaults to today's 2.5e6
// scan/words.ts
export function toWords(t: Transcription): Word[]
// scan/store.ts
export function fileScanStore(dir: string): ScanStore          // one `${sha256}.scan.json` per file, written atomically, puts serialised per sha
// scan/index.ts
export const SCAN_PAGE_USD = 0.4;
export function scanVersion(reader: Reader): string            // "transcribe-1 <model>"
export async function untranscribed(docs: LoadedDoc[], store: ScanStore, reader: Reader): Promise<number>   // pages still to pay for
export function withScans(doc: LoadedDoc, pages: ScanPage[]): LoadedDoc   // image pages become kind "scan"
export async function scanDocs(docs: LoadedDoc[], opts: { reader: Reader; store: ScanStore; budget: Budget; onProgress?: (line: string) => void }): Promise<LoadedDoc[]>
// read.ts
ReadOptions.scans?: ScanStore   // required when any doc has image pages; read() throws ReadFailed in plain English if it's missing
```

`toWords` rules:
- Every line and every table row keeps its reported `top`/`bottom`. Elements are taken in order of `top`. An element whose vertical centre falls within the previous element's band is moved just below it, so `groupLines` never merges two elements.
- Words get `x` from a fixed character width (`1/120` of the page) starting at `0.05`.
- In a table row, the label sits in slot 0 and cell `i` in slot `i + 1`, with slots of equal width. A blank cell yields no word, but its slot stays.
- A cell's or line's `unsure` sets `doubt: "unsure"` on its words, and its first mark (if any) overrides that.

`scanDocs`:
1. For each `image` page with no saved page of the current version, render it at 200 dpi and `transcribe` it. Run up to 4 pages at a time.
2. If the reported `rotation` is not 0, render the page turned by that rotation and transcribe it once more.
3. `put` the page as soon as it is read.
4. Emit progress like "Reading scanned pages: 3 of 17".
5. Each call's estimate assumes 8,000 output tokens. If the estimate doesn't fit the budget, stop: throw `ReadFailed("Stopped at the $X limit after reading N of M scanned pages. They're kept, so starting the read again continues from there.")`.

`read()`:
- Remove the refusal of `image` pages.
- Run `scanDocs` first, with the OpenAI reader.
- Compile then gets `COMPILE_SHARE` of whatever budget is left.
- The CLI uses `fileScanStore(resolve(base, "data/scans"))` and adds `SCAN_PAGE_USD × untranscribed` to its default budget.

`buildPage`: a `scan` page's words go through `maskBankDetails(lines)` (text rules) to mask the text, and the page gets `maskBoxes: []`.

- [ ] **Step 1: Write the failing tests** in `test/scan.test.ts`, with a fake `Reader` that returns a fixed `Transcription` and counts calls:
  - `toWords keeps a table row on one line in column order`: `rawLine` of the row's line equals `"Visit 1 $1,200.00 $300.00"`, and a blank middle cell leaves the third value in slot 3.
  - `toWords keeps two lines with the same band as two lines in order`: both report `top 0.40, bottom 0.42`; `groupLines(toWords(t))` has length 2, and the first raw line is the first transcribed line.
  - `toWords marks doubtful words`: an `unsure` cell gives `doubt: "unsure"`; a line marked `handwritten` gives `doubt: "handwritten"`.
  - `scanDocs transcribes an image page once`: the first run makes 1 call and the page kind becomes `"scan"`; a second run with the same store makes 0 calls.
  - `scanDocs turns a sideways page`: the fake reports `rotation: 90` first, then `0`. That makes 2 calls, and `page.rotation === 90`.
  - `scanDocs keeps finished pages when the budget runs out`: the budget allows only 1 of 3 pages. It throws `ReadFailed` with a message containing `"1 of 3"`, the store holds 1 page, and a rerun with a larger budget makes 2 calls.
  - `scanDocs stops on a failed page`: the fake throws for page 2. The `ReadFailed` message names the file and `p.2`, and page 1 is saved.
  - `fileScanStore keeps every page under parallel puts`: 10 concurrent `put`s, then `get` returns 10 pages.
  - `a scan page masks bank numbers in text and paints nothing`: a transcribed line `"Account number 123456789"` gives words containing `"#########"`, and `maskBoxes` is `[]`.
- [ ] **Step 2:** Run `pnpm --filter @dct/harness test scan`. Expected: FAIL (the module is missing).
- [ ] **Step 3:** Implement the interfaces above. Delete the OCR files and dependencies. Rename `ocr` to `scan`.
- [ ] **Step 4:** Run `pnpm --filter @dct/harness typecheck && pnpm --filter @dct/harness test`. Expected: PASS. Then run `pnpm --filter @dct/harness vision-bench --dry --out <scratch> "<any text pdf>:1"`. Expected: it prints an estimate and spends nothing (the script is trimmed in Task 6; here it only has to compile).
- [ ] **Step 5:** `git commit -m "feat(harness): scanned pages are transcribed by the vision model when a read starts"`

---

### Task 2: Resolver on scan pages (after Task 1; parallel with 3, 4 and 5)

**Files:**
- Rename and rewrite `packages/harness/src/resolve/ocr.ts` to `src/resolve/scan.ts`.
- Modify `src/resolve/read.ts`, `src/resolve/index.ts`, `src/checks/index.ts` and `packages/shared/src/rulebook.ts` (remove `ocr_match` from `Evidence`; the dev DB holds 0 rulebooks that use it, checked 2026-11-06).
- Test: `packages/harness/test/resolve.test.ts`.

**Interfaces:**
- **Consumes:** `Word.doubt`, `PageKind "scan"`, `askPages`, `proven`, `tryApply`, `gridJob`.
- **Produces:** `export async function relook(run: Run, report: CheckReport): Promise<void>`, which replaces `reconcile`.
- `OCR_PAGE_REASON` becomes `SCAN_PAGE_REASON = "scanned page: this amount needs the contract's arithmetic or a closer second read"`.

**`relook`** works over the same spots `spotsOf` finds today:
1. A spot whose words carry a mark (`handwritten`, `struck_out` or `initialed`) raises a `reading` question with no model call. It carries the crop, the context "p.N shows this value <handwritten / struck out / initialed>", and the option "Use <value>". `NEITHER` is appended as usual.
2. Other spots are grouped by crop. Each group is read by `askPages(run, [run.openai], …)`, which is not shown the value. A reading that matches gets `proven(..., "two_reads")`. A reading that differs raises a `reading` question with the crop. Its `readings` are `[{model: "<openai> (whole page)", answer: current}, {model: "<openai> (zoomed)", answer: read}]`, and it has options to use either reading.
3. Delete the OCR-match half.

**`readJobs`:** skip terms and grids whose pages are `scan`, because `relook` has handled them. The exception is a scan grid whose arithmetic **fails**. That goes to `rereadScanGrid`:
- One `askPages(run, [run.openai], …)` over `gridJob(g).items` at 300 dpi.
- If `tryApply` with the read values passes the checks, the values are kept (the arithmetic is the proof) and the log says "p.N: a closer read corrected K values and the totals now add up ✓".
- Otherwise it raises the same question shape as today's "differ" branch, with the readings labelled whole page vs zoomed.

Text pages keep the Claude + OpenAI two reads unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `a matching zoomed re-look proves a scanned amount`: the fake OpenAI reads `"$1,200.00"`, and the fake Claude throws if it is called. The term gets `evidence: "two_reads"` and no question is raised.
  - `a differing re-look asks with both readings and the crop`: the question has `kind: "reading"`, two readings, and `source.region` set.
  - `a struck-out amount and its handwritten replacement are both asked, with no model call`: the call count is 0 and there are 2 questions.
  - `a scanned grid whose totals fail is fixed by a closer read when the totals then hold`: the cell is patched and there is no question.
  - `a scanned grid still failing after the closer read is asked`.
  - All existing text-page resolve tests still pass.
- [ ] **Step 2:** Run `pnpm --filter @dct/harness test resolve`. Expected: FAIL.
- [ ] **Step 3:** Implement. Remove `ocr_match` from `Evidence`, `PROVEN` and `proven()`'s parameter type.
- [ ] **Step 4:** Run `pnpm --filter @dct/harness typecheck && pnpm --filter @dct/harness test && pnpm --filter @dct/shared test`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "feat(harness): amounts on scans are proven by arithmetic or a zoomed second read"`

---

### Task 3: What the agent, the reviewer and coverage see (after Task 1; parallel)

**Files:**
- Modify `packages/harness/src/agent/compile.ts`, `agent/session.ts`, `agent/prompt.ts`, `review/index.ts` and `checks/coverage.ts`.
- Rename `ocr*` helpers in `checks/text.ts` to `loose*`.
- Tests: `test/agent.test.ts`, `test/review.test.ts`, `test/coverage.test.ts`.

**Interfaces:**
- **Produces:** `CoverageAmount.doubt: Doubt | null`, which replaces `confidence`. The web (Task 5) reads it.

**Behaviour:**
- `KIND_NOTE.scan` and `OCR_NOTE` become `SCAN_NOTE`: "SCAN: text read from the page image by a vision model; amounts here are re-checked at zoom after you finish. Quote the words as transcribed."
- For a scan page, `read_pages` appends a line listing the page's doubtful words, for example `Doubtful on this page: "$1,250.00" (unsure); "$900.00" (handwritten)`, or nothing when there are none.
- The reviewer's heading for a scan page says the text was transcribed from the image, which is attached.
- The prompt line about OCR misreads is replaced by "On a SCAN page quote the transcribed words."

- [ ] **Step 1: Write the failing tests:**
  - `read_pages lists doubtful words on a scan page`.
  - `read_pages adds no doubt line when there are none`.
  - `a coverage amount on an unsure word has doubt "unsure"`.
  - `the reviewer gets the image and the transcription for a scan page`.
- [ ] **Step 2:** Run `pnpm --filter @dct/harness test agent review coverage`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @dct/harness typecheck && pnpm --filter @dct/harness test`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "feat(harness): the agent and reviewer see transcribed scans and their doubtful words"`

---

### Task 4: API (after Task 1; parallel)

**Files:**
- Delete `apps/api/src/jobs/ocr.ts` and `test/ocr.test.ts`.
- Modify `src/app.ts` (remove `ocr` from `Ctx` and `buildApp`), `src/db/schema.ts` (drop `ocrStatus`, `ocrPagesDone`, `ocrError` and the enum; `PageInfo.kind` becomes `"text" | "scan" | "image"`; drop `confidence`), `src/lib/storage.ts` (the OCR file functions are replaced by `scanStore = fileScanStore(config.uploadDir)`), `src/lib/docs.ts` (`loadStored` applies `withScans`), `src/jobs/read.ts`, `src/routes/reads.ts`, `src/routes/studies.ts`, `scripts/e2e-seed.ts`, `test/global-setup.ts`, `test/helpers.ts`, `vitest.config.ts` and `package.json` (remove the tesseract dependencies).
- Generate the migration with `pnpm --filter @dct/api db:generate`, then run `db:check`.
- Tests: `test/reads.test.ts`, `test/studies.test.ts` and `test/migrations.test.ts`.

**Behaviour:**
- **Upload:** queues nothing. The study's `documents[].scannedPages` lists the non-text pages. `lowConfidencePages` and `ocr` are removed from the response.
- **Start read:** remove the OCR gates. `budgetUsd = config.readBudgetUsd + SCAN_PAGE_USD × untranscribed(docs, scanStore, openai)`, rounded to cents. It is recorded on the read row as today.
- **Read job:**
  - Remove the refusal of `image` pages.
  - Pass `scans: scanStore` to `read()`.
  - Afterwards (success or failure), for each document that had `image` pages: call `forgetStored(sha)`, reload it, and update `documents.pages` with `pageInfos`.

- [ ] **Step 1: Write the failing tests:**
  - `uploading a scanned PDF queues nothing and lists its scanned pages`.
  - `starting a read on a 2-page scan records budget 3 + 0.80`.
  - `after a read, the scanned pages show as scan with words`: the fake `openai` reader returns a transcription, and the `/pages` or contract endpoint returns words for the page.
  - `a second read of the same file adds nothing to the budget`.
  - The migrations test passes with 0006.
- [ ] **Step 2:** Run `pnpm --filter @dct/api test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Regenerate the migration; never edit 0005.
- [ ] **Step 4:** Run `pnpm --filter @dct/api typecheck && pnpm --filter @dct/api test`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "feat(api): scans are read when a read starts, within its budget; the OCR job is removed"`
- [ ] **Step 6: Do not migrate the dev database.** The principal engineer asks the owner before running `db:migrate` on `dct_finance`. The migration drops three OCR columns, and the dev API logs that it is behind until then.

---

### Task 5: Web (after Task 1; parallel)

**Files:**
- Modify `apps/web/src/lib/types.ts`, `components/study/Documents.tsx`, `NextStep.tsx`, `StudyHub.tsx` and `format.ts` (remove `isPreparing`), `components/proof/ContractTab.tsx`, `RulebookTab.tsx` and `model.ts`, and `components/rulebook/terms.ts`.
- Tests: `components/study/StudyHub.test.tsx`, `test-helpers.tsx` and `components/proof/proof.test.tsx`.
- Read `apps/web/node_modules/next/dist/docs/` before writing web code.

**Behaviour:**
- Remove the OCR progress and failure states.
- A document with scanned pages reads: "Scanned pages 3–7 are read from the image when the read starts (about $0.40 a page, the first time only)."
- The page badge reads "Scanned page, read from the image".
- A coverage amount with a `doubt` shows a pill: "unsure", "handwritten", "struck out" or "initialed".
- `ocr_match` is removed from the evidence tones and labels.

- [ ] **Step 1: Update or write the failing tests** for each of the four visible states above.
- [ ] **Step 2:** Run `pnpm --filter @dct/web test`. Expected: FAIL.
- [ ] **Step 3:** Implement, keeping the current design language.
- [ ] **Step 4:** Run `pnpm --filter @dct/web typecheck && pnpm --filter @dct/web test`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "feat(web): scanned pages are read from the image; doubtful amounts are marked"`

---

### Task 6: Benchmark, docs and the full gate (last)

**Files:**
- Modify `packages/harness/scripts/vision-bench.ts`:
  - It uses one reader (OpenAI).
  - Its score goes through `toWords` and then `groupLines` and `amountsIn` per line, so it also measures `toWords`.
  - Pages whose answer key holds no `$` amounts are skipped.
  - The cache and the cap stay.
- Modify `AGENTS.md`: the masking line becomes "scanned page images go to the OpenAI model unmasked for now (owner, 2026-11-06); their transcribed text is masked like text pages". Remove the tesseract mention.

- [ ] **Step 1:** Run `pnpm --filter @dct/harness vision-bench --out <scratch>/vision "<EFC WO>:6,7,8" "<MK-1406>:24"` **against the cached results only**. Use the earlier run's cache, `/private/tmp/claude-501/-Users-prateekkumar/91296738-1214-41e1-95b8-a4bb8697a686/scratchpad/vision`. It must print 273 of 273 right, as GPT alone scored before, and "spent this run: $0.00". A lower score means `toWords` lost or misplaced amounts; fix that before going on. If any call isn't cached, stop and ask the owner; no paid run.
- [ ] **Step 2:** Run `pnpm -r typecheck && pnpm lint && pnpm test && pnpm e2e`. Expected: all green, each listed in the report.
- [ ] **Step 3:** `git commit -m "chore: benchmark scans with one reader; AGENTS.md on unmasked scans"`

**Not in this plan (it needs paid runs; the owner approves each):**
- A real read of TGC (22 scanned pages, about $5–7 the first time).
- A real read of HCWC (17 pages with 6 sideways, about $4–6).
