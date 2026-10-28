# apps/api

The HTTP API (Fastify 5) and the job workers (pg-boss) in one Node process, on Postgres through Drizzle. It owns all state: studies, documents, rulebook versions with their evidence and review questions, jobs, the audit log, alerts and settings. Routes and decisions in detail: [docs/phase-1/api.md](../../docs/phase-1/api.md). Operations: [docs/runbook.md](../../docs/runbook.md). Repo rules: [AGENTS.md](../../AGENTS.md).

## Key files

| File | What it holds |
|---|---|
| `src/server.ts` | Entry point: checks the AI key (`readingProblem` in `config.ts`; nothing else does), listens on `127.0.0.1:PORT`, graceful shutdown on SIGTERM / SIGINT |
| `src/app.ts` | `buildApp()`: logger, error handler (5xx sanitizing, Postgres error codes → 400 / 409, upload limits → 413 in words), Host/Origin guard, probes, `/api/v1` routes, `onClose` (pg-boss, then the pool) |
| `src/config.ts` | Every setting, checked with zod at import; exits naming bad settings, never values |
| `src/db/schema.ts` | The tables. `src/db/index.ts`: the pool and `pendingMigrations`. `src/db/migrate.ts`: the migrator (advisory lock) |
| `drizzle/` | Migrations: generated SQL plus custom SQL (triggers in `0001_guards.sql`, `0006_signed_versions_locked.sql`, the TRUNCATE guards in `0011_truncate_guards.sql`) |
| `src/lib/idempotency.ts` | `write()`: one transaction per write, with its Idempotency-Key |
| `src/domain.ts` | `lockStudy`, `loadVersion` (reads old rulebooks through `upgradeRulebook`), `refreshStudyStatus`, `audit`, `versionDto` (blind entry), `assertDraft`, carrying corrections and per-arm grid choices into amendments |
| `src/review.ts` | `reviewDraft` (every question after a read: values, money terms, contract problems, interpretations, pages, corrections an amendment couldn't carry, the blind sample), `fromAnomalies`, `recheck`, `byHandQuestions`, `answer` (the bill-by-hand list, a sample miss). Masking and the question builders are in `@dct/shared` (`blind.ts`, `questions.ts`) |
| `src/jobs.ts` | Queues `identify`, `extract`, `stranded`, `maintenance`; `queueJob`; `failure()` (plain-words job errors) |
| `src/routes/*.ts` | `documents` (uploads, page images), `studies` (create, confirm, read, by hand, list, search, jobs), `versions` (answers, report, proofread, send back, sign-off, diff, export), `misc` (audit, settings), `alerts` |
| `src/extraction/port.ts` | The only way into `@dct/extraction`; `EXTRACTION_FAKE=1` swaps in `fake.ts`, which fakes only the AI |
| `src/lib/http.ts` · `pointer.ts` · `diff.ts` | `HttpError` and `parse()`; JSON pointers; the labelled rulebook diff |
| `scripts/db.sh` | Postgres 16 in Apple `container` `dct-postgres`, port 5434 (`start`, `stop`, `reset`) |
| `scripts/e2e-reset.ts` | Wipes and migrates the e2e database; refuses anything not named `*_e2e` |
| `tsup.config.ts` | The production bundle (`dist/server.js`, `dist/db/migrate.js`) |

## Commands

| Command | Does |
|---|---|
| `pnpm --filter @dct/api dev` | `tsx watch src/server.ts` (restarts on every save) |
| `pnpm --filter @dct/api test` | vitest against `dct_finance_test`, fake AI, a temp `UPLOAD_DIR` |
| `pnpm --filter @dct/api typecheck` | `tsc --noEmit` |
| `pnpm --filter @dct/api build` / `start` | tsup → `dist/`; `node dist/server.js` |
| `pnpm --filter @dct/api db:generate` | drizzle-kit: a migration from `schema.ts` (`--custom --name=<what>` for an empty one) |
| `pnpm --filter @dct/api db:migrate` / `db:migrate:dist` | Apply migrations from source / from the build |
| `pnpm --filter @dct/api db:start` · `db:stop` · `db:reset` | `scripts/db.sh`; `reset` deletes the container and all its data |

## Rules for writes

- Every POST and PATCH goes through `write()`. Inside, take the study lock first (`lockStudy`, or `loadVersion(…, true)`), then the job row, then versions. The idempotency key's advisory lock comes before all of them.
- The change, `refreshStudyStatus` (after any version change), `audit`, alerts and `queueJob` all use the same `tx`. Never queue a job or write an audit entry after the commit.
- A repeat that changes nothing returns the current state and logs nothing. A repeat the state has moved past is a 409 that says what to do.
- Messages are plain English for accountants. A 5xx never shows its cause; never put SQL, values or contract text in an error, a job error or a log line.
- Every response that carries a version goes through `versionDto`. Never return a raw row, and never add a field that could carry a withheld value without masking it.
- The full checklist for a new write endpoint is in the [root AGENTS.md](../../AGENTS.md#adding-or-changing-a-write-endpoint).

## Jobs

- `extract` is never retried: each try pays for AI reads. It claims its row `queued → running` once, and writes its result only while the row is still `running`, in one transaction.
- No worker or schedule starts while the database is behind this build's migrations (`startBoss`, `schemaBehind`).
- A job whose server died ends in `stranded` and is failed there in plain words (`recover`); `maintain` is the backstop at startup and every 10 minutes.
- `failure()` maps errors to plain words by class name (`ExtractionLimitError`, `RenderTimeoutError` keep their own message). Renaming those classes in `@dct/extraction` silently changes what people read.

## Pitfalls

- Importing `src/config.ts` runs the settings check, and a bad setting calls `process.exit(1)`. Scripts and tests that import it need valid settings, but not the AI key: only `server.ts` checks that.
- A second API process on the same database shares the pg-boss queues, so its workers run that database's jobs. Never start one against `dct_finance`; give it its own database and `UPLOAD_DIR`.
- `fastify.inject` sends `Host: localhost:80`; `vitest.config.ts` allows it in `ALLOWED_HOSTS`. Real requests need a Host from that list.
- `tsup` inlines `@dct/shared` and `@dct/extraction` (TypeScript source) with their dependencies and adds a `require` banner for bundled CommonJS. A new dependency there can break `node dist/server.js` while `tsx` works: the e2e runs the build, so run it.
- The migrations folder and `.env` are found by walking up from the running file, so `dist/` must stay inside `apps/api`.
- Study status is derived, never set by hand: change versions, then call `refreshStudyStatus`.

## Testing

- `test/helpers.ts`: `testApp({ workers })` (pins the blind sample's draw to `NO_SHUFFLE`), `resetDb` (truncates everything with the TRUNCATE guards off for its own transaction only, and turns maker-checker off), `signOff` (sends `asOf` as the approve page does), synthetic PDFs (`makePdf` is a scan; `makeTextPdf` prints what the fake read says, one titled table per fake grid, with `feeLine` for extra words on the fee's line), `waitJob`, `settleAll`, `liveStudy` (Asha answers, Ben approves).
- `src/extraction/fake.ts` `fakeControls`: make the next read fail (`failNext`), count calls, hold a read open (`hold`), or set the read's `warnings`. A filename containing `unreadable` fails the fake read.
- Suites by concern: `flow` (the journey), `review` (questions, blind entry, answering), `money` (the ADR's review rules: bill by hand, per-arm grids, maker-checker, the gate, `asOf`, TRUNCATE guards), `review-lists` (interpretations, the start date, the blind sample and a miss, uncarried corrections), `idempotency`, `atomicity` (failure injection), `jobs` (duplicates, stranded, maintenance), `uploads`, `guard` and `hardening` (Host/Origin, 5xx, blind side doors), `ops` (probes, request id, settings check), `search`, `alerts`, `lib`.
- The suite shares one database and runs files one at a time (`fileParallelism: false`). Never run it twice at once.
