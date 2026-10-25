# Running DCT AI Finance locally

Needs Node 24, pnpm 10 and Apple `container` (not Docker). Postgres runs in a container named `dct-postgres` on port 5434.

## First time

```bash
cd ~/dct-finance
cp .env.example .env      # then fill in ANTHROPIC_API_KEY, OPENAI_API_KEY (OPENAI_MODEL=gpt-5.5)
pnpm setup                # install, start Postgres, run migrations
```

## Every day

```bash
pnpm dev                  # Postgres + API (http://127.0.0.1:4100) + web (http://localhost:3100), real AI extraction
```

Open http://localhost:3100. Press Ctrl-C to stop both.

| Command | What it does |
|---|---|
| `pnpm dev` | Everything, with real AI extraction (uses the API keys, costs money) |
| `pnpm dev:fake` | Everything, but extraction returns a synthetic result (no AI cost; real page images) |
| `pnpm dev:mock` | Web only, with an in-browser fake API (no database, no backend) |
| `pnpm dev:api` / `pnpm dev:web` | Run one side on its own |
| `pnpm db:start` / `pnpm db:stop` | Start or stop Postgres |
| `pnpm test` | All unit tests |
| `pnpm e2e` | Full browser journey (uses its own `dct_finance_e2e` database) |
| `pnpm eval shah` | Live extraction of one real contract from `data/contracts/`, scored against `data/golden/` (costs money) |
| `pnpm probe` | Cheap check that every AI schema is accepted by the live APIs (a few cents) |

## Models and cost

**Budget: $1 per contract, maximum.** The extraction estimates its cost up front and refuses rather than overspend. Optional re-reads only run while there's budget left.

| Step | Model |
|---|---|
| Page sorting, document identification | Claude Haiku 5.5 |
| Contract terms (3 reads, page images cached) | Claude Sonnet 5.5, medium effort |
| Budget tables | Claude Sonnet 5.5, medium effort; one high-effort re-read only if a few totals don't add up |
| Cross-check of contract terms | Claude Haiku 5.5 (about 1–2 cents). Budget tables are verified by arithmetic instead. |

Estimated cost on the 4 sample contracts: $0.46–0.81 each.

`.env` settings:
- `EXTRACTION_MAX_USD` changes the budget.
- `CROSS_READ=openai|off` switches the second reader. OpenAI costs more than the main read.
- `ANTHROPIC_MODEL` / `ANTHROPIC_FAST_MODEL` change the models.

## Data

Real contracts and exports go in `data/` (git-ignored). Uploaded files are stored in `data/uploads/`. Never commit anything from `data/` or `.env`.
