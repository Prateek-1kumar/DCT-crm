# Phase 1 · Workstream A · `apps/api`

## Status

Every route in the PHASE-1.md HTTP table is implemented under `/api` and tested (vitest against a real Postgres test database, `fastify.inject`). Extraction runs through a port with a **fake adapter**. The real `@dct/extraction` adapter is wired lazily and is still to be connected at merge.

## How to run

```sh
pnpm install
apps/api/scripts/db.sh start          # Postgres 16 in Apple `container` "dct-postgres", port 5434; creates dct_finance + dct_finance_test
pnpm --filter @dct/api db:migrate     # drizzle migrations (DATABASE_URL from repo-root .env)
EXTRACTION_FAKE=1 pnpm dev:api        # http://127.0.0.1:4100/api
pnpm --filter @dct/api test           # uses dct_finance_test, temp UPLOAD_DIR, fake extraction
pnpm --filter @dct/api typecheck
```

`db.sh stop` stops the container and `db.sh reset` deletes and recreates it. The script only touches `dct-postgres`.

Env: `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` (see the guard below), `DATABASE_URL` (default `postgres://dct:dct@localhost:5434/dct_finance`), `UPLOAD_DIR` (default `<repo>/data/uploads`), `PORT` (4100), `EXTRACTION_FAKE=1`. Env vars that are already set win over `.env`.

## Layout

- `src/db/schema.ts` defines the tables: studies, documents, study_documents, rulebook_versions, jobs, audit_log, settings.
- `drizzle/0000_init.sql` is generated. `drizzle/0001_guards.sql` is custom: an append-only trigger on audit_log, an immutability trigger on signed versions, and the settings row seed.
- `src/extraction/port.ts` holds the `@dct/extraction` interface and adapter selection. `fake.ts` holds the synthetic rulebook and checks.
- `src/jobs.ts` holds the pg-boss queues `identify` and `extract`, with their handlers.
- `src/domain.ts` holds DTO mapping, the study-status derivation, the draft guard, and re-checks.
- `src/lib/pointer.ts` handles JSON-pointer edits. `src/lib/diff.ts` builds the labelled structural diff.
- `src/routes/*.ts` holds the HTTP routes.

## Decisions

- **Study status is derived from versions** (`refreshStudyStatus`) after every version change, so it can't drift:
  - no versions → `setting_up`
  - latest version `extracting` / `failed` / `draft` → `extracting` / `extraction_failed` / `needs_review`
  - the same three states while an earlier version is live → `amendment_in_review`
  - latest version `signed` → `live`

  A failed amendment extraction therefore shows `amendment_in_review`, and its version is `failed`.
- **Jobs:**
  - Our `jobs` row id is the pg-boss job id. It holds state, progress and step for `GET /jobs/:id`.
  - The extract handler acts only on a version still in `extracting`. It fills that version in one conditional UPDATE, so a redelivered job is a no-op.
  - pg-boss `retryLimit: 2` covers crashes.
  - An extraction error marks the version `failed`. It does not auto-retry, because AI calls cost money.
  - `POST /extract` on a failed or stuck version reuses the same version number, so a retry never creates a duplicate.
  - `POST /extract` while a version is extracting returns the same job and re-sends it, which is harmless.
  - `POST /extract` while a draft exists returns 409.
- **Signed is immutable twice over:**
  - The API returns 409 on any write to a version that isn't a draft.
  - A DB trigger refuses changes to signed/superseded rows. The only change it allows is `signed → superseded`.
  - The previous live version becomes superseded in the same transaction as the new sign-off.
- **Audit log is append-only by trigger.** Every mutating route writes an entry. Uploads, study creation and job results use `by: "system"` unless a `by` is given.
- **PATCH values:**
  - It uses an RFC 6901 pointer and replaces or adds the value. The parent must exist, and `__proto__` is refused.
  - The rulebook is re-validated with the shared `Rulebook` schema. An invalid result is rejected with 400.
  - `prov.method = "manual"` is set on the nearest node carrying `prov`: the target, its parent or an ancestor. For example, a grid cell marks its procedure.
  - The editor's name is recorded, and contract checks re-run. Resolutions are kept by anomaly id. An anomaly the change makes disappear stays in the list, resolved with that change (`fixed` + the correction's note; `chosen` for grid choice), so the UI's follow-up resolve call doesn't 404 (integration testing, see testing.md).
- **Grid choice** sets `governingGridId`, re-runs checks, and resolves any unresolved `GRID_CONFLICT` with kind `chosen`. It does not add an editor; only value corrections count for maker-checker.
- **Diff:**
  - Items in rulebook arrays are matched by identity (id, then code, name, label, kind, description), not by index.
  - `prov` subtrees are ignored, and `{value, prov}` collapses to the value.
  - Labels read section first with ` › ` separators, e.g. `Invoiceable › Unscheduled visit › Amount with overhead` (the web groups by the first part).
  - `before` is the `against` version.
- **Uploads:**
  - Only PDFs are accepted: the `%PDF-` magic must be present and pdf-lib must load the file. Otherwise the response is 415 or 400.
  - The size limit is 50 MB (413 above it).
  - Files are written via temp file + rename to `<UPLOAD_DIR>/<sha256>.pdf`.
  - A duplicate returns the existing document with `duplicateOf = existing id`. The original filename is kept.
- **Page images** are cached at `<UPLOAD_DIR>/pages/<sha256>-<n>.png`.
- `appliesFrom` on a version is `rulebook.appliesFrom.value`, falling back to `study.effectiveDate.value`.
- A malformed uuid in a URL returns 400, not 500.
- **Host/Origin guard** (no login yet). It is an `onRequest` hook in `src/app.ts`, so `fastify.inject` tests exercise it. The server still listens on 127.0.0.1.
  - Any request whose `Host` is not in `ALLOWED_HOSTS` gets 403 (DNS rebinding). The default allows `localhost` and `127.0.0.1` on port 4100 and on port 3100, in case the Next proxy forwards the browser's Host.
  - A POST, PATCH, PUT or DELETE whose `Origin` is present but not in `ALLOWED_ORIGINS` gets 403 (CSRF). The default allows `http://localhost:3100` and `http://127.0.0.1:3100`, and `Origin: null` is rejected.
  - A request with no `Origin` passes (curl, server-to-server).
  - Both lists are comma-separated env vars.
- No CORS is set. The web app should proxy `/api` (for example with a Next rewrite to `127.0.0.1:4100`).

## Added at integration testing

- `POST /studies/:id/versions` `{ manual: true, by }` → `{ version }`: manual entry. Blank, schema-valid draft (every value `prov.method = "manual"`, prefilled with the confirmed study details) that replaces a failed version in place; for an amendment, a copy of the live rulebook with `appliesFrom` cleared. 409 while a draft exists or an extraction runs.
- **Amendment extraction carries the live version's corrections forward** (`runExtract`, only when a signed version exists; first extractions and manual drafts are unchanged). The amendment's values win; v1's corrections fill in where it didn't change anything:
  - **Values: replayed from the audit log**, not stored on the version (no schema/shared change). `correctionsOf(live)` = what the live version carried at extraction (`version.corrections_carried`) + what a manual draft inherited (`version.manual_created.seededFromVersion` → recurse) + its own `value.corrected`, oldest first. So corrections carry transitively v1 → v2 → v3.
  - Each correction applies only if the new read's value at its pointer deep-equals the correction's `before`, **and** the array items on the path have the same identity as when it was made (`value.corrected` now logs `items`, e.g. `["g1","V2"]`, from the diff's id/code/name/label matching). Applied values get `prov.method = "manual"`; carried corrections don't add editors (maker-checker counts only corrections made in this version).
  - Skipped with a reason: `amendment_changed` (value differs), `item_moved` (index now points at another item; not re-targeted), `path_missing`, `invalid` (schema), `already_equal` (the new read already has the corrected value).
  - **Grid:** the live governing grid is matched in the new read by `label` + `arm`; its id becomes `governingGridId`.
  - **Resolutions:** after checks, an anomaly with the same id and deep-equal `detail` as a settled live anomaly gets that resolution (same kind/by/at) with note `Carried from vN: <note>`. New or changed anomalies stay open.
  - One audit entry `version.corrections_carried` `{ version, from, carried[], skipped[] (with reason), grid: {from, to}, resolutions[] }`. Not on the version DTO (would need a shared field, proposed below).
  - Carried values equal the live values, so they don't show in the diff; values the amendment changed do.
- `POST /studies` with a file set that a `setting_up` study already has returns that study (double-click safe).
- `GET /audit` is newest first.
- Fake mode renders real page images (`renderPage` from `@dct/extraction`); a filename containing `unreadable` makes the fake extraction fail.

## Stubbed / TODO at merge (done)

- `src/extraction/port.ts` `loadReal()` imports `@dct/extraction` through a variable specifier. At merge:
  1. Add `"@dct/extraction": "workspace:*"` to `apps/api/package.json`.
  2. Switch to a static import.
  3. Add it to `noExternal` in `tsup.config.ts` if it ships TypeScript source.
- The fake adapter returns a fixed COPD-like rulebook (two grids, one wrong visit total, a missing master CTA, and a cross-read disagreement). A filename containing "amend" makes the amended variant used by the diff tests.

## Proposed changes to `packages/shared` (not made)

1. **`ExtractBody`** = `{ documentIds?: string[]; by?: string }` for `POST /studies/:id/extract`. The amendment journey needs a way to add documents to an existing study. It is implemented locally in `routes/studies.ts`.
2. **`by`** on `CreateStudyBody` and on uploads, for audit attribution (`by` is currently accepted as a multipart field). `PATCH /settings` takes a partial `SettingsDto` plus optional `by`.
3. Anomaly ids contain `:` and `/`, so clients must `encodeURIComponent` them in `/anomalies/:aid/resolve`.
4. **`RulebookVersionDto.carried`** = `{ from: number; values: number; skipped: number; resolutions: number } | null`, so the review can say "12 corrections from v1 carried, 2 need a look" without reading the audit log. Today it is only in the `version.corrections_carried` audit entry.
