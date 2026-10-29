# Runbook

How to run DCT Finance, day to day and as a production build, and what to do when something goes wrong. The quick start for a development machine is in the [README](../README.md). Architecture: [architecture.md](architecture.md). Security posture: [security.md](security.md).

## What runs where

| Process | Address | State |
|---|---|---|
| API (`apps/api`), with the job workers in the same process | `127.0.0.1:4100` (`PORT`) | Postgres; PDFs and page images in `UPLOAD_DIR` |
| Web (`apps/web`) | `127.0.0.1:3100` | none; `/api/*` is proxied to `API_URL` |
| Postgres 16 | `127.0.0.1:5434`, Apple `container` named `dct-postgres` (`apps/api/scripts/db.sh`; a container created before `d496a1f` listens on every interface until it's [recreated](#recreating-the-dev-database-container)) | databases `dct_finance` (dev), `dct_finance_test` (API tests), `dct_finance_e2e` (e2e) |

Both servers bind to 127.0.0.1 only and there is no login: one computer, one team. Read [security.md](security.md) before changing that.

## Settings

Every setting is an environment variable, listed with its default in [`.env.example`](../.env.example).

- The API reads the repo-root `.env` at startup; variables already set in the environment win, and an empty value counts as unset. It checks every setting with zod (`apps/api/src/config.ts`) before it listens or connects, and exits naming each bad one, never printing a value.
- Anything that imports the API's config runs the same check: the server, `db:migrate`, `db:migrate:dist`, `scripts/e2e-reset.ts`. So the migration step needs the server's settings too, except `ANTHROPIC_API_KEY`: only the server checks for it (or `EXTRACTION_FAKE=1`) when it starts, since only the server reads contracts.
- The web does not read the repo-root `.env`. Next.js reads `apps/web/.env*` and the shell. `API_URL` is baked into the proxy when the web is **built**.
- Outside the repo checkout, the API (and `db:migrate:dist`) refuses to start without `DATABASE_URL` and an absolute `UPLOAD_DIR`: inside it they default to the local dev database and `<repo>/data/uploads`, which must never be what a deployed API uses.

## Build and start (production)

The build runs from a full checkout with `pnpm install` done. The bundle inlines `@dct/shared` and `@dct/extraction` with their own dependencies, but the API's own dependencies (Fastify, pg, pg-boss, Drizzle) and the mupdf worker are loaded from `node_modules`, and the migrations are found by walking up from `dist/` to `apps/api/drizzle`. Keep `dist/` where the build puts it.

```sh
pnpm install --frozen-lockfile
pnpm --filter @dct/api build                      # tsup → apps/api/dist (server.js, db/migrate.js)
pnpm --filter @dct/api db:migrate:dist            # release step: node dist/db/migrate.js (back up first)
pnpm --filter @dct/api start                      # node dist/server.js
API_URL=http://127.0.0.1:4100 pnpm --filter web build   # always the real app, never sample data
pnpm --filter web start                           # next start on 127.0.0.1:3100
```

### Migrations are a release step

Migrations never run on boot. Run them before starting the new build:

- `pnpm --filter @dct/api db:migrate:dist` from a build, or `pnpm --filter @dct/api db:migrate` from source (dev).
- The migrator holds an advisory lock, so two runs at once apply each migration once.
- All pending migrations run in one transaction. There are no down migrations: to undo one, restore a backup.
- A server started on a database that's behind logs an error and stays not ready (`/readyz` → `schema: "behind"`) until the migrations are applied, and starts no job workers or schedule. Restart it afterwards so the workers and the startup maintenance run.
- pg-boss creates and upgrades its own `pgboss` schema when the API starts, under its own lock.

Migrations worth knowing about when you deploy them:

| Migration | Does |
|---|---|
| `0010_perfect_virginia_dare` | Adds `rulebook_versions.warnings`. Maker-checker defaults to on, and is turned on in a database whose audit log is empty; a database already in use keeps its setting (check Settings after deploying) |
| `0011_truncate_guards` | `TRUNCATE` is refused on the audit log, and on `rulebook_versions` while any version is approved, also through `TRUNCATE … CASCADE` |

### Health checks

Both probes are outside `/api/v1` and pass through the Host guard, so the caller's `Host` must be in `ALLOWED_HOSTS` (the default allows `localhost` and `127.0.0.1` on `PORT` and on 3100).

```sh
curl -s http://127.0.0.1:4100/livez    # {"status":"ok"} while the process serves requests
curl -s http://127.0.0.1:4100/readyz   # {"status":"ready","database":"ok","jobs":"ok","schema":"ok"}
```

`/readyz` answers 503 `{"status":"not ready", ...}` when the database doesn't answer within 2 s (`database: "unavailable"`, `schema: "unknown"`), pg-boss doesn't answer or has stopped (`jobs: "unavailable"` / `"stopped"`), the database is missing migrations (`schema: "behind"`), or shutdown has started.

## AI reads: models and spend cap

| Step | Model (setting, default) |
|---|---|
| Page sorting and document identification | Claude Haiku 5.5 (`ANTHROPIC_FAST_MODEL`, `claude-haiku-5-5`), low effort |
| Contract terms: 3 calls sharing cached page images (1568 px) | Claude Sonnet 5.5 (`ANTHROPIC_MODEL`, `claude-sonnet-5-5`), medium effort |
| Budget grids: 400 DPI tiles | Sonnet 5.5, medium effort; one high-effort re-read of a grid when a few of its totals don't add up and the cap allows it |
| Second read of contract terms (`CROSS_READ`, `haiku`) | Haiku 5.5, low effort, terms only. `openai` needs `OPENAI_API_KEY` and `OPENAI_MODEL` and costs more than the main read; `off` turns it off. Its disagreements are stored but never asked: a second model is not evidence (ADR-001 §4). |

- **Spend cap:** `EXTRACTION_MAX_USD`, default **$20 per read** of a contract, across all providers, on real tracked spend. It is checked before every model call of the read (`packages/extraction/src/extract.ts`; identifying documents from their first pages is outside it); calls already running can finish, so the overshoot is at most their cost. Each "Read it again" or amendment read gets its own cap. There is no up-front estimate refusal any more (the $1 estimate guard was replaced on 2026-10-28).
- A successful read stores its cost and tokens on the version and in its `extraction.completed` log entry. The spend of a read that fails is not recorded.
- Cost so far, on the 4 test contracts (scans): offline estimates of $0.46–0.81 each (2026-10-26, `phase-1/extraction.md`), and $0.45–1.58 measured for the primary read on saved Sonnet runs (ADR-001 §11). The ADR's estimates for text PDFs are still to be measured on the held-out set.
- Never start a real read, `pnpm eval` or `pnpm probe` without the owner's approval: they spend money.

## Logs

The API writes JSON lines (pino) to stdout at `LOG_LEVEL` (default `info`):

```json
{"level":30,"time":1793214699140,"pid":4242,"hostname":"…","reqId":"a8a5bbd4-a89c-4685-a8c2-93eead2bc2cb","req":{"method":"GET","url":"/api/v1/studies/:id"},"msg":"incoming request"}
{"level":30,"time":1793214699142,"pid":4242,"hostname":"…","reqId":"a8a5bbd4-a89c-4685-a8c2-93eead2bc2cb","res":{"statusCode":200},"responseTime":1.68,"msg":"request completed"}
```

- A request is logged as its method and route pattern only: no ids, query strings, bodies, contract text or amounts. Probes log warnings only.
- Every response carries `X-Request-Id`, the `reqId` of its log lines.
- A 5xx response never shows its cause. It says "Something went wrong on the server. Try again; if it keeps happening, tell the team (ref <request id>)." Search the logs for that id: the `request failed` line has the database error code, its message and the SQL, without the values bound to it.
- Levels: 30 info, 40 warn, 50 error. Lines worth an alert: `request failed`, `pg-boss error`, `job failed`, `idle database connection failed`, `the database is behind this build…`, `jobs not started: the database is behind this build`, `shutdown took too long: exiting`. Warnings worth reading: `a job had ended without finishing; marked failed`, `a read had no job; marked failed`, `write rolled back by a concurrent one`, and `pg-boss warning` (pg-boss's own message, such as a slow query; its data is never logged, since it can hold job data).

## Shutdown

On SIGTERM or SIGINT (Ctrl-C):

1. Fastify stops taking requests: new ones get 503, and `/readyz` reports not ready.
2. Requests in flight finish.
3. pg-boss stops and gives a running job up to `min(10 s, SHUTDOWN_TIMEOUT_MS / 2)` to finish.
4. The database pool closes and the process exits 0.

Past `SHUTDOWN_TIMEOUT_MS` (30 s), or on a second signal, it exits 1 at once.

## Jobs when the server stops

| What was happening | What happens |
|---|---|
| A job queued, not started | It stays in pg-boss and runs after the next start. |
| A read (`extract`) running, graceful stop | It gets the shutdown grace period. Still running after it, pg-boss fails it; it is never retried. It lands in `stranded`, and the next start marks the read failed. |
| A read running, crash or `kill -9` | Its heartbeats stop. pg-boss fails it once 60 s pass without one (it checks every minute) and copies it to `stranded`. With one server, that happens within a minute or two of the next start. |
| An `identify` job running | Retried up to twice, 5 s apart; only one run writes. Out of retries, it's failed like a read. |
| A read past 2 hours | Failed by pg-boss ("took more than two hours"). |
| A read pg-boss gives up on while it runs (past its time, its claim lost, a shutdown) | The read is abandoned: it starts no further AI call, cancels the one in flight, and never writes its result. The stranded queue fails it in plain words, as above. |

A failed read shows "Couldn't read" on the contract, raises the "couldn't read" alert and writes `extraction.failed` with a plain message and a technical detail. Nothing is half-saved: a read's result is written in one transaction, and only while its job is still running. Startup maintenance (and every 10 minutes after) fails anything a stranded job couldn't handle, and any version left `extracting` with no job.

In development, `pnpm dev` runs the API under `tsx watch`: saving an API file restarts it, which fails any read in progress.

## Troubleshooting

### "The database is behind" / `/readyz` shows `schema: "behind"`

- **Symptom:** at startup, an error line `the database is behind this build: run the migrations (pnpm --filter @dct/api db:migrate), then restart` with `pending: <n>`, then `jobs not started: the database is behind this build`. `/readyz` answers 503 with `schema: "behind"`. Requests that touch new tables or columns fail with the generic 5xx, and no read or identify job runs.
- **Cause:** this build ships migrations the database hasn't applied: a pull or deploy with a schema change, without the release step.
- **Fix:** back up (below), run `pnpm --filter @dct/api db:migrate:dist` (build) or `pnpm --filter @dct/api db:migrate` (dev) with the server's settings, then restart the API. `/readyz` should then show `schema: "ok"`.

### A stranded read

- **Symptom:** a contract shows "Couldn't read" with "The server stopped while reading this contract, so the reading didn't finish. Read it again, or type it in by hand." (or "Reading this contract took more than two hours…"). The `extraction.failed` entry's detail is `pg-boss: job heartbeat timeout`, `pg-boss: job timed out` or `pg-boss: handler execution exceeded 7200s` (both time-outs, so the message says "took more than two hours"), `pg-boss: the queued job is missing` or `no job was reading this version`.
- **Cause:** the API stopped or crashed during the read (in dev, a `tsx watch` restart counts), or the read ran past 2 hours.
- **Fix:** nothing to repair: nothing was half-saved. A person chooses "Read it again" on the contract page (a new paid read, same version number) or types it in by hand. If reads keep timing out, look at the contract's size (pages, grids). To see live jobs: `SELECT id, kind, state, step, updated_at FROM jobs WHERE state IN ('queued', 'running');` (read only).

### An upload is refused

| Status | Message | Cause | Fix |
|---|---|---|---|
| 415 | `<file> is not a PDF` | The file doesn't start with `%PDF-` | Upload the PDF itself, not a Word file or image |
| 400 | `<file> could not be read as a PDF` | mupdf, which counts its pages in a worker, can't open it (damaged) | Get a fresh copy |
| 422 | `<file> took too long to open, so it wasn't uploaded. It may be damaged or unusually complex: save it again as a PDF, or upload a fresh copy.` | mupdf didn't open it and count its pages within 30 s | Save it again as a PDF (print to PDF), or get a fresh copy |
| 422 | `<file> has <n> pages; the limit is 100 per document…` | Over 100 pages | Split it into smaller PDFs |
| 413 | `This file is bigger than the 50 MB limit. Split it into smaller PDFs and upload those.` / `Upload at most 50 files at once.` / `This upload has too many parts…` / `This upload has too many fields…` | Over 50 MB, over 50 files, or over 60 parts or 10 fields in one request | Split the file; the web sends one file per request and refuses files over 50 MB before sending |
| 403 | `Host not allowed` / `Origin not allowed` | The request came through a host or origin not in `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` | Use the app's own address, or add it to those settings |

A password-protected or unusual PDF can pass the upload and fail at reading instead, with "This PDF couldn't be read…".

### A config error at startup

- **Symptom:** the API (or `db:migrate`) exits at once, printing `The API's settings aren't valid (check .env or the environment):` and one line per bad setting, for example `PORT must be a port number from 1 to 65535`. The server alone also exits with `ANTHROPIC_API_KEY is needed to read contracts (or set EXTRACTION_FAKE=1 for the synthetic reading)`; it checks that after the other settings, so it shows once they're right.
- **Cause:** a setting is missing, mistyped or out of range, in `.env` or the environment. Values are never printed.
- **Fix:** correct each named setting ([`.env.example`](../.env.example) lists them), then start again. Remember that a variable set in the shell wins over `.env`.

### The spend cap is reached

- **Symptom:** a read fails with "This read has spent $<x>, the $<cap> limit for one read, so it was stopped before the next AI call."
- **Cause:** the read's tracked spend reached `EXTRACTION_MAX_USD` (default $20).
- **Fix:** don't just retry: each retry pays again. Check why the read cost that much (page count, number of grids and tiles; the page and image limits are in `CONFIG`, `packages/extraction/src/extract.ts`). Raising the cap is the owner's decision; if they agree, set `EXTRACTION_MAX_USD`, restart the API, then "Read it again". Otherwise type the contract in by hand.

### Approval refused after a random spot check missed

- **Symptom:** approving says "A random spot check found a wrong number among the <kind of value>, so each of them has to be proofread before approval: <n> of <m> still to check." Everyone got the alert "<contract>: a random spot check found a wrong number", and the Activity log has "Spot check found a wrong number" (`sample.missed`).
- **Cause:** one of the 10 values re-typed blind after the read was one the PDF check had confirmed, and the person kept a different value after looking again. That is an incident (ADR-001 §6): the check passed a wrong number, so every value of that kind is checked by a person.
- **Fix:** proofread each value of that kind ("Proofread them" on the approve page), marking "Looks right" or reporting what's wrong, then approve. Once a sample has missed it stays missed. Tell the team: each miss is how silent errors are measured.

### "This contract changed since you opened it. Check it again."

- **Symptom:** approval is refused with that message (409).
- **Cause:** approval sends the version as the approver saw it (`asOf`). Something changed it since: an answer, a report or a send-back in another tab or by someone else.
- **Fix:** look at the approve page again (it refreshes by itself) and approve what it shows now. Nothing was saved by the refused approval.

## Backups

**There is no backup tooling in this repo.** Nothing dumps the database or copies the uploads on a schedule, and no restore has been tested. Until there is:

- Everything that matters is in two places: the Postgres database and `UPLOAD_DIR`. Documents store the absolute path of their PDF, so restore the uploads to the same path. Page images under `UPLOAD_DIR/pages` are a cache and are drawn again when missing.
- Before a migration or any risky change, dump the database, for example: `pg_dump "$DATABASE_URL" -Fc -f dct-finance-$(date +%F).dump` (checked with `--schema-only` against the dev database), and copy `UPLOAD_DIR`.
- `apps/api/scripts/db.sh reset` deletes the dev container and everything in it.

## Day to day (development)

| Task | Command |
|---|---|
| Start or stop Postgres | `pnpm db:start` / `pnpm db:stop` |
| Delete and recreate the dev container (all local data, without asking: check with the owner first) | `pnpm --filter @dct/api db:reset` |
| Apply migrations to the dev database | `pnpm --filter @dct/api db:migrate` |
| Check the migrations match `schema.ts` (no database needed) | `pnpm --filter @dct/api db:check` |
| Lint every package | `pnpm lint` |
| Check whether the dev database holds data | `psql postgres://dct:dct@localhost:5434/dct_finance -tAc "SELECT count(*) FROM studies"` |
| Open a SQL prompt | `psql postgres://dct:dct@localhost:5434/dct_finance` (or `container exec -it dct-postgres psql -U dct -d dct_finance`) |

## Recreating the dev database container

`db.sh` publishes Postgres on 127.0.0.1 only since `d496a1f`. A `dct-postgres` container created before that keeps its old binding, on every network interface, with the password `dct`, until it's deleted and created again. Recreating it deletes everything in it, so it's the owner's call, and the data is dumped first. The steps (nothing here runs by itself):

1. **Check whether it's needed.** `container inspect dct-postgres` shows `publishedPorts`: a `hostAddress` of `0.0.0.0` is the old binding; `127.0.0.1` needs nothing.
2. **Stop the API** (Ctrl-C on `pnpm dev` or `pnpm dev:api`), so no read or write is running when the database goes away. Leave the container running.
3. **Note what's there:** `psql postgres://dct:dct@localhost:5434/dct_finance -tAc "SELECT (SELECT count(*) FROM studies), (SELECT count(*) FROM audit_log)"`.
4. **Dump the dev database**, unless step 3 shows nothing to keep: `pg_dump postgres://dct:dct@localhost:5434/dct_finance -Fc -f dct-finance-$(date +%F).dump`, with a `pg_dump` of version 16 or later (`pg_dump --version`), run on this computer so the file outside the container survives. `dct_finance_test` and `dct_finance_e2e` hold nothing to keep: their test runs wipe them.
5. **Recreate it:** `pnpm --filter @dct/api db:reset` stops and deletes the container, then runs a new one on 127.0.0.1:5434 and creates the three databases, empty.
6. **Put the data back:** `pg_restore --no-owner -d postgres://dct:dct@localhost:5434/dct_finance dct-finance-<date>.dump`. It should report no errors; if it does, stop there and keep the dump. The restore brings the migrations table and the `pgboss` schema with it. With nothing to keep, run `pnpm --filter @dct/api db:migrate` instead.
7. **Check:** `container inspect dct-postgres` shows `hostAddress` `127.0.0.1`; the counts of step 3 are the same; start the API and `/readyz` shows `schema: "ok"`. The uploads in `data/uploads` are outside the container and aren't touched.
