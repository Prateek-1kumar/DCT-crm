# Phase 1 · Integration testing (api + extraction + web together)

Run against the real API (Postgres in Apple `container`, pg-boss jobs), the web in real-API mode (`dev:api`, `/api` rewrite), and `EXTRACTION_FAKE=1`, which now fakes **only the AI**: page images are rendered from the uploaded PDFs by `@dct/extraction`.

## How to run the e2e journey

```sh
apps/api/scripts/db.sh start          # also creates dct_finance_e2e
pnpm install                          # @playwright/test is a root dev dependency; uses the installed Google Chrome
pnpm e2e                              # synthetic, browser-printed PDFs
DCT_ROOT=/Users/prateekkumar/dct-finance pnpm e2e   # from a worktree: also uploads two real contracts from data/contracts
```

- `playwright.config.ts` starts the API on :4100 (`EXTRACTION_FAKE=1`, database `dct_finance_e2e`, upload dir `$TMPDIR/dct-e2e-uploads`, both wiped by `apps/api/scripts/e2e-reset.ts`, which refuses any database not ending in `_e2e`) and `pnpm --filter web dev:api` on :3100. Ports 3100/4100 must be free.
- Other browser: `PW_CHANNEL=chromium` after `pnpm exec playwright install chromium`.
- The test fails on any browser console error, page error or API 5xx.

## What `e2e/journey.spec.ts` covers

People in settings → upload 2 PDFs (real contracts, one over 10 MB) + the same file again → double-click "Identify" (one study) → refresh on the confirm step → confirm → progress → review with a real page image → click a grid value jumps to p.2 → inline edit: text in a money field refused, empty note refused, saved → refresh keeps it → sign-off locked with reasons → **Fix value** (VISIT_TOTAL_MISMATCH) → **Choose reading** (AI_DISAGREEMENT, empty choice refused) → **Compare & choose grid** (GRID_CONFLICT) → **Accept with note** (empty note refused, double-click saves once) → sign off (double-click) → browser back shows the signed version read-only → amendment upload (+ duplicate of a stored file, kind fixed to Amendment) → diff-only review, v1 still live → settle and sign v2 → v1 superseded → audit log newest first, each double-clicked action logged once → page image URLs with page 0 / past the end / 9999 / `abc` → 404, bad uuid → 400 → `.txt`, fake `.pdf` and a 51 MB file rejected with readable messages → failed amendment extraction → study page offers retry / **Enter manually** (seeded from live v2) → failed new-study extraction → refresh → Enter manually (double-click) → manual correction → maker-checker on blocks the corrector, another person signs.

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

- **Amendment re-extraction drops v1's human corrections.** Extract re-reads all documents; values corrected or chosen in v1 (and the governing grid) come back as the AI read them and show up in the v2 diff as "changes" that have to be noticed and re-corrected. Visible, not silent. Needs a product decision: carry v1 corrections forward, or extract only the amendment and merge.
- Fake mode: the API fixture ignores the uploaded content and its checks are simplified; a manual blank draft gets no anomalies in fake mode (real checks would add REQUIRED_MISSING etc.). Fake anomaly messages print raw cents.
- Manual entry can't add budget grids, list items or holdback/screen-fail/overpayment blocks in the UI (web.md open issue), so a fully manual contract can only be partly entered.
- Other TanStack-mutation buttons can still double-send (confirm details, extract, enter manually, settings): all are idempotent or return a harmless 409 now, but the confirm PATCH can log `study.confirmed` twice.
- Deadline edit buttons are labelled with the raw enum (`Edit invoice_months_after_study_close N`).
- `renderPage` keeps every opened PDF in memory (mupdf cache, never evicted) — fine for a few studies.
- **Needs the AI keys**: live extraction, real identify (document kinds/study guess from cover pages), real anomaly mix from `runContractChecks` on real reads (HEADER_MISMATCH fix flow, DUPLICATE_ITEM, UNREADABLE_PAGE with page refs), cost recording, and extraction time/progress on 12–24-page scans were not exercised end to end.
