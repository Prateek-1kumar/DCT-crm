# Phase 1 · Workstream A · `apps/api`

## Status

Every route is under **`/api/v1`** (nothing is served on `/api`) and tested: vitest against a real Postgres test database, through `fastify.inject`. Extraction runs through a port. The **fake adapter** fakes only the AI: page images, the PDF's text layer and the evidence binding are the real `@dct/extraction` code.

Since 2026-10-28 the API implements the review workflow of ADR-001 (`docs/phase-1/adr-001-extraction-evidence.md`), step 5 "backend wiring". It mirrors the in-browser sample server (`apps/web/src/lib/mock/server.ts`): every number is checked against the PDF's own text, a person answers what didn't check out, blind, and approval is gated on those answers.

## How to run

```sh
pnpm install
apps/api/scripts/db.sh start          # Postgres 16 in Apple `container` "dct-postgres", port 5434; creates dct_finance + dct_finance_test
pnpm --filter @dct/api db:migrate     # drizzle migrations (DATABASE_URL from repo-root .env)
EXTRACTION_FAKE=1 pnpm dev:api        # tsx watch: http://127.0.0.1:4100/api/v1
pnpm --filter @dct/api test           # uses dct_finance_test, temp UPLOAD_DIR, fake extraction
pnpm --filter @dct/api typecheck
```

Production (no tsx):

```sh
pnpm --filter @dct/api build          # tsup → apps/api/dist (server.js, db/migrate.js)
pnpm --filter @dct/api db:migrate:dist   # node dist/db/migrate.js: a separate release step, before starting
pnpm --filter @dct/api start          # node dist/server.js
```

`db.sh stop` stops the container and `db.sh reset` deletes and recreates it. The script only touches `dct-postgres`.

**Settings** are environment variables, every one listed with its default in the repo-root `.env.example`. Variables already set win over `.env`. They're checked once at startup with zod (`src/config.ts`): a bad or missing one stops the API before it listens or connects, with a list naming each bad setting and what it must be, never its value (`DATABASE_URL` and the API keys are secrets). An empty value counts as unset. The reading's own settings (`EXTRACTION_MAX_USD`, `EXTRACTION_GRID_DPI`, `CROSS_READ*`, `OPENAI_*`) are read by `@dct/extraction`, but checked here too, so a typo fails at startup instead of silently falling back to a default; `ANTHROPIC_API_KEY` is required unless `EXTRACTION_FAKE=1`.

The web's Next rewrite forwards `/api/:path*` to the API unchanged, so `/api/v1/...` needs no proxy change.

## Routes

All under `/api/v1`. Bodies and responses are the types in `packages/shared` (`api.ts`, `evidence.ts`, `search.ts`, `alerts.ts`). Errors are `{ statusCode, error, message }`: `error` is the status's name ("Conflict"), `message` plain English. Every POST and PATCH takes an `Idempotency-Key` header (below). Every response carries `X-Request-Id`, the id in its log lines and in a 5xx message's "ref".

Probes, outside `/api/v1` (for whatever runs the server, not part of the API's contract, so they never move with an API version; the host guard applies to them too, and they log only warnings):

| Route | Does |
|---|---|
| GET `/livez` | 200 `{ status: "ok" }` while the process serves requests |
| GET `/readyz` | 200 `{ status: "ready", database, jobs, schema }` when the database answers, pg-boss answers and isn't stopping, and the database has every migration this build ships; else 503 with the one that isn't (`unavailable`, `stopped`, `behind`). 503 too once shutdown starts |

| Method | Route | Body / query | Does |
|---|---|---|---|
| POST | `/uploads` | multipart `files[]`, `by` | Stores each PDF by sha256 → 201 `DocumentDto[]` (`duplicateOf`; `text` from the text layer) |
| PATCH | `/documents/:id` | `SetDocumentKindBody` | Fixes a document's kind → `DocumentDto` |
| GET | `/documents/:id/pages/:n.png` | `?dpi=72–400` | Page image, cached on disk |
| POST | `/studies` | `CreateStudyBody` | Creates a study, queues identify → 201 `{ studyId, jobId }` (same file set twice → same study) |
| GET | `/studies` | `StudyListQuery` | One page of the list, most urgent first → `StudyPage` |
| GET | `/studies/counts` | `?site=` | Per view and per site → `StudyCounts` |
| GET | `/search` | `?q=&limit=` | ⌘K: contracts, and rates in live versions → `SearchResults` |
| GET | `/studies/:id` | | `StudyDetailDto` |
| PATCH | `/studies/:id` | `ConfirmStudyBody` | Confirms the details → `StudyDetailDto` |
| POST | `/studies/:id/extract` | `ExtractBody` | Queues a read (optionally adds documents) → 202 `{ jobId, version }` |
| GET | `/jobs/:id` | | `JobDto` |
| POST | `/studies/:id/versions/by-hand` | `ByHandBody` | Blank draft to type a contract in by hand → 201 `RulebookVersionDto` |
| GET | `/studies/:id/versions/:v` | | `RulebookVersionDto`, hidden values withheld (blind entry) |
| GET | `/studies/:id/versions/:v/search` | `?q=` | What in this master matches → `MasterSearch`; never a hidden value |
| GET | `/studies/:id/versions/:v/diff` | `?against=` | `DiffEntry[]`; never a hidden value |
| GET | `/studies/:id/versions/:v/export.xlsx` | `?by=` | The approved master as Excel (signed or superseded only, else 409) |
| POST | `/studies/:id/versions/:v/review/:itemId` | `AnswerReviewBody` | Answers one question, or changes an answer while a draft → `RulebookVersionDto` |
| POST | `/studies/:id/versions/:v/report` | `ReportValueBody` | "This looks wrong": a question on a draft, or a correction draft from the live version → the draft |
| POST | `/studies/:id/versions/:v/proofread` | `ProofreadBody` | "Looks right" marks; any version with a master except superseded → `RulebookVersionDto` |
| POST | `/studies/:id/versions/:v/send-back` | `SendBackBody` | The approver reopens answers, blind, with a note → `RulebookVersionDto` |
| PATCH | `/studies/:id/versions/:v/values` | `CorrectValueBody` | Types one value; by-hand drafts only, until typing is done → `RulebookVersionDto` |
| POST | `/studies/:id/versions/:v/by-hand/done` | `ByHandBody` | Typing done: up to 10 typed values to re-type blind → `RulebookVersionDto` |
| POST | `/studies/:id/versions/:v/sign-off` | `SignOffBody` | Approves (gate below) → `RulebookVersionDto` |
| GET | `/alerts` | `AlertListQuery` | One person's alerts, newest first → `AlertPage`; a send-back note's numbers blanked |
| POST | `/alerts/read` | `ReadAlertsBody` | Marks alerts read → `{ unread }` |
| GET | `/audit` | `AuditListQuery` | One page of the log, newest first, searched by `q` → `AuditPage`; hidden values withheld, notes about them blanked |
| GET, PATCH | `/settings` | `PatchSettingsBody` | `SettingsDto` (people, makerChecker) |

Removed on 2026-10-28, because the web no longer calls them and they bypass the gate: `POST .../anomalies/:aid/resolve` (any blocker could be cleared with free text, against I6), `POST .../grid-choice` (now the `GRID_CONFLICT` question), `POST /studies/:id/versions {manual}` (now `versions/by-hand`), and value corrections through `PATCH .../values` on a read draft (now "This looks wrong", answered blind).

## Layout

- `src/db/schema.ts` defines the tables: studies, documents, study_documents, rulebook_versions, jobs, audit_log, alerts, alert_reads, settings.
- `drizzle/0000_init.sql` is generated. `drizzle/0001_guards.sql` is custom: an append-only trigger on audit_log, an immutability trigger on signed versions, and the settings row seed. `drizzle/0005_talented_slyde.sql` adds the review columns and replaces the immutability trigger (below).
- `src/extraction/port.ts` holds the `@dct/extraction` interface and adapter selection. `fake.ts` holds the synthetic rulebook and checks.
- `drizzle/0009_idempotency_and_one_live_read.sql` adds `idempotency_keys` and the one-live-read index on `jobs` (first failing an older live read of a version beside a newer one, so the index can be built).
- `src/jobs.ts` holds the pg-boss queues `identify` and `extract` with their handlers, `stranded` (pg-boss's dead letters) and `maintenance`.
- `src/lib/idempotency.ts` holds `write()`: one transaction per write, with its Idempotency-Key.
- `src/review.ts` holds the review queue: the questions built after a read, how an answer is checked, and blind-entry masking.
- `src/domain.ts` holds DTO mapping, the study-status derivation, the draft guard, and carrying corrections into amendments.
- `src/lib/pointer.ts` handles JSON-pointer edits. `src/lib/diff.ts` builds the labelled structural diff and value labels.
- `src/routes/*.ts` holds the HTTP routes.

## Review questions (ADR-001)

**After a read** (`runExtract` → `reviewDraft`): every document's text layer is read (`readTextLayer`), each money value is bound to its own spot (`bindEvidence`), and the questions are built (`reviewFromEvidence` plus the rest). The version stores `evidence`, `review` and `pdfCheck` (`{ values, matched }` over the values on text pages; null when no value sits on a text page).

The questions, in order:
1. **Values** (`confirm_value`, blocking): every value in `conflict` (the PDF prints something else there) or `ungrounded` (nothing found), typed blind.
2. **Money terms the master doesn't hold** (`unaccounted`, blocking, from the inventory sweep): bill by hand, not a payment term, or already covered. There is no "add it to the master": nothing can add a value to a read draft, so that pick would drop the term silently.
3. **Contract problems** from `runContractChecks`, one question each, settled by a typed value or a pick (I6), never free text:
   - `GRID_CONFLICT`: pick the governing grid; the pick sets `governingGridId`.
   - `RETROACTIVE_NO_DATE`: type the date; it sets `appliesFrom`.
   - `AMBIGUOUS_TERM` or `REQUIRED_MISSING` on one value: pick from the field's list, or type it (`interpretation` / `confirm_value`, blocking).
   - `MISSING_REFERENCED_DOC`: "upload later" or "doesn't affect billing".
   - The rest (`HEADER_MISMATCH`, visit/per-patient totals, `OVERHEAD_LABEL_MISMATCH`, `DUPLICATE_ITEM`, `UNREADABLE_PAGE`, `REQUIRED_MISSING` without a value): "go ahead as printed". A pick the API can't carry out (remove a grid, bill a duplicate one way) isn't offered; "can't tell" leaves it for the approver, and on a blocker that holds approval.
   - Blocking when the check's severity is `blocker`, and for `AMBIGUOUS_TERM` and `REQUIRED_MISSING` (ADR §6).
   - Not asked: `AI_DISAGREEMENT`, `TEXT_LAYER_MISMATCH`, `LOW_CONFIDENCE` (ADR §4: not evidence; the binder replaces them), and a total that doesn't add up while a number in its grid is being typed (one flag per root cause; per grid for now).
4. **Pages**: a scan page (`image_only` or a scanner's `ocr_layer`) can't be swept, so a person attests it (`SCAN_PAGE`, blocking, I5). A text page with invisible words gets a `HIDDEN_TEXT` question; those words are never evidence.

**Anomalies and review items.** The checks' anomalies are kept on the version as the record of what was found at read time; they are never resolved and don't gate approval. The review items are the workflow and the gate. On a draft, `anomalies` is sent empty while any value is withheld (their messages and details carry the reading).

**Scans** (ADR §3 scan mode): no text layer, so `pdfCheck` is null and every money value on a scan page is typed (`SCAN_VALUE`), with one exception. A grid value is `confirmed` by the contract's own totals when they agree **to the cent**: the visit's parts add up to its total and its cells to its subtotals, a per-patient total is the sum of every visit, and a unit price equals a checked cell of its row. `DocumentDto.text` is `"scan"`, and the web asks for the e-signed original.

**Answering** (`answer`, mirrors the sample server's `answer()`):
- A typed value is compared with the PDF's text at its spot (`evidence.printed`, parsed as the web's `parseAnswer` does), or, where nothing parseable is printed, with the value we hold. Same → `matched`; else `differs`, and `compare = { typed, read, printed }` is filled for that item only.
- Answering a `differs` item settles it as `chosen`, and needs a note:
  - Where the PDF's text has the value: only to keep your own value over it (`400 "Add a short note saying why the PDF text is wrong here."`).
  - Where it prints nothing parseable (a scan, a value the check didn't find, a by-hand re-type, a yes/no or fixed-list pick): with either value, saying where the page prints it (`400 "Add a short note saying where the page prints this value. The PDF's text can't confirm it, so the approver relies on your note."`). The answer is marked `noPdfText: true`, and the approval page flags it "Not in the PDF text" with the value, the note and who answered.
- Options are `chosen`; `cantTell` leaves it for the approver (a blocking one still holds approval).
- A settled answer writes its value into the master (validated against the schema first; a value that can't go there is a 400), marks the evidence `attested`, and adds the person to `editors`. Answering again re-checks it (`review.changed`).
- The re-type of a by-hand value must be by someone who didn't type it (409), and doesn't add to `editors`.
- Status codes: 409 not a draft, 404 unknown question, 400 no `by` / no value / not an option / doesn't fit, 409 typist re-typing.

**"This looks wrong"** (`report`): only a single value (400 for an item or a section). On a draft (not by hand), a blocking blind question (`reason: "reported"`); 409 if the value already has an open one. On the live version, a correction draft: a copy of it (evidence and all, editors and questions empty) plus the question; the live version stays live until the draft is approved. 409 when a newer version exists. Logged as `number.reported` / `value.reported`, and the copy as `version.correction_opened`.

**Proofreading** stores `{ path, by, at }` marks, one per value, the latest. Any version with a master, signed ones too, never superseded (409). It never changes the numbers.

**Send back**: reopens answered questions (`outcome`, `answer`, `compare` cleared; `sentBack = { by, note, at }`), turns their `attested` evidence back to `conflict`, and raises a `sent_back` alert with the count and note (its numbers always blanked: everyone sees every alert). The log entry names the questions (`itemIds`). `refreshStudyStatus(…, { alert: false })` so the move back to Needs you doesn't also raise `questions_ready`. An unanswered or unknown question is a 400.

**Typing by hand**: `versions/by-hand` starts a blank draft (one empty budget grid, as the web's `blankRulebook`), replacing a failed version in place; 409 while a draft or a read is in progress. `PATCH .../values` types one value: every typed value is `attested`; removing one row or visit moves the evidence of the ones below; the master must stay valid (400). Values only on by-hand drafts, and only until `by-hand/done`, which picks up to 10 typed numbers and texts at random for someone else to re-type blind. Until then the draft counts as one thing that needs you.

**Sign-off gate** (I1–I6): 409 unless the version is a draft; typing by hand is marked done; no blocking question is unsettled; every evidence entry is `confirmed` or `attested`; and, with maker-checker on, the signer isn't in `editors`.

**Blind entry**: on a draft, every value with an open question is withheld from every response:
- `GET .../versions/:v` (and every write that returns a version): the value is null in the master, the quote of the item that holds it is dropped (a rule's quote prints its number), its evidence `printed` is null, `anomalies` is empty, and `compare` exists only after an answer differs. Item- and section-level paths (a grid header, a referenced document) aren't values and stay.
- `GET .../search`: an amount, or a term's words, never find an item holding a hidden value (as the sample server); names and codes still do.
- `GET .../diff`: both sides masked, and entries at a hidden path dropped.
- `GET /audit`: `before` / `after` of an entry about a hidden path (an earlier answer, a typed or carried value) are left out until the question is settled. `q` is matched in SQL, then against what's shown, so a withheld or blanked number never finds an entry (a page can then hold fewer than `limit`).
- **Notes** ("This looks wrong", send-back, an answer's note, a carried correction's) about a value whose question is open have their numbers blanked by `blankNumbers` (`@dct/shared`): in the version (`answer.note`, `sentBack.note`, and a contract problem's wording) and in the log. Once the question is settled the full note is shown. Blanked: amounts, percentages, counts and durations, every bare number, dates (and month names), numbers in words. Kept: numbers after page, §, section, clause, exhibit, attachment, schedule, amendment, table, row, line, column, item, visit, week, version or code (unless a unit follows), and codes that start with letters (V2, NWP-418-02; not Net45 or USD100).
- The export is approved versions only, and `GET /search` searches live versions only, so neither ever holds one.

**`needs_you`** is computed in `refreshStudyStatus` only, as the web's `needsYou()`: questions with no outcome, `differs`, or a blocking `cant_tell`; a by-hand draft still being typed counts 1.

## Writes: idempotency and atomicity

**`Idempotency-Key`** (IETF `draft-ietf-httpapi-idempotency-key-header`, Stripe's design; `src/lib/idempotency.ts`). Every POST and PATCH takes the header, as a structured-field string (`"…"`, what the web sends) or a bare token, 1–255 printable characters (else 400). The web sends a fresh UUID for each user action and the same one on its retries (`apps/web/src/lib/api.ts`).
- The write runs in one transaction, and the key, a fingerprint of the request (sha256 of method, URL and body; for an upload, its `by` and each file's name and sha256) and the response are saved **in that same transaction**: the write and its saved response commit together or not at all.
- Same key, same request: the saved response, byte for byte, with `Idempotent-Replayed: true`; nothing is written.
- Same key, different request: 422 "This Idempotency-Key was already used for a different request. Send a new key for each new action."
- Same key while the first is still running (a double click): the second waits on the key's advisory lock, then gets the first one's response. 409 "This request is still being processed…" if that takes longer than `DB_LOCK_TIMEOUT_MS`.
- A request that fails saves nothing (it changed nothing), so the same key runs it again once the problem is fixed, as Stripe's v2 does.
- Saved responses are replayed for 24 hours, then deleted by maintenance; a key used after that runs as a new request. They're the masked responses that were sent (blind entry), kept in the same database as the versions.
- The header is optional: without it a write is applied each time it's sent, protected only by the natural rules below.

| Write | Sent twice without a key | With a key |
|---|---|---|
| POST `/uploads` | deduplicated by sha256 (no second row, file or log entry), but answered `duplicateOf` itself | the first answer (`duplicateOf: null`) |
| PATCH `/documents/:id` | the same kind again is a no-op (no log entry) | replayed |
| POST `/studies` | deduplicated by file set while the study is setting up (advisory lock); a second study once it has moved on | replayed |
| PATCH `/studies/:id` | a second `study.confirmed` entry | replayed |
| POST `/studies/:id/extract` | while reading, the same job; after a failed read, **a second paid read** | replayed |
| POST `/studies/:id/versions/by-hand` | 409 "already in progress" (the first answer is lost) | replayed |
| PATCH `…/values` | the same value by the same typist is a no-op | replayed |
| POST `…/by-hand/done` | 409 "already marked done" | replayed |
| POST `…/review/:itemId` | **answered again**: an answer that came back "differs", sent again, settles as chosen | replayed |
| POST `…/report` | 409 (an open question already; on the live version, the correction draft is in progress) | replayed |
| POST `…/proofread` | marks already there by the same person: no-op | replayed |
| POST `…/send-back` | 409 "Only answered questions can be sent back." | replayed |
| POST `…/sign-off` | 409 "signed and immutable" | replayed |
| POST `/alerts/read` | no-op (`ON CONFLICT DO NOTHING`) | replayed |
| PATCH `/settings` | the same settings again: no-op (no log entry) | replayed |
| GET `…/export.xlsx` | each download is logged: it's an event of its own | not taken (GET) |
| jobs `identify`, `extract` | run once (Jobs, below) | — |

**Atomicity.** Everything one write changes is one transaction: the version, the study's status and needs-you count (`refreshStudyStatus`), the alert its stage change raises, its audit entries, its job and pg-boss job, and its saved response. Tests make the last insert fail (a trigger that raises) and check nothing was left: no status change without its log entry, no alert without its transition, no job row without its queued job, no file without its row (`test/atomicity.test.ts`). A job's result is one transaction too: a read whose completion fails ends `failed` with its log entry and alert, never a draft without them.

**Lock order.** Every write to a study locks it first (`lockStudy`, `SELECT … FOR NO KEY UPDATE`; `loadVersion(…, true)` does it), then its job's row, then its versions. Before, version routes locked the version and then the study while `POST /extract` and typing by hand locked the study and then the version: "This looks wrong" on a failed version at the same moment as reading it again deadlocked (reproduced; now tested). `NO KEY UPDATE`, not `FOR UPDATE`, so rows that only reference the study (audit entries, alerts) never wait for it. An idempotency key's lock comes before all of these.

## Running in production

- **Build**: `tsup` bundles `src/server.ts` and `src/db/migrate.ts` into `apps/api/dist`, with `@dct/shared` and `@dct/extraction` (TypeScript source) inlined, and their own dependencies with them (pnpm doesn't make those resolvable from `apps/api`). A banner defines `require` for the bundled CommonJS ones: without it exceljs failed at startup ("Dynamic require of "crypto" is not supported"), so the old build never ran. The mupdf worker isn't bundled and needs no build step: `@dct/extraction` resolves `mupdf-worker.mjs` through its own package exports, and mupdf from there (checked: the built server reads text layers and renders pages). Paths (`.env`, the migrations) are found by walking up from the running file, so they're the same from `src`, `dist` and any chunk.
- **Migrations are a separate step**, run before the new version starts (`node dist/db/migrate.js`), never on boot: on boot, every instance would race to run DDL, a slow migration would hold up readiness, a failed one would crash-loop the server, and the server would need DDL rights it otherwise doesn't. The migrator holds an advisory lock, so two runs at once apply each migration once. A server started on a database that's behind logs an error and stays not ready (`/readyz` `schema: "behind"`); it doesn't run maintenance on tables it doesn't know. pg-boss creates and upgrades its own `pgboss` schema at start, under its own lock, as it's designed to.
- **Shutdown** on SIGTERM or SIGINT: Fastify stops taking requests (new ones and `/readyz` get 503) and waits for the ones in flight, then pg-boss stops (up to 10 s for a running job), then the pool closes. Past `SHUTDOWN_TIMEOUT_MS` (30 s), or on a second signal, it exits anyway.
- **Logs**: JSON lines (pino) at `LOG_LEVEL`, each with its request's id (`reqId`, a UUID, also sent as `X-Request-Id`). Still the method and the route pattern only: no bodies, ids, query strings, contract text or amounts. Jobs and pg-boss log through the same logger.
- **Limits**: `REQUEST_TIMEOUT_MS` (120 s) for a whole request and an idle socket, `KEEP_ALIVE_TIMEOUT_MS` (72 s), 1 MB JSON bodies. Database: `DB_POOL_MAX` (10) connections for the API and `JOBS_DB_POOL_MAX` (5) for pg-boss; each API connection has `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`, 30 s), `lock_timeout` (`DB_LOCK_TIMEOUT_MS`, 10 s) and a 60 s `idle_in_transaction_session_timeout`, and waiting for a free connection gives up after 10 s. An idle connection the database drops is logged and replaced (without a listener it would have crashed the process).

## Decisions

- **Study status is derived from versions** (`refreshStudyStatus`) after every version change, so it can't drift:
  - no versions → `setting_up`
  - latest version `extracting` / `failed` / `draft` → `extracting` / `extraction_failed` / `needs_review`
  - the same three states while an earlier version is live → `amendment_in_review`
  - latest version `signed` → `live`

  A failed amendment extraction therefore shows `amendment_in_review`, and its version is `failed`.
- **Jobs** (`src/jobs.ts`, pg-boss queues `identify`, `extract`, `stranded`, `maintenance`):
  - Our `jobs` row id is the pg-boss job id. It holds state, progress and step for `GET /jobs/:id`.
  - **Queued in one transaction**: the row and its pg-boss job are inserted in the request's own transaction (`queueJob`, pg-boss `send` with `fromDrizzle(tx)`), so a job row is never left "queued" with nothing to run it. Before, the job was sent after the commit, and a server stopping in between left a study setting up, or a read extracting, for ever.
  - **Runs once**: `extract` claims its row (`queued` → `running`) in one conditional UPDATE, so a second delivery of the same job, at once or later, does nothing: one AI read paid for. `identify` may run again after a crash (it's cheap), but only one run writes: its result's transaction locks the row and goes on only while the job is still live. A read's result is written only while its job is still `running`, so a read declared dead meanwhile (below) is dropped, never written over the failure.
  - **At most one live read per version**, by the database too: a partial unique index on `jobs (study_id, version)` for `extract` jobs `queued` or `running` (migration 0009).
  - **Retries**: `identify` 2, 5 s apart (crashes). `extract` 0: each try pays for AI reads, so a read that failed is read again only when a person asks (`POST /extract` reuses its version). An extraction error marks the version `failed` with plain words and the technical detail.
  - **A job whose server died is failed, never left running**: workers heartbeat every 30 s (`heartbeatSeconds: 60`); pg-boss's supervisor (every minute) fails a job that missed its heartbeats, or that ran past `expireInSeconds` (identify 15 min, extract 2 h), and copies it to the `stranded` dead-letter queue. Its worker marks our row failed (`recover`) and, for a read, the version too, with the study's status, the "couldn't read" alert and an `extraction.failed` entry, in one transaction: "The server stopped while reading this contract, so the reading didn't finish. Read it again, or type it in by hand." (or "took more than two hours"), detail `pg-boss: job heartbeat timeout`. A crash is found within a minute or two of the next start.
  - **Maintenance** (`maintain`, at startup before any job runs, then every 10 minutes): a live row whose pg-boss job has ended or is gone is failed the same way (the backstop for a stranded job that couldn't be handled, and for jobs from before queueing was transactional), and so is a version `extracting` with no live job. It also deletes idempotency keys older than a day.
  - On SIGTERM, pg-boss gets up to 10 s to let a running job finish; one still running is failed by pg-boss into `stranded`, so the next start marks it.
  - A handler that throws gives pg-boss a plain error (the database error's code, never its SQL or values), since pg-boss stores it and copies it into the stranded job.
  - NOTIFY wakes a worker as soon as a job is sent; a 1 s backstop poll keeps a backlog moving (pg-boss's 30 s default would start one job of a backlog every 30 s).
  - Settled jobs are deleted by pg-boss after 7 days (its default); our `jobs` table is the lasting record.
  - `POST /extract` on a failed version reuses the same version number, so a retry never creates a duplicate; while a version is extracting it returns the same job; while a draft exists, 409.
- **Signed is immutable twice over:**
  - The API returns 409 on any write to a version that isn't a draft (proofreading aside).
  - A DB trigger refuses changes to signed/superseded rows, now including `evidence`, `review`, `pdf_check` and `by_hand`. The only changes it allows are `signed → superseded` and `proofread`.
  - The previous live version becomes superseded in the same transaction as the new sign-off.
- **Audit log is append-only by trigger.** Every write that changes something writes an entry (a write that changes nothing, such as the same settings again, logs nothing), in the same transaction as the change. Uploads, study creation and job results use `by: "system"` unless a `by` is given.
- **Upload text detection:** after the PDF is stored, its text layer is read: `text` when any page has real text, else `scan`; null when mupdf can't open it (the read then fails with the reason). Files uploaded before this stay null ("not known yet").
- **Diff:**
  - Items in rulebook arrays are matched by identity (id, then code, name, label, kind, description), not by index.
  - `prov` subtrees are ignored, and `{value, prov}` collapses to the value.
  - Labels read section first with ` › ` separators, e.g. `Invoiceable › Unscheduled visit › Amount with overhead` (the web groups by the first part). The same labels name values in "This looks wrong" questions (`labelFor`).
  - `before` is the `against` version.
- **Uploads:**
  - Only PDFs are accepted: the `%PDF-` magic must be present and pdf-lib must load the file. Otherwise the response is 415 or 400.
  - The size limit is 50 MB (413 above it), and 100 pages per PDF (422 with what to do; the reading's own limit).
  - All of a request's files or none. Each is staged as `<UPLOAD_DIR>/<sha256>.pdf.<uuid>.tmp`, flushed to disk (fsync), and its text layer read from there. Then one transaction locks each file's sha256 (advisory lock), inserts the rows and audit entries, saves the response for its idempotency key, and, last, renames each staged file to `<sha256>.pdf` and flushes the folder. A failure before the commit removes any file it put in place, so a failed insert never leaves a file under its final name; the staged files are removed either way.
  - A crash between the rename and the commit can leave `<sha256>.pdf` with no row. It holds exactly those bytes, so the next upload of them takes it over (tested). Nothing deletes files in the upload folder by itself (it holds the contracts).
  - A duplicate returns the existing document with `duplicateOf = existing id`. The original filename is kept.
- **Page images** are cached at `<UPLOAD_DIR>/pages/<sha256>-<n>.png` (`@<dpi>` for the other sizes: a requested DPI is rounded up to 72, 150, 220, 300 or 400). The browser keeps one for an hour (`private, max-age=3600`). A page that takes too long to draw gets 422 and isn't tried again until a restart.
- **mupdf runs in a worker thread** (`packages/extraction/src/mupdf-worker.mjs`): page images, page text and the text layer. A call longer than `RENDER_LIMITS.timeoutMs` (30 s) is stopped and the worker replaced, so a crafted PDF can't freeze the server. At most 8 PDFs stay open.
- `appliesFrom` on a version is `rulebook.appliesFrom.value`, falling back to `study.effectiveDate.value`; answers and typed values keep it current.
- A malformed uuid in a URL returns 400, not 500, and so does a version number over 9 digits (checked once, in a `preValidation` hook). Postgres errors a request causes (`22P02`, `22003`, `22007`, `22008`) are 400 too. A write rolled back by a concurrent one (`40001`, `40P01`, or a lock wait past `DB_LOCK_TIMEOUT_MS`, `55P03`) is 409 "Someone else was changing this at the same moment, so nothing was saved. Try again."
- **A repeat that the state has moved past is a 409**, with what to do: sign-off of a signed version, typing done twice, a second report on a value with an open question, sending back a question that isn't answered (it was 400; an unknown question id stays 400).
- **A server error (5xx) never shows its cause**: the response says "Something went wrong on the server… (ref <request id>)". A database error's message is the SQL with every value bound to it, so the log gets the query and the cause only, never the values. Failed jobs say the same for a database error.
- Request bodies are at most 1 MB (uploads have their own limit). Every response has `X-Content-Type-Options: nosniff`, and JSON is `Cache-Control: no-store`. The request log is the method and the route pattern: no ids, query strings or bodies.
- **Study details lock once a version is approved**: `PATCH /studies/:id` returns 409. The export is named and headed from the approved version's own study details, never the editable study row.
- **No login yet: this computer only** (user decision 2026-10-28). The API listens on 127.0.0.1 (`config.listenHost`) and the web app should too (`next dev -H 127.0.0.1`). Every `by` is the name someone picked, so anyone who can reach the app can approve as anyone, mark alerts read for anyone, and turn maker-checker off. **Before it listens anywhere else, or more than one person uses it, add login** and take `by` from the session.
- **Host/Origin guard**. It is an `onRequest` hook in `src/app.ts`, so `fastify.inject` tests exercise it.
  - Any request whose `Host` is not in `ALLOWED_HOSTS` gets 403 (DNS rebinding), and so does one whose `X-Forwarded-Host` isn't: the Next proxy always sends the API's own Host and moves the browser's there, so without it a rebinding attack on the web port would read everything. The default allows `localhost` and `127.0.0.1` on port 4100 and on port 3100.
  - A POST, PATCH, PUT or DELETE whose `Origin` is present but not in `ALLOWED_ORIGINS` gets 403 (CSRF). The default allows `http://localhost:3100` and `http://127.0.0.1:3100`, and `Origin: null` is rejected.
  - A request with no `Origin` passes (curl, server-to-server).
  - Both lists are comma-separated env vars.
- No CORS is set. The web app proxies `/api` with a Next rewrite to the API.
- **Migration `0007`** indexes `audit_log (study_id, id)` for one contract's log, paged newest first. `GET /audit` pages by id (keyset cursor, as `/studies` and `/alerts`); `q` is an ILIKE over the person, the action (its code or its `ACTION_LABELS` name) and every text and number in the details.
- **Migration `0006`** locks a signed or superseded version as a whole row: only signed → superseded, `updated_at` and `proofread` may change, and it can't be deleted (0005's trigger listed columns, so `version`, `study_id`, `sign_note` and the rest could still change).
- The `extract` queue never retries (each try pays for AI reads; a crashed read is failed in plain words and read again from the contract page) and a read may run 2 hours. `identify` keeps 2 retries.
- **Migration `0005`** marks every draft that existed before it `failed` ("Read before every number was checked against the PDF. Read it again."): it has no questions, so it would have gone straight to approval unchecked. The contract page then offers "Read it again" or typing it in by hand.

## Added at integration testing

- **Amendment extraction carries the live version's corrections forward** (`runExtract`, only when a signed version exists). The amendment's values win; the live version's corrections fill in where it didn't change anything, and the result is checked against the PDF like any read:
  - **Values: replayed from the audit log**, not stored on the version. `correctionsOf(live)` = what the live version carried at extraction (`version.corrections_carried`) + what a draft inherited by copying a live version (`version.manual_created` / `version.correction_opened` with `seededFromVersion` → recurse) + its answers that wrote a value (`review.answered` / `review.changed` with `after`) + `value.corrected` entries from before review questions existed, oldest first. So corrections carry transitively v1 → v2 → v3.
  - Each correction applies only if the new read's value at its pointer deep-equals the correction's `before`, **and** the array items on the path have the same identity as when it was made (`items`, e.g. `["g2","V2"]`). Applied values get `prov.method = "manual"`; carried corrections don't add editors.
  - Skipped with a reason: `amendment_changed`, `item_moved`, `path_missing`, `invalid`, `already_equal`.
  - **Grid:** the live governing grid is matched in the new read by `label` + `arm`; its id becomes `governingGridId` (a grid pick is logged as `gridId`, not as a value, so only this carries it).
  - Answers to contract-problem questions are not carried: the amendment asks them again.
  - One audit entry `version.corrections_carried` `{ version, from, carried[], skipped[] (with reason), grid: {from, to} }`.
- `POST /studies` with a file set that a `setting_up` study already has returns that study (double-click safe).
- `GET /audit` is newest first.
- Fake mode renders real page images and reads the real text layer; a filename containing `unreadable` makes the fake extraction fail. The fake read cites page 1 (terms) and page 2 (grids) of the first document; `apps/api/test/helpers.ts` `makeTextPdf` prints a matching born-digital work order.

## Known gaps

- A yes/no or fixed-list answer is compared with the value held, like a typed one (re-type, "This looks wrong"): a different pick `differs`, a second pick settles it. The sample server in `apps/web` still has them `chosen`.
- The sample server (`apps/web/src/lib/mock/server.ts`) still answers 400 to sending back a question that isn't answered (the API: 409), and keeps idempotency keys in memory only.
- Arithmetic questions are suppressed per grid, not per visit.

## Proposed changes to `packages/shared` (not made)

1. **`RulebookVersionDto.carried`** = `{ from: number; values: number; skipped: number } | null`, so the review can say "12 corrections from v1 carried, 2 need a look" without reading the audit log. Today it is only in the `version.corrections_carried` audit entry.
2. (Done, as a check instead of a field.) `RulebookVersionDto` takes null at each withheld path, the open questions' paths on a draft (`withheldPaths` in `@dct/shared`), and nowhere else: everything else must still be a valid Rulebook.
