# AGENTS.md

DCT Finance turns clinical-trial site contracts into an approved **rulebook**: every way the site gets paid and every rule that changes money. An AI agent reads the contract; code only **checks** what it wrote (grid arithmetic, quotes on their page, every dollar accounted for); only real decisions reach a person. Users are non-technical accountants.

**The design is the source of truth:** [docs/superpowers/specs/2026-11-05-contract-harness-design.md](docs/superpowers/specs/2026-11-05-contract-harness-design.md). The old layout-specific pipeline (binder, solver, grid reader, money sweep, review questions) was deleted on purpose; don't restore it or copy its logic from git history.

## Non-negotiables

- Never commit, paste or log anything from `data/` (real contracts, answer keys, uploads) or `.env`. Tests and fixtures use synthetic PDFs only.
- Only contract pages go to a model — never patient data. Bank/account numbers are masked before anything is sent: from the text layer on text pages, from local OCR (tesseract.js, never a cloud OCR) on scanned pages. A scanned page OCR reads poorly is still sent with whatever masking OCR allows (owner's decision, 2026-11-05: accuracy first); its low confidence is shown to the accountant.
- **No AI spend without the owner's explicit approval.** Announce every paid run first, with its expected cost and the running total (development test cap: $15 since 2026-11-05, until the owner raises it).
- Never stop the owner's dev servers (web 3100, API 4100) or their Postgres container, and never point a second API at the dev database `dct_finance`. Use other ports and the `_test` / `_e2e` databases.
- Never discard uncommitted changes you didn't make (`git checkout -- .`, `git reset --hard`, `git clean`, `git stash`).
- Live (approved) rulebooks are immutable; every change is a new version.

## Stack and gotchas

- pnpm monorepo, Node ≥ 24: `apps/api` (Fastify 5, Drizzle, Postgres 16, pg-boss), `apps/web` (Next.js 16, TanStack Query), `packages/shared` (zod, money helpers). Money is integer cents (`parseCents`, `parsePercent`).
- Licences: permissive only (MIT, Apache-2.0, BSD). No AGPL/GPL (no MuPDF, no Poppler).
- Postgres runs in Apple `container`, not Docker (`apps/api/scripts/db.sh`). Run the root setup as `pnpm run setup` (`pnpm setup` is pnpm's own command).
- Next.js 16 differs from your training data: read `apps/web/node_modules/next/dist/docs/` before writing web code.
- Drizzle queries run only when awaited; `pnpm lint` catches floating promises.
- Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @dct/api db:generate` and `db:check`. Never edit a committed migration.
- Test databases must end in `_test` / `_e2e`. Never run two API test runs or two e2e runs at once.
- Keep the web's design language (sidebar, pills, current look); light mode only.

## Conventions

- Every user-facing word is plain English for an accountant: what happened and what to do. No codes or stack traces, API errors included.
- Comments explain why, not what.
- "Done" means `pnpm -r typecheck`, `pnpm lint`, `pnpm test` and `pnpm e2e` green; say which you ran.
- Conventional Commits (`feat(api): …`), no `Co-Authored-By` or AI attribution. Commit only when the owner asks.
