<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# apps/web

The only UI: Next.js 16 (App Router, `cacheComponents` with partial prerendering), Tailwind v4, TanStack Query 5. Every page is a client component; data comes from the API through `/api/v1`, or from the in-browser sample server in sample mode. Users are non-technical accountants. Repo rules: [AGENTS.md](../../AGENTS.md). Earlier design notes: [docs/phase-1/web.md](../../docs/phase-1/web.md).

## Key files

| Path | What it holds |
|---|---|
| `src/app/` | Routes: `/` contract list · `/studies/new` add a contract · `/studies/[id]` the contract (overview, tabs, value drawer) · `[id]/reading` reading and check result · `[id]/review` Needs you, one question at a time · `[id]/proofread` · `[id]/approve` · `[id]/amend` · `[id]/print` · `/audit` Activity · `/settings` · `design/page.dev.tsx` (dev and sample builds only) · `error.tsx`, `global-error.tsx`, `not-found.tsx` |
| `src/app/layout.tsx` · `providers.tsx` | One `<Suspense>` around everything (pages read URL params and browser state); the QueryClient |
| `src/lib/api.ts` | The typed client. Every request goes through `request()`: an Idempotency-Key per write, retried with the same key after a lost answer or a 5xx; an identical write still in flight (same method, path and body: a double click) shares that request and key; the switch to the sample server. `exportXlsx` fetches, so a refusal shows on screen |
| `src/lib/queries.ts` | Query keys and hooks, so invalidation stays in one place |
| `src/lib/mock/server.ts` · `fixtures.ts` · `layout.ts` | The sample server, mirroring the API's routes and rules, and masking and asking through the same `@dct/shared` code (`mask`, `blindReview`, `blindDetail`, `questions.ts`); invented seed data, and `mockSampling` (pins its blind sample in tests); where sample pages print each number |
| `src/lib/review.ts` · `proofread.ts` · `approve.ts` · `byhand.ts` | Pipeline steps and "needs you"; proofread units (a report that fails carries on in its draft); the key terms the approver ticks; blank pieces for typing by hand |
| `src/lib/money.ts` · `format.ts` · `pointer.ts` | Integer-cent formatting and parsing; the one display path for a rulebook value; JSON pointers |
| `src/lib/acting-as.ts` · `notify.ts` | The picked name sent as `by` (no login); desktop notifications |
| `src/components/ui.tsx` | Primitives: `Button` (variants and sizes), `Badge`, `Stepper`, `Dialog` and `Sheet` (native `<dialog>`), `errorText`, `ErrorNote`, `LoadError`, `PageTitle` |
| `src/components/` | `Workspace` and `RulebookView` (the master and its drawer), `Rechecked` (live values the newest draft asks again), `PageViewer` and `SpotView` (contract pages and close-ups), `GridTable`, `Sidebar`, `Alerts`, `CommandPalette` (⌘K), `UploadDocs`, `ByHandForm` (a failed save marked on its own field) |
| `next.config.ts` | CSP and security headers, the `/api` rewrite to `API_URL`, the sample flag, `distDir` for the e2e build |
| `src/instrumentation-client.ts` | zod `jitless`, so the CSP needs no `eval` |

## Commands

| Command | Does |
|---|---|
| `pnpm --filter web dev` | Sample mode on 127.0.0.1:3100, no API or database |
| `pnpm --filter web dev:api` | Real mode on 127.0.0.1:3100, `/api/*` proxied to `API_URL` (default `http://localhost:4100`) |
| `pnpm --filter web build` | The real app. Always real mode, whatever `NEXT_PUBLIC_API_MOCK` says |
| `pnpm --filter web build:sample` | A production build on sample data, for demos and UI checks |
| `pnpm --filter web start` | Serves the last build on 127.0.0.1:3100 |
| `pnpm --filter web test` · `typecheck` · `lint` | vitest (jsdom), `next typegen && tsc --noEmit`, ESLint |

## Rules

- Plain English everywhere, for accountants. Show errors only through `errorText()`; never a raw error, a status code or a stack.
- Every API call goes through `src/lib/api.ts`. One user action is one write with one key: never retry a write with a new key.
- Every write carries `by`, the name picked in "Who's working today?" (`src/lib/acting-as.ts`; no login yet). Where an action needs a name and none is picked, show `NeedsPerson` (`src/components/Sidebar.tsx`) next to it, as the other screens do.
- Blind entry: never show, search or hint at a withheld value. The server withholds it; the UI masks the same paths (`withheldPaths` from `@dct/shared`).
- Approval sends `asOf: version.updatedAt`, the version as shown; the approve page refetches it, and the API refuses (409) if it changed since.
- Money is integer cents: use `src/lib/money.ts` to format and parse, `formatValue` in `src/lib/format.ts` to display. No float math on amounts.
- Light mode only (`color-scheme: light` in `globals.css`).
- Keep the sample server in parity with the API (routes, status codes, messages, rules). A real build must never bundle it: reach it only by dynamic import behind `MOCK` or an inlined `process.env.NEXT_PUBLIC_API_MOCK === "1"` check.
- Keyboard and screen-reader paths matter: native `<dialog>`, focus moves in and returns, Escape closes. The e2e walks them.

## Pitfalls

- Next.js 16 is not the Next.js you know: read `node_modules/next/dist/docs/` first (block above). Pages that read URL params or browser state must stay under the root `<Suspense>` (`cacheComponents`).
- The CSP is static (partial prerendering can't use nonces): `connect-src 'self'`, `img-src 'self' data: blob:`, no `unsafe-eval` in production. An external script, font, image or API call won't load until the CSP in `next.config.ts` allows it; the e2e fails on any CSP violation.
- Tailwind v4 through `@tailwindcss/turbopack` drops `@layer base` wrappers, so element defaults in `globals.css` beat utility classes. Keep them to properties no component sets, and size components through their props (`Button size`), not override classes.
- `*.dev.tsx` pages exist only in dev and sample builds (`pageExtensions`).
- `API_URL` is baked into the rewrite at build time. The e2e build (`E2E=1`) goes to `.next-e2e` with its own `API_URL`.
- Only one `next dev` can run here, and the owner's is usually on 3100. Check a change with `pnpm --filter web build:sample && pnpm --filter web exec next start -H 127.0.0.1 -p 3200`, then stop it.
- After an e2e build, `next-env.d.ts` may point at `.next-e2e`; use `pnpm --filter web typecheck` (it runs `next typegen` first) rather than bare `tsc`.
- The Next proxy allows request bodies up to 55 MB (`proxyClientMaxBodySize`), just above the API's 50 MB per file; uploads go one file per request. It waits 125 s for the API (`proxyTimeout`; Next's default is 30 s), just above the API's 120 s `REQUEST_TIMEOUT_MS`.

## Testing

- `pnpm --filter web test` runs every `src/**/*.test.{ts,tsx}`: `src/lib/*.test.ts` (money, review, proofread, approve, the API client's retries and shared in-flight writes), `src/lib/mock/server.test.ts` (every sample response parses with the shared schemas; the sample server's rules), `src/components/*.test.tsx` (components, `ByHandForm`, `SpotView`, `UploadDocs`), and pages next to their routes: `src/app/audit/audit.test.tsx`, `src/app/studies/[id]/contract.test.tsx`, `src/app/studies/[id]/review/review.test.tsx`.
- `pnpm e2e` from the repo root runs `e2e/journey.spec.ts` against a production build of this app and the real API. See the [root AGENTS.md](../../AGENTS.md#testing) before running it.
