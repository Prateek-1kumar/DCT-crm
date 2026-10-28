# web

The DCT Finance web app (Next.js 16). Design and decisions: `docs/phase-1/web.md`. Running the whole stack: `RUNNING.md`.

| Script | What it does |
|---|---|
| `pnpm --filter web dev` | Sample mode on http://localhost:3100: an in-browser sample server, no API or database |
| `pnpm --filter web dev:api` | Real mode on :3100; `/api/*` is proxied to the API (`API_URL`, default http://localhost:4100) |
| `pnpm --filter web build` | Production build of the real app. Always real mode, even if `NEXT_PUBLIC_API_MOCK` is set in the shell or a `.env` file |
| `pnpm --filter web build:sample` | Production build on sample data, for demos and UI checks. The sidebar says "Sample data only" |
| `pnpm --filter web start` | Serves the last build on http://127.0.0.1:3100 |
| `pnpm --filter web test` · `typecheck` · `lint` | Unit tests, TypeScript, ESLint |

`/design` (the design-system reference) exists in `dev` and sample builds only.
