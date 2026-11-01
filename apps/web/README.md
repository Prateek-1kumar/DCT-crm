# web

The DCT Finance web app (Next.js 16). Rules and key files: [AGENTS.md](AGENTS.md). Running the whole stack: the [root README](../../README.md).

| Script | What it does |
|---|---|
| `pnpm --filter web dev` | http://127.0.0.1:3100; `/api/*` is proxied to the API (`API_URL`, default http://localhost:4100), which must be running |
| `pnpm --filter web build` | Production build |
| `pnpm --filter web start` | Serves the last build on http://127.0.0.1:3100 |
| `pnpm --filter web test` · `typecheck` · `lint` | Unit tests, TypeScript, ESLint |

`/design` (the design-system reference) exists in `dev` only.
