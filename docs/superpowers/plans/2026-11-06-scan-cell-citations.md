# Scanned values cite cells: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to run this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scanned amount in the rulebook points at the exact transcribed cell it came from, and code proves it. Proof comes from arithmetic first, otherwise from one blind re-read of the page's tables compared cell by cell. Nothing in proof depends on positions.

**Architecture:** "The agent points, code copies, arithmetic and a blind table re-read prove."
- **Stable ids.** The transcription keeps its structure, and every cell and line gets a stable id.
- **What the compile agent sees.** It reads scanned tables as tables with ids and cites those ids. Code checks each value against its cell.
- **Fixed arithmetic relations** prove more values for free.
- **Blind re-read.** Pages with values still unproven get one blind re-read of their tables. A deterministic structural diff settles each cited cell. This replaces the crop re-look (`relook`) and `rereadScanGrids`.

**Tech stack:** TypeScript, zod 4, the existing `Reader` (OpenAI), vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-contract-harness-design.md`, §5.5 "On SCAN pages, values cite cells…" and §10 (2026-11-06 evening). The review behind this plan is at `/private/tmp/claude-501/-Users-prateekkumar/91296738-1214-41e1-95b8-a4bb8697a686/scratchpad/scan-review.md`, with its causes A–H. Implementers read §1, §3 and §5 of it.

## Global constraints

- **No paid model calls.** Tests use fake readers. The owner's spend cap has been reached.
- **Data and servers.** Never read `data/` or `.env`. Never open contract PDFs. Never touch ports 3100/4100, the `dct_finance` database or the Postgres container. API tests run against `_test`, one run at a time.
- **No contract overfitting.** Each change must hold for any contract: no rules keyed to a layout, sponsor, label or value.
- **Ids are derived, not stored by the model.** Cell and line ids come from the transcription's own structure, deterministically. Saved transcriptions keep working without being read again, so there is no `scanVersion` bump for ids.
- **Every proof is blind.** Nothing from the rulebook (values, quotes, row labels) goes into a verifying model's prompt. Page text appears in prompts only as data.
- **Marks.** A mark seen by **either** read sends the value to a person.
- **Money safety:** zero wrong values proven. When unsure, ask.
- **Comments and wording.** Comments explain a non-obvious why only. User-facing words are plain English for an accountant.
- **Commits.** Conventional Commits, no AI attribution. Commit at the end of each task (owner approved). Never commit the uncommitted spend-cap line in AGENTS.md.
- **Implementers run on Opus** (owner, 2026-11-06).

## Review focus

1. **The same row label twice.** The same procedure appears in two tables on one page, or twice in one table. The diff must align by order and structure, and must never confirm a value from the other row. Test in Task 4.
2. **A 22-visit grid split over two pages.** Each cited cell is checked on its own page and table. Tests in Tasks 2 and 4.
3. **Planted misreads in the first read never end up proven.** Mutation test in Task 6.
4. **A struck value and its handwritten replacement seen by only one read** goes to a person. Test in Task 4.
5. **A tight budget never silently skips the reviewer or the verify reads.** If the reviewer can't run, approval is blocked. Test in Task 5.

---

### Task 1: Cell ids and structured scan text (causes A, B)

**Files:**
- Modify: `packages/harness/src/scan/transcribe.ts`, `scan/index.ts`, `scan/words.ts`, `checks/quote.ts`, `checks/coverage.ts`
- Create: `packages/harness/src/scan/cells.ts`
- Test: `packages/harness/test/scan.test.ts`

**Interfaces (produces):**
```ts
// scan/cells.ts
export interface ScanCell { id: string; page: number; table: number | null; row: number | null; col: number | null; text: string; doubts: Doubt[]; heading?: string; rowLabel?: string }
export function cellsOf(page: number, t: Transcription): ScanCell[]
// ids: `p{page}.t{table}.r{row}.c{col}` for table cells (c0 = row label), `p{page}.t{table}.h{col}` for headings, `p{page}.l{line}` for lines
export function scanText(page: number, t: Transcription): string   // what the agent reads for a scan page
```

**What changes:**
- **Continuation rows are merged before ids are assigned.** A continuation row is a row with a label and only blank cells, which joins the row above.
- **`withScans` sets `page.raw` and `page.layout` from `scanText`**:
  - each table as `TABLE p7.t1 "title"`;
  - the headings row with column ids;
  - one line per row, starting with its row id, followed by `|`-separated cells, with blanks kept;
  - lines as `p7.l3 | text`;
  - doubts shown inline.
- **`toWords` stays only for display positions.**
- **Quote checks on scan pages run against `scanText`**, ignoring the ids.
- **Cause B is fixed:** `checkQuote` and `findQuote` now share one tolerant matcher, so a quote that passes is also found.

**Steps:**
- [ ] **Step 1: write the failing tests.**
  - `"a value printed under the 4th visit of a 20-visit scanned table reads under the 4th visit in the agent's text"`. Port the review's `scratchpad/review/layout.mts` case.
  - `"blank cells keep their column"`.
  - `"a wrapped row label joins the row above"`.
  - `"cell ids are the same every time a saved transcription is loaded"`.
  - `"a quote that passes the quote check is also found on the page"`.
- [ ] **Step 2:** run `pnpm --filter @dct/harness test scan`. Expect FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run `pnpm -r typecheck && pnpm lint && pnpm --filter @dct/harness test`. Expect PASS.
- [ ] **Step 5:** commit `feat(harness): scanned tables keep their cells, with ids, in what the agent reads`.

---

### Task 2: The agent cites cells, code checks them (causes C, D, E; fee vs fee-plus-overhead)

**Files:**
- Modify: `packages/shared/src/rulebook.ts`
- Modify: `packages/harness/src/agent/{normalize,session,prompt,tools}.ts`
- Create: `packages/harness/src/checks/cells.ts`
- Modify: `packages/harness/src/checks/index.ts`
- Tests: `test/agent.test.ts`, `test/checks.test.ts`, `packages/shared` tests

**Interfaces:**
- **Consumes:** `cellsOf` from Task 1.
- **Produces:**
```ts
// shared
Source.cell?: string                           // a cell or line id; required for a term with an amount on a scan page
GridRow.cells?: … / Grid.cellIds?: (string | null)[][]   // per row, per visit: the cited cell id, null for a blank cell (shape is the implementer's choice; one id per numeric value)
// harness checks/cells.ts
export function checkCitations(rulebook: Rulebook, docs: LoadedDoc[]): { problems: Problem[]; marked: { target: "term" | "grid"; id: string; path: string; cell: string; doubts: Doubt[] }[] }
```

**What changes:**
- On a scan page, every term amount and every numeric grid value must cite a cell. `parseCents(cell.text)` must equal the value.
- A mismatch, a missing citation or an unknown id comes back to the agent at once from `put_terms` / `put_grid`, in plain words.
- A cited cell with a mark is reported in `marked`, for Task 4 to send to a person.
- Multi-page grids cite cells on the page where each value is printed.
- The prompt tells the agent to cite, and to cite the column it means (e.g. the fee rather than the fee with overhead).
- Locked-field rules stay as they are. `cell` is not a locked field, but a person's answer re-points it only through an option the resolver writes.

**Steps:**
- [ ] **Step 1: write the failing tests.**
  - `"a scanned term whose value differs from its cited cell is refused at put_terms"`.
  - `"a scanned term must cite a cell"`.
  - `"a grid split over two pages cites each value on its own page"`.
  - `"a term may cite the fee column next to a fee-with-overhead column"`.
  - `"text-page terms need no citation"`.
- [ ] **Steps 2–4:** run, implement, then `pnpm -r typecheck && pnpm lint && pnpm test`.
- [ ] **Step 5:** commit `feat: scanned values cite the cell they were read from, and code checks them`.

---

### Task 3: More values proven by arithmetic (relations)

**Files:**
- Modify: `packages/shared/src/rulebook.ts` (adds `relations`)
- Create: `packages/harness/src/checks/relations.ts`
- Modify: `agent/{tools,prompt,normalize}.ts`, `checks/index.ts`
- Tests: `test/checks.test.ts`

**Interfaces:**
```ts
Relation = { kind: "sum" | "product" | "same"; result: string; operands: string[]; rate?: string }   // all cell ids; rate is a cited percent/count cell
export function checkRelations(rulebook, docs): { proven: Set<string /*cell id*/>; problems: Problem[] }
```

**What changes:**
- A relation holds when the transcribed values satisfy it. The tolerance is $0.50 for rounding, as in the grid check.
- A relation that holds proves every cell in it. Only cited printed cells and cited rates count, never typed numbers.
- `same` needs two **different** cells.
- Relations that fail are problems back to the agent, not proof.

**Steps:**
- [ ] **Step 1: write the failing tests.**
  - `"fee and fee-with-overhead cells are proven by a cited overhead rate"`.
  - `"unit × quantity = total proves all three"`.
  - `"a relation over a typed number proves nothing"`.
  - `"'same' over one cell twice proves nothing"`.
- [ ] **Steps 2–4:** run, implement, gate.
- [ ] **Step 5:** commit `feat(harness): arithmetic between cited cells proves scanned values`.

---

### Task 4: Blind table re-read and structural diff (replaces `relook` and `rereadScanGrids`)

**Files:**
- Create: `packages/harness/src/scan/verify.ts`, `scan/diff.ts`
- Rewrite: `resolve/scan.ts`
- Modify: `resolve/read.ts`, `resolve/index.ts`, `scan/transcribe.ts` (`pageParts` offset), `scan/store.ts` (verify cache)
- Test: `test/resolve.test.ts`, new `test/diff.test.ts`

**Interfaces:**
```ts
export async function verifyRead(reader: Reader, png: Buffer, tables: { ordinal: number; title: string }[], budget: Budget): Promise<Transcription>  // same compact form
export function diffReads(first: Transcription, second: Transcription): Map<string /*first-read cell id*/, { outcome: "agree" | "differ" | "marked" | "unaligned"; second?: string }>
```

**What changes:**
- **When to re-read.** A page gets one verify read only if it has cited values that arithmetic hasn't proven.
- **What the verify read sees.** The prompt asks to transcribe again the tables numbered N…, with titles stripped of amounts, plus every line containing an amount. It gets no labels and no values.
- **Images.** The verify read sees the whole page plus strips offset by half a strip, and the page is turned as the first read turned it. A second read that still reports a turn invalidates the page, and its values go to a person.
- **Caching.** The verify read is cached as `verify-1 <model>` in the scan store, so a re-run never pays twice.
- **How the diff aligns.**
  - Tables by ordinal and title.
  - Rows by sequence alignment on normalised labels: order settles repeats, and continuation rows are already merged.
  - Columns by heading sequence. Where headings can't be aligned, it compares per-row amounts *with counts*, and only to confirm, never to choose.
  - Lines by their amount and the words before it.
- **How each outcome settles a cited cell.**
  - `agree` → `two_reads`.
  - `differ` → if the second read's value makes every identity hold, it is proven by arithmetic; otherwise the cell goes to a person with both readings.
  - `marked` by either read → a person.
  - `unaligned` → a person.
- **Grouping questions.** Questions about one grid stay grouped as one question per grid, as today. The `person:` / `read:` ids stay compatible with the API's answer hook and `cellProofPatches`.
- **Deleted:** all coordinate crops in proof (`Spot.crop/zoom/header`, `lineBand`, `padOf`, `wordsIn`, `MAX_CROPS`, the scan branch of `imagesOf`), and `rereadScanGrids`.

**Steps:**
- [ ] **Step 1: write the failing tests**, with fake readers.
  - `"the same label in two tables on one page never confirms the other row's value"`.
  - `"a label repeated in one table aligns by order"`.
  - `"a wrapped label split differently by each read still aligns"`.
  - `"a 22-visit grid split over two pages is compared page by page"`.
  - `"column counts off by one fall back to amounts with counts and only confirm"`.
  - `"a value printed twice on a row is not double-counted"`.
  - `"a prose amount is compared by its line"`.
  - `"a struck value seen by one read only goes to a person"`.
  - `"a row label carrying instructions changes nothing"`.
  - `"the verify read is given no values or labels"` (assert on the prompt).
  - `"a verify read reporting a turn sends the page's values to a person"`.
  - `"a cached verify read is not paid again"`.
- [ ] **Steps 2–4:** run, implement, gate (`pnpm -r typecheck && pnpm lint && pnpm test && pnpm e2e`).
- [ ] **Step 5:** commit `feat(harness): prove scanned values by a blind re-read of the table, compared cell by cell`.

---

### Task 5: Coverage by cell, positions for display, budget safety (causes F, G, H)

**Files:**
- Modify: `packages/harness/src/checks/coverage.ts` (scan branch), `read.ts`, `review/index.ts`, `scan/index.ts`
- Modify: `apps/api/src/routes/versions.ts` (approve gate), only if a new blocking item needs it
- Tests: `test/coverage.test.ts`, `test/read.test.ts`, API tests

**What changes:**
- **Coverage on scan pages.** Every amount-shaped token in a cell or line, and every numeric cell in a money column, must be cited by id or accounted for. A match on another page no longer counts.
- **Display boxes.** Highlights on scan pages are the cited row's padded full-width band.
- **Budget.** `read()` reserves the reviewer's estimate and the verify reads before compile gets its share.
- **Skipped reviewer.** A reviewer that still can't run becomes a blocking item, "This read wasn't checked for judgment calls; start the read again". It can't be approved, and a re-run pays only for what's missing.
- **Resolution logging.** Log the effective dpi of each strip per page (count only), so the paid run shows whether tiny-print landscape pages need tiles.

**Steps:**
- [ ] **Step 1: write the failing tests.**
  - `"a bare 1,500 in a money column on a scan page must be accounted for"`.
  - `"a matching amount on another page doesn't account for this one"`.
  - `"a 22-page scan at the default budget always runs the reviewer and the verify reads"` (budget simulation with fake readers at measured prices).
  - `"a read whose reviewer couldn't run can't be approved"`.
- [ ] **Steps 2–4:** run, implement, gate.
- [ ] **Step 5:** commit `fix: scanned coverage by cell, and a read can't skip its reviewer`.

---

### Task 6: Free measurements (the gate before any paid run)

**Files:**
- Create: `packages/harness/scripts/scan-replay.ts` (prints counts only)
- Create: `packages/harness/test/mutation.test.ts`

**Steps:**
- [ ] **Step 1: mutation test.** On synthetic transcriptions, mutate read 1 only:
  - 3↔8 and 1↔7 glyph swaps
  - a value shifted one column
  - a dropped row and a duplicated row
  - a struck mark removed

  Assert **no mutated cited value ends up `two_reads` or `math`**. Then mutate read 2 only, and count the questions raised as the noise rate. The gate is 0 wrong values and fewer than 1 false question per page.
- [ ] **Step 2: same-model pair.** Run `diffReads` on the two cached GPT reads of one benchmark page:
  - `scratchpad/vision/f1p6-gpt.json` (old format, `{value: Transcription}`)
  - `f1p6-gpt-compact.json`

  Report agree/differ/unaligned counts. Run the `f1p6-claude.json` pairing too, as a cross-model comparison. The script reads only those cache files, by path given on the command line.
- [ ] **Step 3: offline HCWC replay (counts only, no model calls).** The script takes the cached transcription folder and an earlier rulebook as arguments, and reports how many cells:
  - link to exactly one transcribed cell, to two or more, or to none
  - map to the wrong page in a multi-page grid
  - hold an amount in a money column that coverage would miss

  The owner's controller runs this step on their machine; implementers test the script on synthetic input only.
- [ ] **Step 4:** commit `test(harness): measure scanned-value proof without spending`.

Then the controller reports the numbers to the owner. The owner decides the paid run (TGC, about $5.50–7).
