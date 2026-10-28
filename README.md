# DCT Finance

DCT Finance turns the signed sponsor contracts of Discovery Clinical Trials' studies into an approved **invoicing master**: every fee, cap, due day and budget-grid amount the contract sets, each with the page it comes from. An AI reads the contract; then every number is checked against the PDF's own text, and whatever can't be confirmed is typed by a person who doesn't see the AI's answer. Only then can someone approve it. Approved versions are locked, and amendments make new versions.

It's used by DCT's accountants, who aren't technical, so every screen and message is in plain English. One rule shapes the code: **no silent errors**. A wrong number that gets approved costs the client real money, so a value counts as unconfirmed until the PDF or a person confirms it. Phase 1 (contracts) is built; checking billing data against the contracts comes next ([docs/PHASES.md](docs/PHASES.md)).

## Quick start

You need Node 24, pnpm 10, and Apple [`container`](https://github.com/apple/container) (not Docker). Postgres 16 runs in a container named `dct-postgres` on port 5434. Google Chrome is needed only for the browser tests.

### First time

```sh
cp .env.example .env    # fill in ANTHROPIC_API_KEY, or set EXTRACTION_FAKE=1 to read without AI
pnpm run setup          # install, start Postgres, apply the migrations
```

Use `pnpm run setup`: `pnpm setup` runs pnpm's own setup command instead. The migration step checks the API's settings, so it stops with a settings error until `.env` has either `ANTHROPIC_API_KEY` or `EXTRACTION_FAKE=1`.

### Every day

```sh
pnpm dev:fake           # Postgres + API + web; reads are synthetic, no AI cost
pnpm dev                # the same with real AI reads (costs money)
```

Open http://127.0.0.1:3100. Ctrl-C stops the API and the web; Postgres keeps running until `pnpm db:stop`. After pulling a change that adds a migration, run `pnpm --filter @dct/api db:migrate` and restart.

### Sample mode

```sh
pnpm dev:mock           # the web alone, with an in-browser sample server and invented data
```

No database or API is needed. The sample data lives in the browser; Settings → Reset demo data brings it back.

## Commands

| Command | What it does |
|---|---|
| `pnpm run setup` | Install, start Postgres, apply migrations to the dev database |
| `pnpm dev` | Postgres, API on 127.0.0.1:4100 and web on 127.0.0.1:3100, with real AI reads (costs money) |
| `pnpm dev:fake` | The same, with `EXTRACTION_FAKE=1`: synthetic reads; page images, the PDF text checks and the review are real |
| `pnpm dev:mock` | Web only, in sample mode |
| `pnpm dev:api` / `pnpm dev:web` | One side on its own (`dev:web` talks to the real API) |
| `pnpm db:start` / `pnpm db:stop` | Start or stop the Postgres container |
| `pnpm --filter @dct/api db:migrate` | Apply new migrations to the database in `DATABASE_URL` |
| `pnpm test` | Every package's unit tests (the API's need Postgres) |
| `pnpm e2e` | The browser journey on production builds, on its own ports and database |
| `pnpm -r typecheck` · `pnpm --filter web lint` | TypeScript and ESLint |
| `pnpm eval [name]` | Live reads of the real contracts in `data/contracts/`, scored against `data/golden/` (costs money) |
| `pnpm probe` | Checks every AI schema against the live APIs (a few cents) |

Package commands are in each package's `AGENTS.md`. Running a production build: [docs/runbook.md](docs/runbook.md).

## Repo layout

| Path | What's there |
|---|---|
| `apps/api` | Fastify API under `/api/v1`, Postgres through Drizzle, background jobs with pg-boss |
| `apps/web` | Next.js 16 app, and the in-browser sample server |
| `packages/shared` | zod schemas shared by everything: the rulebook, evidence, API bodies and responses |
| `packages/extraction` | PDF text and page images (mupdf), the AI reads, the evidence binder, the contract checks |
| `e2e/` | The Playwright journey (`playwright.config.ts` at the root) |
| `docs/` | Architecture, runbook, security, the phase plans and the ADR |
| `data/` | Git-ignored: real contracts, answer keys, saved reads, uploads |

Real contracts and exports go in `data/`, and uploaded files are stored in `data/uploads/`. Never commit anything from `data/` or `.env`.

## Documentation

- [docs/architecture.md](docs/architecture.md): components, data flow, jobs, study stages, glossary.
- [docs/runbook.md](docs/runbook.md): settings, production build, migrations, health checks, AI models and the spend cap, logs, troubleshooting.
- [docs/security.md](docs/security.md): the threat model and what must change before more than one person uses it.
- [AGENTS.md](AGENTS.md): rules for engineers and coding agents working in this repo.
- [docs/README.md](docs/README.md): every doc, with its status.
