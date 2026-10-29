# AGENTS.md

DCT Finance turns signed clinical-trial sponsor contracts into an approved invoicing master (in code: the rulebook): every fee, cap and due day with its page reference. Users are non-technical accountants. The rule behind every design choice is **no silent errors**: a wrong number that gets approved costs the client real money.

Start with [docs/architecture.md](docs/architecture.md). Each package has its own `AGENTS.md`: [apps/api](apps/api/AGENTS.md), [apps/web](apps/web/AGENTS.md), [packages/shared](packages/shared/AGENTS.md), [packages/extraction](packages/extraction/AGENTS.md). Docs index: [docs/README.md](docs/README.md).

## Non-negotiables

- Never commit, paste or log anything from `data/` (real contracts, answer keys, uploads) or `.env`. Tests and fixtures use synthetic PDFs only.
- Patient data never goes to the AI. Only contracts do, and only through `packages/extraction/src/llm.ts`.
- Never run anything that spends AI money without the owner's explicit approval: `pnpm eval`, `pnpm probe`, a real read (`pnpm dev` or `dev:api` with real keys, then reading a contract), or any script that builds a client from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Use `pnpm dev:fake` or `EXTRACTION_FAKE=1`.
- Never stop the owner's dev servers (web 3100, API 4100) or their Postgres container. Use other ports, and never point a second API at the dev database `dct_finance`: its workers would take the owner's jobs (and complete a real read with a fake one under `EXTRACTION_FAKE=1`).
- Never discard uncommitted changes you didn't make (`git checkout -- .`, `git reset --hard`, `git clean`, `git stash` of others' work).
- Never weaken a money invariant below to make a test or a screen pass. If one is in the way, stop and ask.

## Money invariants

ADR-001 ([docs/phase-1/adr-001-extraction-evidence.md](docs/phase-1/adr-001-extraction-evidence.md)): a value is unconfirmed until the PDF's own text or a person confirms it, and the API, not the UI, refuses approval otherwise.

| Rule | Enforced in |
|---|---|
| Every money value has evidence: `confirmed` (PDF text at its spot agrees; on scans, the contract's own totals agree to the cent), `attested` (a person typed or chose it blind), `conflict` or `ungrounded` | `ValueEvidence` in `packages/shared/src/evidence.ts`; set by `bindEvidence` (`packages/extraction/src/binder.ts`) and `reviewDraft` (`apps/api/src/review.ts`); an answer marks it `attested` in `answerQuestion` (`packages/shared/src/answer.ts`) |
| Whatever isn't confirmed becomes a question. A blocker clears only by a typed value or a pick (I6); a Review question also by a fixed reason with a note; never free text alone. A total whose parts change, or an arm whose grids an answer makes differ, is asked (again) | `reviewFromEvidence` (binder.ts); `fromAnomalies`, `recheck`, `gridConflicts` (`packages/shared/src/problems.ts`); answering is `answerQuestion`, what it asks next `followUps` (`answer.ts`) |
| The review lists (ADR §6): interpretations picked blind; a blind sample of 10 confirmed values per read (shown at its page only, never compared: a first answer that differs is typed again, and that answer is final); money terms the master can't hold listed to bill by hand (`unclassified`) | `interpretations`, `pickSample`, `askAbout` in `packages/shared/src/questions.ts`; `reviewDraft`; `answerQuestion` |
| Sign-off gate, in this order: a draft; unchanged since the approver saw it (`asOf`); by-hand typing marked done; **every** question settled; every arm with grids bills one; every evidence entry `confirmed` or `attested`; after a sample miss, every value of that family proofread or typed; maker-checker | `signOffRefusal` in `packages/shared/src/answer.ts`: the sign-off route refuses with it (409) and the approve page explains with it |
| Blind entry: a value with an open question never leaves the server, nor what it decides (`alsoWithheld`: a cap's limit and ratio while its kind is asked, every visit's `autopay` and row's `overheadApplied` while visit payment or overhead scope is asked, the amendments' own dates while the start date is). Masked in versions, search, diff, audit, alerts; its evidence goes out without its printed text and at its page only; numbers blanked in its item's words, in notes about it, and in a money term quoted from any line of its sentence | `withheldPaths` (`packages/shared/src/api.ts`) → `versionDto` (`apps/api/src/domain.ts`) → `mask`, `blindEvidence`, `blindReview`, `blindDetail`, `quotesWithheld` (the question's `quoted` lines) in `packages/shared/src/blind.ts`; `blankNumbers` (`evidence.ts`); `searchVersion` (`search.ts`), `versionDiff` (`answer.ts`) |
| Maker-checker, on by default (a database already in use keeps its setting): nobody in `editors` may approve; names compared trimmed, ignoring case (`samePerson`). A re-typer whose answer changes a value becomes an editor. A hand-typed value is re-typed by someone else | `signOffRefusal`; `answerQuestion` (409 for the typist) |
| Approved is immutable; the old live version is superseded in the same transaction | each version write route (409 unless a draft; proofreading aside); triggers in `apps/api/drizzle/0006_signed_versions_locked.sql` and, for TRUNCATE, `0011_truncate_guards.sql` |
| The audit log is append-only and written in the same transaction as the change | triggers in `0001_guards.sql` and `0011_truncate_guards.sql`; `audit()` in `domain.ts` |
| Money is integer cents everywhere, and every amount or percentage is read one way, never by float math | `parseCents`, `parsePercent` in `packages/shared/src/money.ts` (the binder's `centsOf`, search and the web's `parseDollars` wrap it); the schemas in `rulebook.ts` |

The in-browser sample server (`apps/web/src/lib/mock/server.ts`) answers, asks follow-ups, marks typing done, gates approval, diffs, searches and masks by calling the same `@dct/shared` functions as the API (`answer.ts`, `problems.ts`, `questions.ts`, `blind.ts`, `search.ts`). A shared rule returns a refusal as a value (`{ refusal: { status, message } }`), which the API throws as an `HttpError` and the sample server sends as a response. What it keeps of its own: routing, in-memory storage and idempotency keys, seed data, and its stand-in for the contract checks (`mockChecks`). Keep the two in step.

## Adding or changing a write endpoint

1. Define or change the body in `packages/shared` (zod), exported from `src/index.ts`.
2. In `apps/api/src/routes/*.ts`, check the body with `safeParse` and refuse with `bodyProblem(error, BODY_WORDS.<body>)` (`packages/shared/src/evidence.ts`; add the body's words there): a 400 that names the first bad field in plain words. Not one fixed message for every field, and not `parse()` (`apps/api/src/lib/http.ts`), whose 400 is zod's `prettifyError` text (older routes still use it). Then `return write(db, req, reply, async (tx) => { … })` (`apps/api/src/lib/idempotency.ts`): one transaction, and the Idempotency-Key with its saved response in that same transaction.
3. For a write to a study, the first statement inside is `lockStudy(tx, id)` or `loadVersion(tx, id, v, true)`. Lock order is study, then job, then versions; never the other way round.
4. Refuse with `HttpError` in plain English: 400 for a bad request, 409 for a state that has moved on, saying what to do next. A repeat that changes nothing writes nothing and logs nothing.
5. In the same transaction: the change, `refreshStudyStatus(tx, studyId, by)` if any version changed (the only place study status and `needs_you` are computed), `audit(tx, by, studyId, action, detail)`, and `queueJob(tx, boss, …)` for any job. Give a new audit action a label in `ACTION_LABELS` (`packages/shared/src/labels.ts`).
6. Return versions through `versionDto` (blind entry), never a raw row.
7. Mirror it in the sample server. A rule about money, questions or blind entry goes in `@dct/shared` as a pure function that returns `{ refusal }` instead of throwing (as `answerQuestion`, `typingDone`, `signOffRefusal`, `versionDiff`, `noLimitTyped` do), called by the route and the sample server alike; anything else (send back, uploads, studies, settings) the sample server repeats with the same status codes and messages. Add the call to `apps/web/src/lib/api.ts`. Invalidate through `apps/web/src/lib/queries.ts` (`keys`, `useInvalidateStudy`).
8. Tests: the rule in `packages/shared/test`, the route's behavior, plus `apps/api/test/idempotency.test.ts` (twice with one key: replayed byte for byte, and every row of every table it writes unchanged) and `apps/api/test/atomicity.test.ts` (a failing last insert leaves nothing). The sample server's responses must still parse with the shared schemas (`apps/web/src/lib/mock/server.test.ts`).
9. Update the routes and idempotency tables in [docs/phase-1/api.md](docs/phase-1/api.md).

## Changing the database schema

1. Edit `apps/api/src/db/schema.ts`, then `pnpm --filter @dct/api db:generate` (drizzle-kit). For triggers, data fixes or anything drizzle can't express, add SQL to the generated file before it is applied anywhere, or start one with `pnpm --filter @dct/api db:generate --custom --name=<what>`. Then `pnpm --filter @dct/api db:check` (no database needed): it fails if `schema.ts` and the migrations disagree. The `migrations` suite runs it too, and checks the journal is in order with one SQL file per entry.
2. Never edit or reorder a migration that has been applied or committed. Drizzle applies only migrations newer than the last one applied (by journal timestamp) and never re-checks old ones: an edit is silently ignored, and a migration with an older timestamp (from another branch) is silently skipped. Regenerate after a rebase instead.
3. Before migrating the dev database, check it has nothing to lose: `psql postgres://dct:dct@localhost:5434/dct_finance -tAc "SELECT count(*) FROM studies"`. If it isn't empty, ask the owner first. Then `pnpm --filter @dct/api db:migrate`. A running dev API fails on the new tables or columns until this runs.
4. In production, migrations are a release step before the new build starts (`db:migrate:dist`), never on boot. See [docs/runbook.md](docs/runbook.md).

## Testing

| Suite | Command | Needs |
|---|---|---|
| API (vitest, real Postgres, `fastify.inject`, fake AI; the `migrations` suite runs `db:check`) | `pnpm --filter @dct/api test` | Postgres; database `dct_finance_test` (`TEST_DATABASE_URL` overrides it; global setup and `testApp` refuse a database whose name doesn't end in `_test`) |
| Shared, extraction, web units | `pnpm --filter @dct/shared test`, `pnpm --filter @dct/extraction test`, `pnpm --filter web test` | nothing (the AI is mocked) |
| Everything above | `pnpm test` | Postgres |
| Browser journey (Playwright, production builds, fake AI). Before answering, a step fails if its answers don't cover every value the random sample could draw | `pnpm e2e` | Postgres, Google Chrome, ports 3301 / 4301 free |
| Types | `pnpm -r typecheck` | — |
| Lint: ESLint in every package (the web its own config; api, shared and extraction the root `eslint.config.mjs`: un-awaited promises and thenables, misused promises, `return await` in try) | `pnpm lint` | — |

- API tests share `dct_finance_test` and truncate it. The e2e shares `dct_finance_e2e`, ports 3301 / 4301, `apps/web/.next-e2e` and `apps/api/dist`. **Never run two API test runs, or two e2e runs, at once**, including another agent's.
- "Done" means: `pnpm -r typecheck` and `pnpm lint` clean, every suite green, and `pnpm e2e` green. Say which of these you ran.
- To check one commit on its own, use a git worktree inside the repo (`git worktree add .claude/worktrees/<name> <commit>`; `.claude/` is git-ignored). In a worktree under `/private/tmp`, vitest found no test files. A worktree has no `.env` and no `data/`.

## Conventions

- Every user-facing word is plain English for an accountant: what happened and what to do. No codes, no stack traces, no jargon. This includes API error messages, which the web shows as they are.
- Comments explain why, not what. Match the density and style of the code around you.
- Light mode only.
- Every API route is under `/api/v1`; `/livez` and `/readyz` sit outside it.
- The sample server stays in parity with the API: same routes, status codes, messages and rules.
- Conventional Commit messages (`feat(api): …`), with no `Co-Authored-By` or AI attribution lines. Commit only when the owner asks.

## Gotchas

- Next.js 16 differs from your training data. Read the guide in `apps/web/node_modules/next/dist/docs/` before writing web code.
- Postgres runs in Apple `container` (`container ls`, `container exec`), not Docker: `apps/api/scripts/db.sh`.
- Run the root setup script as `pnpm run setup`: `pnpm setup` is pnpm's own command.
- Anything that imports `apps/api/src/config.ts` exits on a bad setting (`db:migrate`, `e2e-reset`, the API tests' global setup). Only starting the server (`src/server.ts`: `dev`, `start`) needs `ANTHROPIC_API_KEY` or `EXTRACTION_FAKE=1`; migrations, tests and the e2e don't. Outside the repo, `DATABASE_URL` and `UPLOAD_DIR` are required.
- Drizzle queries are thenables that run only when awaited: an un-awaited `audit(tx, …)` or `tx.update(…)` writes nothing, silently. `pnpm lint` catches it (`no-floating-promises` with `checkThenables`).
- `db.sh` publishes Postgres on 127.0.0.1 only, but a `dct-postgres` container created before that change (`d496a1f`) keeps listening on every interface until it's recreated. That deletes its data: see the runbook ("Recreating the dev database container") and ask the owner first.
- The API reads the repo-root `.env`; the web doesn't (Next reads `apps/web/.env*` and the shell).
- Only one `next dev` can run in `apps/web` (it locks `.next/dev`). To see your web change while the owner's dev server runs, use a sample build on another port: `pnpm --filter web build:sample && pnpm --filter web exec next start -H 127.0.0.1 -p 3200`.
- Saving an API file restarts `tsx watch`, which fails any read in progress.
