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
| Every money value has evidence: `confirmed` (PDF text at its spot agrees; on scans, the contract's own totals agree to the cent), `attested` (a person typed or chose it blind), `conflict` or `ungrounded` | `ValueEvidence` in `packages/shared/src/evidence.ts`; set by `bindEvidence` (`packages/extraction/src/binder.ts`) and `reviewDraft` (`apps/api/src/review.ts`); an answer marks it `attested` in `answer()` |
| Whatever isn't confirmed becomes a question; a blocking one clears only by a typed value or a pick, never free text (I6) | `reviewFromEvidence` (binder.ts), `fromAnomalies` and `answer()` in `apps/api/src/review.ts` |
| Sign-off gate: a draft; by-hand typing marked done; no unsettled blocking question; every evidence entry `confirmed` or `attested`; maker-checker if on | `POST /studies/:id/versions/:v/sign-off` in `apps/api/src/routes/versions.ts` |
| Blind entry: a value with an open question never leaves the server: masked in versions, search, diff, audit, alerts; numbers in notes about it blanked | `withheldPaths` (`packages/shared/src/api.ts`) → `versionDto` (`apps/api/src/domain.ts`) → `mask`, `blindReview` (`review.ts`); `blankNumbers` (`packages/shared/src/evidence.ts`); audit and alerts in `apps/api/src/routes/misc.ts`, `alerts.ts`; search and diff in `versions.ts` |
| Maker-checker (a setting, off by default): nobody in a version's `editors` may approve it. A hand-typed value is always re-typed by someone else | sign-off route; `answer()` (409 for the typist) |
| Approved is immutable; the old live version is superseded in the same transaction | `assertDraft` (`domain.ts`) and the trigger in `apps/api/drizzle/0006_signed_versions_locked.sql` |
| The audit log is append-only and written in the same transaction as the change | trigger in `apps/api/drizzle/0001_guards.sql`; `audit()` in `domain.ts` |
| Money is integer cents everywhere | `packages/shared/src/rulebook.ts`; `apps/web/src/lib/money.ts` |

The in-browser sample server (`apps/web/src/lib/mock/server.ts`) mirrors all of this. Keep the two in step.

## Adding or changing a write endpoint

1. Define or change the body in `packages/shared` (zod), exported from `src/index.ts`.
2. In `apps/api/src/routes/*.ts`, parse the body (`parse()` → 400 with readable issues), then `return write(db, req, reply, async (tx) => { … })` (`apps/api/src/lib/idempotency.ts`): one transaction, and the Idempotency-Key with its saved response in that same transaction.
3. For a write to a study, the first statement inside is `lockStudy(tx, id)` or `loadVersion(tx, id, v, true)`. Lock order is study, then job, then versions; never the other way round.
4. Refuse with `HttpError` in plain English: 400 for a bad request, 409 for a state that has moved on, saying what to do next. A repeat that changes nothing writes nothing and logs nothing.
5. In the same transaction: the change, `refreshStudyStatus(tx, studyId, by)` if any version changed (the only place study status and `needs_you` are computed), `audit(tx, by, studyId, action, detail)`, and `queueJob(tx, boss, …)` for any job. Give a new audit action a label in `ACTION_LABELS` (`packages/shared/src/labels.ts`).
6. Return versions through `versionDto` (blind entry), never a raw row.
7. Mirror it in the sample server, and add the call to `apps/web/src/lib/api.ts`. Invalidate through `apps/web/src/lib/queries.ts` (`keys`, `useInvalidateStudy`).
8. Tests: the route's behavior, plus `apps/api/test/idempotency.test.ts` (twice with one key, replayed byte for byte, no second effect) and `apps/api/test/atomicity.test.ts` (a failing last insert leaves nothing). The sample server's responses must still parse with the shared schemas (`apps/web/src/lib/mock/server.test.ts`).
9. Update the routes and idempotency tables in [docs/phase-1/api.md](docs/phase-1/api.md).

## Changing the database schema

1. Edit `apps/api/src/db/schema.ts`, then `pnpm --filter @dct/api db:generate` (drizzle-kit). For triggers, data fixes or anything drizzle can't express, add SQL to the generated file before it is applied anywhere, or start one with `pnpm --filter @dct/api db:generate --custom --name=<what>`.
2. Never edit or reorder a migration that has been applied or committed. Drizzle applies only migrations newer than the last one applied (by journal timestamp) and never re-checks old ones: an edit is silently ignored, and a migration with an older timestamp (from another branch) is silently skipped. Regenerate after a rebase instead.
3. Before migrating the dev database, check it has nothing to lose: `psql postgres://dct:dct@localhost:5434/dct_finance -tAc "SELECT count(*) FROM studies"`. If it isn't empty, ask the owner first. Then `pnpm --filter @dct/api db:migrate`. A running dev API fails on the new tables or columns until this runs.
4. In production, migrations are a release step before the new build starts (`db:migrate:dist`), never on boot. See [docs/runbook.md](docs/runbook.md).

## Testing

| Suite | Command | Needs |
|---|---|---|
| API (vitest, real Postgres, `fastify.inject`, fake AI) | `pnpm --filter @dct/api test` | Postgres; database `dct_finance_test`; a key or `EXTRACTION_FAKE=1` (Gotchas) |
| Shared, extraction, web units | `pnpm --filter @dct/shared test`, `pnpm --filter @dct/extraction test`, `pnpm --filter web test` | nothing (the AI is mocked) |
| Everything above | `pnpm test` | Postgres |
| Browser journey (Playwright, production builds, fake AI) | `pnpm e2e` | Postgres, Google Chrome, ports 3301 / 4301 free |
| Types, lint | `pnpm -r typecheck`, `pnpm --filter web lint` | — |

- API tests share `dct_finance_test` and truncate it. The e2e shares `dct_finance_e2e`, ports 3301 / 4301, `apps/web/.next-e2e` and `apps/api/dist`. **Never run two API test runs, or two e2e runs, at once**, including another agent's.
- "Done" means: `pnpm -r typecheck` and `pnpm --filter web lint` clean, every suite green, and `pnpm e2e` green. Say which of these you ran.

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
- Anything that imports `apps/api/src/config.ts` exits on bad settings, and it needs `ANTHROPIC_API_KEY` unless `EXTRACTION_FAKE=1`. That includes `db:migrate`, `e2e-reset` and the API tests' global setup (vitest's `test.env` doesn't reach it), so without a key put `EXTRACTION_FAKE=1` in `.env` or the shell.
- The API reads the repo-root `.env`; the web doesn't (Next reads `apps/web/.env*` and the shell).
- Only one `next dev` can run in `apps/web` (it locks `.next/dev`). To see your web change while the owner's dev server runs, use a sample build on another port: `pnpm --filter web build:sample && pnpm --filter web exec next start -H 127.0.0.1 -p 3200`.
- Saving an API file restarts `tsx watch`, which fails any read in progress.
