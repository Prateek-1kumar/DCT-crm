# Phase 1: Contracts

**Goal:** a contract PDF becomes a **checked, signed-off rulebook**. Every later phase relies on it.

## Decisions (agreed 2026-10-25)

| Topic | Decision |
|---|---|
| Users | 4–8 people at DCT. **Everyone can do everything.** No login yet: pick your name from a list when acting. Login must come before any hosting. |
| AI | Claude Opus 5.5 extracts. OpenAI independently re-reads **all amounts and rules**; disagreements become anomalies. |
| Conflicting budget grids | Accountant picks the governing grid, with a note. Sign-off is blocked until chosen. |
| Procedure grid | Extract the full procedure × visit grid now. |
| Missing master agreement | Can go live with a written note; affected terms are marked `unverified`. |
| Unreadable page / failed extraction | Manual entry allowed, tagged `manual`; it still goes through every check. |
| Maker-checker | Setting: a person who corrected values can't sign off. **Off by default.** |
| Workspace | One shared workspace; no role screens yet. |

## User journeys

1. **Bring a study on board.**
   - Drop PDFs.
   - The system sorts them (master / work order / adoption / amendment / budget) and suggests the study (sponsor, protocol, site, PI) from the cover pages.
   - Confirm.
   - Extraction runs in the background with progress shown.
   - Catches: duplicate files (sha256), a file from another study (PI/site mismatch), referenced documents not uploaded.
2. **Review and sign off.**
   - Review queue: oldest first, with anomaly counts.
   - Review screen: contract page on the left, values on the right, anomalies on top. Clicking a value jumps to its page.
   - Each anomaly is settled by **fix value**, **choose**, or **accept with note**.
   - Sign-off is only possible when all anomalies are settled. It records name, time and note.
3. **Amendment.**
   - Upload → new draft version → review **only the diff** → sign off.
   - The old version stays live until the new one is signed.
   - A retroactive amendment with no start date is flagged.
4. **Look up.** Read-only rulebook view per study, with a "show in contract" link on every item, plus version history and the audit log.

## Study status

```
setting_up → extracting → needs_review → live
                 ↓                         ↓
         extraction_failed      amendment_in_review → live (new version)
```

## Architecture rules

- **AI only produces drafts.** Only a human sign-off makes a version live.
- **Signed versions are immutable.** Changes create a new version with `appliesFrom`.
- **Append-only audit log** of every correction, choice, note and sign-off.
- **Extraction jobs are idempotent and retryable.** A crash never leaves a half-written version.
- **AI cost is recorded per extraction** (DCT is charged).
- **Files are stored by sha256.** Duplicates are impossible.
- **Money is integer cents everywhere.**
- **No bank or routing numbers stored.** The schema has no field for them.
- **Patient data never goes to an AI.** Only contracts do.

## Code layout and ownership

| Path | Owner | What |
|---|---|---|
| `packages/shared` | Lead (do not edit; ask) | Rulebook, anomaly and API types (zod). **The contract between workstreams.** |
| `packages/extraction` | Workstream B | PDF → pages → Claude + OpenAI → `Rulebook`; contract checks; scoring |
| `apps/api` | Workstream A | Fastify + Drizzle + Postgres + pg-boss; uploads, versions, anomalies, audit, sign-off |
| `apps/web` | Workstream C | Next.js UI |
| `data/` | git-ignored | Real contracts (`data/contracts`), expected answers (`data/golden/EXPECTED.md`), uploads |

## Interfaces

### `@dct/extraction` (B produces, A consumes)

```ts
identifyDocuments(docs: InputDoc[]): Promise<{
  documentKinds: Record<string, DocumentKind>;
  studyGuess: { sponsor: string | null; protocol: string | null; siteName: string | null; investigator: string | null };
}>

extractStudy(input: {
  documents: InputDoc[];
  onProgress?: (pct: number, step: string) => void;
}): Promise<ExtractionOutput>

runContractChecks(rulebook: Rulebook, opts?: { crossRead?: Rulebook | null }): ContractAnomaly[]

renderPage(pdfPath: string, page: number, dpi?: number): Promise<Buffer>   // PNG, for the page viewer

type InputDoc = { id: string; filename: string; path: string; kind: DocumentKind | null };

type ExtractionOutput = {
  rulebook: Rulebook;            // primary read (Claude)
  crossRead: Rulebook | null;    // second read (OpenAI); null if unavailable
  pages: { documentId: string; page: number; kind: "terms" | "budget_grid" | "invoiceables" | "signatures" | "boilerplate"; readable: boolean }[];
  cost: { provider: "anthropic" | "openai"; model: string; inputTokens: number; outputTokens: number; usd: number }[];
};
```

- **Fake mode:** with `EXTRACTION_FAKE=1`, `identifyDocuments` and `extractStudy` return a synthetic fixture, so the API and UI run without AI keys.
- **Added at integration (2026-10-25):** `ExtractionOutput.notes` (ambiguity / retroactive notes the schema can't hold yet) is stored on the version. `runContractChecks(rulebook, { crossRead, pages, notes })` gets all three on every re-check, so UNREADABLE_PAGE, AMBIGUOUS_TERM and RETROACTIVE_NO_DATE survive corrections.

### HTTP API (A produces, C consumes)

All routes are under `/api/v1` (since 2026-10-28; nothing stays on `/api`). Bodies and responses are the types in `packages/shared/src/api.ts`. The table below is the Phase 1 plan; the routes as built, including the review questions that replaced anomaly resolution, are in `docs/phase-1/api.md`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/uploads` (multipart `files[]`) | Store by sha256 → `DocumentDto[]` (with `duplicateOf`) |
| POST | `/studies` `CreateStudyBody` | Create study from documents; queue identify job → `{ studyId, jobId }` |
| PATCH | `/studies/:id` `ConfirmStudyBody` | Confirm details |
| PATCH | `/documents/:id` `SetDocumentKindBody` | Fix a document's kind |
| POST | `/studies/:id/extract` `ExtractBody` | Queue extraction (optionally add amendment documents) → `{ jobId, version }` |
| GET | `/jobs/:id` | `JobDto` (progress) |
| GET | `/studies` | `StudySummaryDto[]` |
| GET | `/studies/:id` | `StudyDetailDto` |
| GET | `/studies/:id/versions/:v` | `RulebookVersionDto` |
| GET | `/studies/:id/versions/:v/diff?against=:w` | `DiffEntry[]` |
| PATCH | `/studies/:id/versions/:v/values` `CorrectValueBody` | Correct a value (draft only); logged; sets `prov.method = "manual"` |
| POST | `/studies/:id/versions/:v/anomalies/:aid/resolve` `ResolveAnomalyBody` | Settle an anomaly |
| POST | `/studies/:id/versions/:v/grid-choice` `ChooseGridBody` | Set `governingGridId`; resolves `GRID_CONFLICT` |
| POST | `/studies/:id/versions/:v/sign-off` `SignOffBody` | 409 if unresolved anomalies (or maker-checker blocks) |
| GET | `/documents/:id/pages/:n.png` | Page image for the viewer |
| GET | `/audit?studyId=` | `AuditEntryDto[]` |
| GET, PATCH | `/settings` `PatchSettingsBody` | `SettingsDto` (people list, makerChecker) |

**Local ports:** web 3100 · api 4100 · Postgres 5434 (Apple `container`, not Docker).

## Done when

1. All 4 real contracts extract and score high against `data/golden/EXPECTED.md`.
2. Expected anomalies appear:
   - **McAllen:** `GRID_CONFLICT`, `OVERHEAD_LABEL_MISMATCH`
   - **HCWC:** `HEADER_MISMATCH`, `DUPLICATE_ITEM`
   - **Shah:** `RETROACTIVE_NO_DATE`
   - **COPD, HCWC, Shah:** `MISSING_REFERENCED_DOC`
3. The upload → review → correct → resolve → sign off → amend (diff) cycle works end to end in the UI.

## Conventions

- TypeScript strict. Tests with vitest. Every rule and route has a test.
- Commit in small, working steps with Conventional Commit messages (`feat(api): …`). **No `Co-Authored-By` or AI attribution lines.**
- Each workstream keeps a short progress log in `docs/phase-1/<workstream>.md`: what's done, decisions, how to run.
- Secrets only in `.env`. Never commit anything from `data/`.
