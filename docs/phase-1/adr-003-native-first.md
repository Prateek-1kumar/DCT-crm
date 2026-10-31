# ADR-003: Native first, show our reading, ask only what the contract can't settle

**Status:** Accepted by the owner (Prateek), 2026-11-01. Built in the stages of §4: **C1, C2 and C3 built** (2026-11-01; C3 removed the row bands, and leaves the token map to P4, where the vision grid read it belongs to goes); the rest not yet, and until a stage lands the code enforces what it enforces today. **Supersedes:** ADR-001 §6's blind sample and blind entry (I6's "picked blind"), and ADR-002 §4's floor "the blind sample of 10 stays".

## 1. What we measured (2026-11-01, no AI spend)

- **The AI's reading is not the problem.** The saved reads of the four contracts score 96–100% against the answer keys; the scan gate (`ocr-eval`) finds 0 values the AI got wrong and 0 wrong values confirmed. A read costs $0.45–$3.84.
- **The questions are the problem.** Per contract: COPD 46, Shah 43, HCWC 146, McAllen 148. At about two minutes each that is up to five hours of an accountant's time, against a read that was already right.
- **We read pictures of files that held exact text.** All four contracts in `data/contracts` were made with "Microsoft: Print To PDF": no text layer. COPD's signed DocuSign original (full text) and the sponsor's budget spreadsheet sit beside it unused. The upload accepts PDFs only and says nothing about a printed copy.
- **On the native file, plain code reads the grid exactly.** Words and their positions from the text layer, put in columns by position: 68 of 68 grid rows, 593 of 593 cells. No OCR, no AI, $0.
- **The strongest check never runs.** Row identities (`solver.ts`) were checked on 0 rows on every contract. Rows are built only inside tables drawn with vector lines, which a scan doesn't have, and a quantity column that counts *units* (a cell worth 3 × the unit) is not recognised. COPD's quantity column counts units on 68 of 68 rows.
- **One safety hole:** on Shah, 3 of 7 planted column shifts stay confirmed.

## 2. Decisions (owner, 2026-11-01)

1. **Native first.** A contract with no text layer is a printed copy or a scan: the app says so in plain words and asks for the signed original or the sponsor's budget spreadsheet. If there isn't one, the scan is still read (our own OCR, the contract's arithmetic as referee). No new vendor.
2. **No blind sample.** The accountant rechecks the whole rulebook before approval; sampling values the page already confirms adds questions, not safety. The by-hand re-type sample (`spot_check`) goes with it: maker-checker still keeps whoever typed a value from approving it.
3. **Show our reading.** A question shows what we found, where, and what we recommend; the accountant accepts it or corrects it. Values are no longer withheld from the screens, versions, search, diff or audit. A suggested pick is marked "Our reading" but never pre-picked, so a key press alone confirms nothing (a table's columns above all); typing a value other than the PDF's own text still asks once more, with a reason.
4. **The goal:** as few questions as possible, and **no billable term missed**. A question exists only where the contract itself can't settle the answer: its text and its arithmetic disagree, it is silent, or its wording genuinely reads two ways.

**Unchanged:** every value still carries evidence (`confirmed`, `confirmed_by_math`, `attested`, `conflict`, `ungrounded`) and sign-off still refuses anything not confirmed or attested; every question must be settled; maker-checker; approved versions immutable; append-only audit; integer cents; the sweep for money terms the master can't hold; no AI spend without the owner's approval; nothing from `data/` committed or logged.

## 3. The pipeline we are moving to

1. **Intake.** Sort each upload: spreadsheet, native PDF, or printed/scanned PDF. A printed copy gets a plain-English request for the original; the accountant can go ahead anyway.
2. **Grids are read by code, not by the model.** From the text layer (native) or our OCR's words (scan): words, positions and the table's ruled lines give rows and visit columns. Every number is the page's own text.
3. **Arithmetic is the referee.** Row (quantity × unit, including quantities that count units), visit subtotal, overhead, visit total, per-patient total. A grid whose every identity balances asks nothing.
4. **The model reads meaning, not digits.** Payment terms, caps, screen-fail rules, holdbacks: quoted from the page and bound to its text. On a native PDF the vision read of grids is retired.
5. **Nothing billable is missed.** Every money amount on every financial page is either in the rulebook or listed for the accountant (`UNACCOUNTED_TERM`, bill by hand).
6. **Questions show our reading and a recommendation**, grouped on one screen, each at its spot on the page.

## 4. Stages

| Stage | What | Done when |
|---|---|---|
| C1 | Remove the blind sample and the by-hand re-type sample | all suites and `pnpm e2e` green |
| C2 | Show our reading: remove withholding; each question shows our reading and recommendation; accept or correct | same |
| C3 | Remove questions with one possible answer (they become notices), and the off-by-default experiments superseded by §3 (row bands, token map) | same |
| P1 | Intake: detect printed copies, ask for the original; accept the budget spreadsheet beside the contract | same, plus a printed copy is detected on all four test contracts |
| P2 | Grid reader by code on native PDFs; unit-counting quantity identity | COPD native: every grid cell confirmed with 0 questions about grid values, offline |
| P3 | The same reader on OCR words for scans; the OCR returns the ruled lines it already finds | scan gate: 0 wrong confirmed, every planted error caught (including Shah's column shifts), questions per contract down |
| P4 | Retire what P2–P3 make dead: held tables and their column picks, blank-cell picks, the vision grid read | same |

Each stage is measured with the offline commands (`pnpm --filter @dct/extraction score`, `pnpm --filter @dct/api ocr-eval`) before and after. A live read costs money and needs the owner's approval each time.
