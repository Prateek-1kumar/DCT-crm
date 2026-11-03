# packages/shared (`@dct/shared`)

The contract between the other three packages: zod schemas and their types for the rulebook, evidence and review questions, and every API body and response, plus the pure helpers that must give the same answer on the server and in the browser. Repo rules: [AGENTS.md](../../AGENTS.md).

It ships TypeScript source; there is no build. The web compiles it (`transpilePackages` in `apps/web/next.config.ts`), the API's tsup build inlines it, and the extraction package runs it under tsx and vitest.

## Key files

| File | What it holds |
|---|---|
| `src/answer.ts` | The rules a write applies (the API's, and the web's where a screen shows one); a refusal is a value (`{ refusal: { status, message } }`), never thrown. `answerQuestion` (check, write, log an answer), `followUps` (what an answer asks next: `recheck`, `gridConflicts`, `capFollowUps`; logs `review.reopened` / `review.closed`), `typingDone`, `signOffRefusal` (the gate, also used by the approve page), `versionDiff`, `calendarDay`, `suggest` (what we suggest for an open question; a date tied to the last signature: the record's date, `ReviewItem.signedOn`) |
| `src/problems.ts` | Contract problems as questions: `notices` (what asks nothing: `isNotice` findings, and, given the version's questions and evidence, rounding the contract is silent on, `ROUNDING_NOTICE`), `fromAnomalies` (one per finding, held back while its numbers are asked; a total's `asPrinted`), `recheck` (a grid's totals on the typed numbers; a settled total whose answer no longer holds is asked again), `gridConflicts` (an arm an answer made differ), `sumAt`, `ARITHMETIC` |
| `src/rulebook.ts` | `Rulebook` (the invoicing master, `schemaVersion: 1`), `Provenance`, `DocumentKind`, `Unclassified` (the bill-by-hand list). Money is integer cents. `upgradeRulebook` (a stored rulebook from before `governingGridIds` / `unclassified`, read with them empty); `appliesFromOf`; per-arm grids: `armKey`, `governingGrids`, `gridPrices` (what a grid bills), `billedGrids` (identical grids bill one, differing ones none until chosen), `gridChoice` |
| `src/evidence.ts` | `ValueEvidence` (confirmed / confirmed_by_math / attested / conflict / ungrounded; `checkedByMachine` = the first two), `ReviewItem` (with `quoted`, `asPrinted`, `cites`: the quote and page a question shows, `signedOn`: an e-signature record's date we suggest), `Person` and `samePerson` (ignoring case and edge spaces), the review bodies (`AnswerReviewBody`, `ReportValueBody`, `ProofreadBody`, `SendBackBody`, `ByHandBody`) and their 400s (`BODY_WORDS`, `bodyProblem`), `settled()`, `openItems()` (Needs you), `proofreadMarks` |
| `src/questions.ts` | The review lists: `interpretations` (picks, the start date; only for genuine ambiguity or silence: `opts.evidence` lets a clause that states its figure outright and is confirmed from the page go unasked, ADR-002 §4; `opts.printed` and `triggerOf` let a site fee's trigger printed beside its confirmed amount go unasked, ADR-003; `opts.roundingSaid` false and no quote: rounding isn't asked, owner 2026-11-02; each question with a quote `cites` it), `cards` / `openCards` (questions citing the identical quote on the same page are one card, and a money term's question joins its identical sentence's card in any document; needs you counts cards), `SIGNED_DATE_DIFFERS` (the effective date held against the last signature's: a pick of either date writes it, `optionValue` in `answer.ts`), `amendmentDate`, `decidedBy` (what an open question decides), `capFollowUps`, `noLimit` / `noLimitTyped` ("No limit" refuses a figure); one-value questions (`askAbout`, `dateField`); `cryptoRandom`; typing by hand (`placeholders`: defaults nobody chose); the table check (`tableQuestions`, `settleTable`, `rejectTable`, `tableSendBackRefusal`); the blank check (`blankQuestions`, `rejectBlank`; answered in `answer.ts` by `answerBlank`) |
| `src/money.ts` · `dates.ts` | `parseCents` (brackets are a credit unless `restates`; null past two decimals), `parsePercent`; `datesIn` (the binder reads a page's dates with it), `isoDate` (a printed date as one ISO date, for comparing an answer) |
| `src/diff.ts` · `pointer.ts` | `diffRulebooks`, `labelFor`, `itemIds`, `deepEqual`; JSON pointers (`at` is the only one the index exports) |
| `src/api.ts` | DTOs and bodies for `/api/v1`, `StudyStatus`, `VersionStatus`, `openPaths()` (values with an open question), and `RulebookVersionDto`, whose rulebook must parse |
| `src/anomaly.ts` | `ContractAnomaly` and its codes, as the contract checks produce them |
| `src/search.ts` | List, count and search queries and pages, `searchMaster()`, `searchVersion()`, `amountOf()` |
| `src/alerts.ts` | Alert kinds, `AlertDto`, `AlertListQuery`, `ReadAlertsBody` |
| `src/labels.ts` | `ENUM_LABELS` (plain words for enum values), `ACTION_LABELS` (what each audit action is called; the audit search matches these) |
| `src/budgetsheet.ts` | The sponsor's budget spreadsheet checked against the grids read from the signed contract (ADR-003 P2): `budgetCheck` (pure; the sheet whose header row names a grid's visits; rows by code in order, else name; unit price, every visit cell, visit totals; a row on one side only is a difference; the grid the sheet agrees with most), `budgetCheckWords` (the notice), `noBudgetWords`, `BUDGET_CHECK` |
| `src/xlsx.ts` | `readSheets()` (an .xlsx's cells as values, a formula's computed result), `buildWorkbook()`, the Excel export (Summary, Budget grid, Fees & invoiceables, Payment terms, Bill by hand). A separate entry, `@dct/shared/xlsx`, so ExcelJS stays out of everything else |
| `src/index.ts` | Re-exports everything except `xlsx` (and of `pointer.ts`, only `at`) |

## Commands

```sh
pnpm --filter @dct/shared test        # vitest: rulebook, billing (old rulebooks, per-arm grids, Excel), questions, answer (answerQuestion, followUps, signOffRefusal, diff, dates), findings (one regression per review finding), review-rules (one-value questions, `noLimitTyped`, `appliesFromOf`)
pnpm --filter @dct/shared typecheck   # tsc --noEmit
pnpm --filter @dct/shared lint        # ESLint, root eslint.config.mjs
```

## Rules

- A change here is an API change. Change the API routes and the web in the same change, and keep the web's test fixtures (`apps/web/src/test/fixtures.ts`, parsed with these schemas) green.
- This code runs in the browser. No `node:` imports or Node-only dependencies in `src/index.ts`'s graph. Keep heavy dependencies behind their own entry, as `xlsx` is.
- Rulebooks are stored as JSON on every version, and signed versions are never rewritten. A change that would make an old rulebook fail `Rulebook.parse` needs a new `schemaVersion` and a reader that converts the old one (ADR-001 §7). Adding an optional field doesn't.
- Money is integer cents in every schema. Never a float, never dollars.
- `answer.ts` (with `suggest`), `problems.ts`, `questions.ts`, `money.ts` and `openPaths()` are the money rules, what we suggest and the gate: the API runs them (and the web, where a screen shows one), so a change here changes both. Every change needs a test in `test/` that fails without it.
- Labels and messages here reach accountants. Plain English.
- A new audit action gets an entry in `ACTION_LABELS`, or the Activity page shows its raw code.

## Pitfalls

- The web's CSP forbids `eval`, so zod runs `jitless` there (`apps/web/src/instrumentation-client.ts`). Don't depend on zod features that need code generation.
- Structured outputs can't express records, so the extraction package's AI schemas reuse these pieces with grid `cells` as a list (`packages/extraction/src/prompts.ts`). A schema change can push the AI schema past the provider's limits; the extraction tests check the conversion, and `pnpm probe` checks it live (it costs money: ask first).
