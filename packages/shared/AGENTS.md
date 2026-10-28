# packages/shared (`@dct/shared`)

The contract between the other three packages: zod schemas and their types for the rulebook, evidence and review questions, and every API body and response, plus the pure helpers that must give the same answer on the server and in the browser. Repo rules: [AGENTS.md](../../AGENTS.md).

It ships TypeScript source; there is no build. The web compiles it (`transpilePackages` in `apps/web/next.config.ts`), the API's tsup build inlines it, and the extraction package runs it under tsx and vitest.

## Key files

| File | What it holds |
|---|---|
| `src/rulebook.ts` | `Rulebook` (the invoicing master, `schemaVersion: 1`), `Provenance`, `DocumentKind`. Money is integer cents |
| `src/evidence.ts` | `ValueEvidence` (confirmed / attested / conflict / ungrounded), `ReviewItem`, the review bodies (`AnswerReviewBody`, `ReportValueBody`, `ProofreadBody`, `SendBackBody`, `ByHandBody`), `settled()`, `blankNumbers()` |
| `src/api.ts` | DTOs and bodies for `/api/v1`, `StudyStatus`, `VersionStatus`, `withheldPaths()`, and `RulebookVersionDto`, whose refine allows null only at withheld paths |
| `src/anomaly.ts` | `ContractAnomaly` and its codes, as the contract checks produce them |
| `src/search.ts` | List, count and search queries and pages, `searchMaster()`, `amountOf()` |
| `src/alerts.ts` | Alert kinds, `AlertDto`, `AlertListQuery`, `ReadAlertsBody` |
| `src/labels.ts` | `ENUM_LABELS` (plain words for enum values), `ACTION_LABELS` (what each audit action is called; the audit search matches these) |
| `src/xlsx.ts` | `buildWorkbook()`, the Excel export. A separate entry, `@dct/shared/xlsx`, so ExcelJS stays out of everything else |
| `src/index.ts` | Re-exports everything except `xlsx` |

## Commands

```sh
pnpm --filter @dct/shared test        # vitest: test/rulebook.test.ts, test/notes.test.ts
pnpm --filter @dct/shared typecheck   # tsc --noEmit
```

## Rules

- A change here is an API change. Change the API routes, the sample server (`apps/web/src/lib/mock/server.ts`) and the web in the same change, and keep `apps/web/src/lib/mock/server.test.ts` (every sample response parses with these schemas) green.
- This code runs in the browser. No `node:` imports or Node-only dependencies in `src/index.ts`'s graph. Keep heavy dependencies behind their own entry, as `xlsx` is.
- Rulebooks are stored as JSON on every version, and signed versions are never rewritten. A change that would make an old rulebook fail `Rulebook.parse` needs a new `schemaVersion` and a reader that converts the old one (ADR-001 §7). Adding an optional field doesn't.
- Money is integer cents in every schema. Never a float, never dollars.
- `withheldPaths()` and `blankNumbers()` are safety code for blind entry: the API and the sample server both rely on them. When unsure whether a number in a note could give a value away, blank it. Every change needs a case in `test/notes.test.ts`.
- Labels and messages here reach accountants. Plain English.
- A new audit action gets an entry in `ACTION_LABELS`, or the Activity page shows its raw code.

## Pitfalls

- The web's CSP forbids `eval`, so zod runs `jitless` there (`apps/web/src/instrumentation-client.ts`). Don't depend on zod features that need code generation.
- Structured outputs can't express records, so the extraction package's AI schemas reuse these pieces with grid `cells` as a list (`packages/extraction/src/prompts.ts`). A schema change can push the AI schema past the provider's limits; the extraction tests check the conversion, and `pnpm probe` checks it live (it costs money: ask first).
