# Phase 1 · Workstream C: web UI (`apps/web`)

## How to run

```sh
pnpm install
pnpm --filter web dev        # http://localhost:3100, mock mode (NEXT_PUBLIC_API_MOCK=1), no API needed
pnpm --filter web dev:api    # real mode: /api/* is proxied to http://localhost:4100 (override with API_URL=...)
pnpm --filter web test       # vitest
pnpm --filter web typecheck
pnpm --filter web build
```

- **Mock mode** runs the PHASE-1.md HTTP API in the browser (`src/lib/mock/server.ts`) with synthetic data. State is kept in
  `localStorage` (`dct.mockdb.v1`); *Settings → Reset demo data* restores the seed. A file whose name contains `fail` or
  `unreadable` fails its first extraction (to exercise retry / manual entry).
- **Real mode**: `next.config.ts` rewrites `/api/:path*` to `${API_URL ?? "http://localhost:4100"}/api/:path*`.

Seed studies (all invented): Halcyon (live v1 + amendment v2 in review, diff + retroactive-no-date), Northwind (two
conflicting grids, overhead label mismatch, missing master agreement, two AI disagreements, visit total mismatch, low
confidence), Cobalt (two arms, Arm B header mismatch, duplicate item, one anomaly already settled), Meridian (live, clean),
Solace (extraction failed).

## Done

- App shell, design tokens (`src/app/globals.css` `@theme`, light + dark via `prefers-color-scheme`), "Acting as" picker
  (from `GET /settings`, stored in `localStorage` as `dct.actingAs`, sent as `by` on every write). Actions are disabled with an
  explanation when nobody is selected.
- Typed API client `src/lib/api.ts` (types from `@dct/shared`), TanStack Query for all server state (`src/lib/queries.ts`).
- Screens:
  1. **Studies** `/`: review queue (oldest first, open-anomaly counts), table with search + status filter chips, empty state.
  2. **New study** `/studies/new`: drag-and-drop multi-PDF upload, per-document kind chip (PATCH /documents/:id), duplicate
     badge (sha256), identify job progress, suggested details to confirm, start extraction.
  3. **Extraction progress** `/studies/:id/extracting?job=&v=`: polls GET /jobs/:id; on success opens the review; on failure
     Retry or Enter manually.
  4. **Review** `/studies/:id/review[?v=]`: split view. Left: page viewer (document picker, page nav, zoom, arrow keys, "look
     for" callout with location/quote). Right: anomalies panel (grouped by severity; Fix value / Choose reading / Compare &
     choose grid / Accept with note; "n of m settled"), then the rulebook in sections (Study, Payment, Overhead, Budget grids,
     Invoiceables, Screen fail, Site fees, Holdback, Deadlines, Overpayment, Rounding). Every value: click → jumps to its page;
     confidence, cross-check (✓ / ≠), Manual / Unverified tags; inline edit with required note. Budget grid: procedure × visit
     table with sticky header and first column, invoiceable cells marked, footer totals, cell selection bar with edit; tabs when
     there are several grids. Sign-off button in the sticky bar, disabled with the reasons spelled out; sign-off dialog (name +
     optional note) shows API 409 messages verbatim.
  5. **Study** `/studies/:id`: read-only rulebook of the live (or chosen) version with show-in-contract on every value, version
     history, compare any two versions (diff grouped by section: added / changed / removed).
  6. **Amendment** `/studies/:id/amend`: upload into the existing study → extract → the review shows only the diff vs the live
     version (toggle to see the full rulebook).
  7. **Audit log** `/audit[?studyId=]` with study filter and search; **Settings** `/settings`: people editor, maker-checker
     switch with explanation, reset demo data (mock only).
- Tests (`pnpm --filter web test`, 20): money formatting/parsing, editor kinds and input parsing, settle progress and grouping,
  sign-off gating (incl. maker-checker), DiffView rendering, grid differences, and the mock API (every response parses with
  the shared zod schemas; 409 on open anomalies; amendment diff labels).
- Verified end to end in headless Chrome in mock mode: upload (incl. duplicate) → identify → confirm → progress → review →
  choose reading / accept / fix / inline edit → sign off → amendment upload → diff review; settings and audit. No console errors.

## Decisions

- **All pages are client components** inside one `<Suspense>` in the root layout. The app reads URL params and browser state
  (acting-as), and Next 16 `cacheComponents` requires such reads under Suspense. Data is client-fetched via TanStack Query.
- **One money helper** (`src/lib/money.ts`): `formatCents` / `parseDollars` / `centsToInput` use integer and string operations
  only. `formatValue` in `src/lib/format.ts` is the single display path for any rulebook value (money is detected by field name
  `*Cents` or grid `cells`).
- **Corrections address values by JSON pointer** (same form as `ContractAnomaly.path`), e.g. `/payment/netDays/value`,
  `/budgetGrids/0/procedures/3/cells/V2`. The editor is picked from the pointer + value (`inferKind`).
- **Native `<dialog>`** for modals; it closes itself when Next's `<Activity>` hides the route (otherwise a top-layer modal would
  linger). No UI library.
- **"Highlight" = callout**: `SourceRef` has no coordinates, so the viewer jumps to the page and shows the location/quote in a
  highlighted bar above the page (see proposals).
- **Amendment review = diff + anomalies** with an opt-in "Show full rulebook" toggle.

### Dependencies added (apps/web)

- `@tanstack/react-query` (required by the brief), `@dct/shared` (workspace).
- Dev: `vitest`, `@testing-library/react`, `@testing-library/dom`, `jsdom`, `@vitejs/plugin-react`; `typescript` pinned `~5.9.3`.

## Assumptions the API (Workstream A) must match

1. `POST /uploads` multipart: field `files[]`, plus **`by`** and optional **`studyId`** (attach to an existing study, used for
   amendments). Duplicate → returns the existing document with `duplicateOf` set to its id.
2. `POST /studies/:id/extract` accepts an optional JSON body `{ by }`. When the study already has a live version, the new draft
   is an amendment and the study goes `amendment_in_review` (old version stays live).
3. After the identify job succeeds, `GET /studies/:id` returns the suggested sponsor/protocol/site/PI and detected document kinds.
4. `PATCH .../values` takes a JSON pointer to the leaf value (`.../value` for sourced fields) and does **not** auto-resolve
   anomalies. "Fix value" calls PATCH values then `resolve` with `kind: "fixed"` and the same note; "Choose reading" PATCHes
   only if the chosen value differs, then resolves with `kind: "chosen"`.
5. `AI_DISAGREEMENT.detail` has `{ claude, openai }` (raw values). `GRID_CONFLICT.detail.gridIds` lists the two grid ids
   (falls back to the first two grids). `VISIT_TOTAL_MISMATCH.detail` uses `{ expected, actual }` in cents.
6. Error bodies: Fastify style `{ statusCode, error, message }`; the UI shows `message` (409 texts should be human-readable).
7. `PATCH /settings` accepts a partial `SettingsDto` (extra `by` is sent for the audit log). `GET /audit` is newest first.
8. `GET /studies/:id/versions/:v/diff?against=:w` returns entries from `w` to `v`; `label` uses `" › "` separators with the
   section first (the UI groups by the first segment).
9. `editors` lists only people who corrected values (anomaly notes don't count), used for the maker-checker hint.

## Proposed `packages/shared` changes

- `SourceRef.bbox?: { x, y, w, h }` (page-relative 0–1) so the viewer can draw a real highlight box.
- `StudyDetailDto.activeJobId: string | null` so a study page can show live progress after navigating away (now it polls the
  study until it leaves `extracting`).
- Formalize `POST /uploads` fields `by` + `studyId`, and a manual-entry route, e.g. `POST /studies/:id/versions { manual: true, by }`
  → `{ version }` (blank draft, values tagged `manual`); the UI already calls this for "Enter manually".
- Add `by` to the `PATCH /settings` body type.

## Open issues

- Manual entry can't author a budget grid from scratch in the UI (only edit existing values); no add/remove of list items
  (invoiceables, fees, deadlines) or cap editing.
- Removing an uploaded file from an amendment/study isn't possible (no delete route).
- Anomalies aren't re-run client-side after corrections; the UI shows whatever the API returns after each write.
- "File from another study" (PI/site mismatch at upload) isn't surfaced separately; it relies on `HEADER_MISMATCH`.
