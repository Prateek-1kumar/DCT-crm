# Phase 1 · Integration testing (api + extraction + web together)

Run against the real API (Postgres in Apple `container`, pg-boss jobs), a **production build** of the web in real-API mode (`/api` rewrite), and `EXTRACTION_FAKE=1`, which fakes **only the AI**: page images, the PDF's text layer and the evidence binder are the real ones from `@dct/extraction`.

## How to run the e2e journey

```sh
apps/api/scripts/db.sh start          # also creates dct_finance_e2e
pnpm install                          # @playwright/test is a root dev dependency; uses the installed Google Chrome
pnpm e2e                              # builds the web, starts both servers, runs e2e/journey.spec.ts
```

- `playwright.config.ts` runs everything on its own ports, so the dev servers on 3100 / 4100 keep running:
  - API on **:4301**, the production build: `pnpm --filter @dct/api build`, then `node dist/server.js` (`start`), so the journey runs on the bundled server, mupdf worker and Excel export included. `EXTRACTION_FAKE=1`, database `dct_finance_e2e`, upload dir `$TMPDIR/dct-e2e-uploads`, both wiped first by `apps/api/scripts/e2e-reset.ts`, which refuses any database not ending in `_e2e`; `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` set for the e2e web port. Playwright waits for `/readyz`.
  - Web on **:3301**: `pnpm --filter web build` with `E2E=1`, which builds into `apps/web/.next-e2e` (the e2e `API_URL` is baked into the proxy at build time, and the dev server's `.next` is left alone), then `next start`. The build is the shipped one: same CSP and headers, no sample server.
  - Ports 3301 / 4301 must be free. Postgres must be running on 5434.
- Other browser: `PW_CHANNEL=chromium` after `pnpm exec playwright install chromium`.
- The test fails on any browser console error (CSP violations included), page error or HTTP 5xx.
- The PDFs are synthetic, printed by the browser: a text PDF whose numbers match the fake reading (fees on page 1, the revised budget grid on page 2), so most numbers are confirmed against the PDF's own text, as with a DocuSign copy. Real contracts are never uploaded.

## What `e2e/journey.spec.ts` covers

Security headers on a page (CSP with `frame-ancestors 'none'` and no `unsafe-eval`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, no `X-Powered-By`) → an unknown address and an unknown contract read as such, with a way back → settings: the name picker opens by itself, people added, a name picked → **add a contract**: upload, text-PDF badge, file kind changed, details filled from the cover pages, refresh keeps the step → **reading** and checking (numbers matched against the PDF) → **answering**, blind, one question at a time, including a **mismatch** (the AI's figure typed, the page asks which one it shows, the PDF text's value picked), a grid choice and a missing-document choice → **proofread** every checked number → **approve**: key terms ticked, initials typed → **live**: tablist by arrow keys, the value drawer by keyboard (Enter opens it with focus, Escape closes it and focus returns to the value) → in-contract **search** and **⌘K** (arrow keys + Enter to a rate, which opens that value) → **export**: the menu by keyboard, the Excel file downloaded (an xlsx), the printable summary in a new tab → **amendment** upload, version 1 stays live → **"This looks wrong"** on live version 1 is refused in words while version 2 is in progress; on the draft, a withheld value shows "Needs you"; reported there it becomes a question → version 2 answered (the reported value typed blind, the rest left for the approver) → the approver **sends one answer back** with a note → **alerts**: another person sees an unread count; the panel by keyboard (focus moves in, Escape returns it to the bell); the "sent back" alert opens that question with the note → **activity**: the audit log (paged, `limit=100`) holds every step, newest first.

Not covered yet: maker-checker, typing a contract in by hand, failed readings, and the audit page's own paging and filters (the run only checks that it opens). Every write the web makes carries an `Idempotency-Key`, so the journey also runs through the API's key handling.

## API suites for writes and jobs (`pnpm --filter @dct/api test`)

- `test/idempotency.test.ts`: every write route sent twice with one key (the read workflow and typing by hand): the same response byte for byte, marked replayed, and no second row, audit entry, alert, job or queued job. A double click (the same request at once, one key): one effect (one answer, one approval, one correction draft, one upload, one paid read). A different request with the key: 422. A malformed key: 400. A failed request saves nothing, so the key runs it again; a key is replayed for a day, then runs as new and is deleted.
- `test/atomicity.test.ts`: a trigger makes the last insert of a write fail (its audit entry, its alert, its saved response); the 500 leaves every version, study, job, queued job, alert and audit entry as it was, and the same key then applies it once. Approval, send back, the last answer, "This looks wrong" on the live version, typing done, creating a study, starting a read, a read's completion, uploads (no file, not even a staged one; a file left with no row is taken over; several files all or none), and concurrent writes to one study that used to deadlock.
- `test/jobs.test.ts`: a read delivered twice at once pays for one AI read and writes once; identify likewise; the database refuses a second live read of a version. A read stopped while running drops its result. Missed heartbeats and a read past two hours: pg-boss fails them into `stranded`, and the live worker marks them failed in plain words. At startup, a job whose queued job is gone, and a read with no job, are failed. Queue settings.
- `test/ops.test.ts`: `/livez`, `/readyz` (and its 503s: schema behind, jobs stopped), `X-Request-Id`, and the settings check (defaults; names every bad setting, never its value).

## Earlier integration notes

The rest of this page is the first integration pass (the anomaly-card review that the question flow replaced); kept for the bugs and decisions it records.

Also checked by hand with curl/screenshots: Host/Origin guard through the Next proxy (Next forwards `Host: localhost:4100` and the browser's `Origin`, both allowed by default), 409 texts, `PATCH /settings` partial + `by`, anomaly ids with `:` and `/` URL-encoded, real contract page counts (pdf-lib and mupdf agree on all 4).

## Bugs found → fix

| # | Bug | Fix |
|---|---|---|
| 1 | Real contracts (~12 MB) failed to upload: Next's proxy cuts bodies at 10 MB → API "Premature close", web 500 | `9f841ea` proxy limit 55 MB, one request per file, >50 MB rejected in the browser |
| 2 | Amendment files never joined the study: web sent `studyId` on upload (API ignores it), extract re-read the old docs | `559fa0c` web sends `ExtractBody.documentIds`; also `by` on create |
| 3 | Fix value / Choose reading showed a 404 after a successful save: the correction cured the anomaly, the re-check dropped it, the follow-up resolve 404'd. Real checks also drop GRID_CONFLICT once a grid is chosen | `28302f3` re-checks keep a vanished anomaly, settled by the change that cleared it |
| 4 | "Enter manually" called a route that didn't exist | `6d96dba` `POST /studies/:id/versions` (decision below) |
| 5 | Fake mode served a 1×1 placeholder for every page | `a4f3857` fake adapter uses the real `renderPage` |
| 6 | Diff labels space-joined raw keys; the web groups by the first ` › ` part, so every entry was its own group | `f0803b4` |
| 7 | Audit log oldest first (UI expects newest first) | `a14dec2` |
| 8 | Fake GRID_CONFLICT pointed at `/governingGridId` (null leaf) so the UI offered a free-text "Fix value" for the grid id; real checks use `/budgetGrids/N` | `fb1621a` (fake grids also cite p.2 so jump-to-page is visible) |
| 9 | Failed amendment extraction: study is `amendment_in_review`, the study page showed no retry / manual entry | `c337765` |
| 10 | Double-clicking "Identify documents" created two studies (TanStack `isPending` disables the button too late) | `74a7feb` API makes create idempotent per file set (advisory lock) |
| 11 | Refresh on the confirm step lost the study (React state only) → orphan `setting_up` study with no way forward; identify failure said "enter the details below" but showed no form | `450764e` study/job in the URL, "Confirm details" link on the study page, form shown on failure |

Item 1 and 9 were confirmed to fail the e2e with the fix reverted.

## Decisions

- **#10 manual entry**: a blank rulebook *is* valid under the schema (empty strings, nulls, `unspecified` enums, empty lists), so the API creates a real draft: every value `prov.method = "manual"`, confidence 1, `crossCheck: "not_checked"`, prefilled with the confirmed study details, then the normal contract checks (real checks give REQUIRED_MISSING for the PI if blank and for the missing budget grid). It replaces a failed version in place (same number, like a retry). For an amendment the draft is a copy of the live rulebook with `appliesFrom` cleared, so the diff review shows only what the person changes. No `packages/shared` change: the body `{ manual: true, by }` is validated locally in `routes/studies.ts` (proposed for shared).
- **#11 fake mode**: only `identifyDocuments` / `extractStudy` are fake; `renderPage` is the real mupdf renderer. The API keeps its own fake fixture and simplified checks (its tests depend on them); they now emit the same paths and detail shapes as the real checks (`{expected, actual}` cents, `{claude, openai}`, `gridIds`).
- **#3**: chose the API side (keep and settle) over "UI skips resolve if gone", so the version keeps a record of every anomaly that was found and how it was settled.
- **#1 upload**: `studyId` on upload was dropped rather than added to the API; `ExtractBody.documentIds` (already in shared) is the contract.
- `packages/shared` untouched.

## Known issues / not fixed

- ~~**Amendment re-extraction drops v1's human corrections.**~~ Fixed: decision was to carry the live version's corrections forward and take only new values from the amendment (api.md, "Amendment extraction carries…"). Still open: a correction whose array index now points at a different item is skipped, not re-targeted to the moved item (listed as `item_moved` in the `version.corrections_carried` audit entry, and the moved item's AI value shows in the diff); the web doesn't show the carried/skipped summary yet (needs the proposed shared field).
- Fake mode: the API fixture ignores the uploaded content and its checks are simplified; a manual blank draft gets no anomalies in fake mode (real checks would add REQUIRED_MISSING etc.). Fake anomaly messages print raw cents.
- Manual entry can't add budget grids, list items or holdback/screen-fail/overpayment blocks in the UI (web.md open issue), so a fully manual contract can only be partly entered.
- Other TanStack-mutation buttons can still double-send (confirm details, extract, enter manually, settings): all are idempotent or return a harmless 409 now, but the confirm PATCH can log `study.confirmed` twice.
- Deadline edit buttons are labelled with the raw enum (`Edit invoice_months_after_study_close N`).
- `renderPage` keeps every opened PDF in memory (mupdf cache, never evicted) — fine for a few studies.
- **Needs the AI keys**: live extraction, real identify (document kinds/study guess from cover pages), real anomaly mix from `runContractChecks` on real reads (HEADER_MISMATCH fix flow, DUPLICATE_ITEM, UNREADABLE_PAGE with page refs), cost recording, and extraction time/progress on 12–24-page scans were not exercised end to end.
