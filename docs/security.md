# Security

The threat model as the code stands on `feature/contarcts`. Detail on each API behavior is in [phase-1/api.md](phase-1/api.md); the reasoning about evidence and trust boundaries is in [ADR-001 §9](phase-1/adr-001-extraction-evidence.md#9-security-and-trust-boundaries).

## What we protect

| Asset | Why it matters |
|---|---|
| The approved invoicing masters | Billing works from them. A wrong or spoofed approval costs the client real money. |
| The audit trail | It is the record of who answered, changed and approved what. |
| Sponsor contracts (PDFs in `UPLOAD_DIR`, and `data/`) | Confidential, and they contain payee bank details. |
| API keys and the database URL | They give access to paid AI accounts and to everything above. |

## Who can reach it: this computer only, no login

Decided by the owner on 2026-10-28.

- The API listens on 127.0.0.1 only; the address is fixed in code, not a setting (`listenHost` in `apps/api/src/config.ts`). The web scripts bind to 127.0.0.1 too (`-H 127.0.0.1` in `apps/web/package.json`).
- The development Postgres (user and password `dct`) is published on 127.0.0.1:5434 only (`apps/api/scripts/db.sh`). A `dct-postgres` container created before that change (`d496a1f`) keeps listening on every network interface until it's recreated: see the [runbook](runbook.md#recreating-the-dev-database-container).
- **There is no login.** People pick their name from a list (`apps/web/src/lib/acting-as.ts`, kept in the browser), and every write carries that name as `by`. Anyone who can reach the app can therefore approve as anyone, mark alerts read for anyone, and turn maker-checker off. Maker-checker is on by default (migration 0010 turned it on only in a database whose audit log was empty; one already in use kept its setting), and names are compared trimmed and ignoring case, but it only means something once names come from logins.

**Before the app listens on any other address, or more than one person uses it:**

1. Add login, with a signed per-person session, and take `by` from the session on the server. Never from the request body.
2. Serve it over HTTPS, and add HSTS and `upgrade-insecure-requests` to the web's headers (`apps/web/next.config.ts` notes this).
3. Make `listenHost` a setting only once 1 and 2 are done, and review `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` for the real address.
4. Decide who may change settings (maker-checker, the people list) and who may approve.

## Request guards

In `apps/api/src/app.ts`, on every request, `fastify.inject` tests included:

- **Host (DNS rebinding):** a `Host`, or any `X-Forwarded-Host`, not in `ALLOWED_HOSTS` gets 403 "Host not allowed". The web's proxy sends the API's own Host and moves the browser's into `X-Forwarded-Host`, so checking both is what stops a rebinding attack through the web port. The default allows `localhost` and `127.0.0.1` on the API's port and on 3100. The probes are guarded too.
- **Origin (CSRF):** a POST, PATCH, PUT or DELETE whose `Origin` is present and not in `ALLOWED_ORIGINS` gets 403 "Origin not allowed"; `Origin: null` is refused. A request with no `Origin` (curl, server to server) passes: that's acceptable only while the API is reachable from this computer alone.
- No CORS headers are set. The browser reaches the API only through the web's same-origin `/api` proxy.
- Every `:id` must be a UUID and every `:v` a version number (400 otherwise), checked before any route runs. JSON bodies are at most 1 MB.

## Contracts and the AI

- **Only contracts go to the AI. Patient data never does.** Phase 1 has no CTMS import, and every model call goes through `packages/extraction/src/llm.ts`, the only file that builds a model client and calls a model (`model-schema.ts` imports the Anthropic SDK's schema-conversion helper, which makes no call). `packages/extraction/test/llm.test.ts` fails if `apps/*/src` or `packages/shared/src` imports a model SDK at all (ADR-001 §9).
- **Bank details are masked before anything goes to the AI.** On text PDFs, the words of each bank sentence that carry account, routing or IBAN numbers (`bankRects`, `packages/extraction/src/textlayer.ts`), and account-like numbers on a bank label's line or the one or two lines after it, are painted black in every image sent to a model: page sorting, identify, terms, grid tiles and overviews (`packages/extraction/src/extract.ts`). Scans have no text to locate them by, so there the system prompt tells the model to ignore bank details. On every reply, the identify reply too (its guess is stored on the study and in the audit log), IBANs and runs of 8+ digits become `[redacted]`, and a bank string that still carries an account or SWIFT code is replaced whole (`sanitize`/`scrub` in `extract.ts`). Bank spans are left out of the money inventory, and bank details are never stored: every bank word is "…" in the stored text of any money span on its line. (A short digit group under a bank label could be a price, so it stays in the sweep and is asked, with its text masked.)
- **A model's reply never reaches a job's details, a warning or a log.** A reply that isn't JSON is reported by its error class and the position where it broke, never with any of its text (`llm.ts`); a read's warnings are stored by kind, and the API words them itself (`plainWarnings` in `apps/api/src/jobs.ts`).
- The page viewer shows contract pages unmasked, because people need to see the contract. Page images are sent with `Cache-Control: private, max-age=3600`.
- **Contract text is untrusted input to the model.** The model has no tools and returns schema-checked JSON. A prompt injection can at most produce a wrong value, and a value counts only once the PDF's own visible text or a person confirms it. Invisible text (white, tiny, off-page) raises `HIDDEN_TEXT` and is never evidence.
- **A crafted PDF can't stall the server.** mupdf runs in a worker thread; a call longer than 30 s is stopped and the worker replaced. Uploads count pages there too, from the staged file, so a crafted PDF costs a time-out (422), never the event loop; pdf-lib is only a test dependency now. Pages, pixels, tiles and images per read are capped before anything is rendered (`RENDER_LIMITS`, `CONFIG` in `packages/extraction`). Model output is rendered as plain text; the web has no raw-HTML rendering.
- **Spend cap:** `EXTRACTION_MAX_USD`, $20 per read by default, checked on real tracked spend before every model call of a read (identifying documents, a few cover pages on the fast model, is outside it). See the [runbook](runbook.md#ai-reads-models-and-spend-cap).
- **An abandoned read stops.** When pg-boss gives up on a read (past two hours, its claim lost, a shutdown), the read starts no further AI call, cancels the one in flight, and never writes its result.
- Before go-live, ADR-001 §9 asks for two checks outside the code: DCT's Anthropic terms and data retention, and whether sponsors' confidentiality clauses allow sending contracts to a processor.

## Integrity of what's approved

- **Signed versions are immutable, twice.** The API refuses any change to a version that isn't a draft, proofread marks aside (each write route in `apps/api/src/routes/versions.ts`, and the gate's `signOffRefusal`). A database trigger refuses UPDATE and DELETE of a signed or superseded row except `signed → superseded`, `updated_at` and `proofread` (`apps/api/drizzle/0006_signed_versions_locked.sql`).
- **Study details lock once a version is approved:** `PATCH /studies/:id` returns 409, and the export is named and headed from the approved version's own copy of the details.
- **The audit log is append-only:** a trigger refuses UPDATE and DELETE (`apps/api/drizzle/0001_guards.sql`). Every write that changes something logs in the same transaction.
- **TRUNCATE is refused** too, which row triggers don't catch: statement-level triggers on the audit log, and on `rulebook_versions` while any version is signed or superseded, also through `TRUNCATE … CASCADE` (`apps/api/drizzle/0011_truncate_guards.sql`).
- **The sign-off gate is enforced by the API**, not just shown in the UI: see the money invariants in [AGENTS.md](../AGENTS.md#money-invariants). Approval names the version as the approver saw it (`asOf`, its `updatedAt`), so nobody approves values that changed after they looked. Every write moves `updatedAt` forward by at least a millisecond (`touched` in `domain.ts`), so two writes never share one. With maker-checker on, nobody in a version's `editors` (who decided an answer or typed a value on it) may approve it.
- These triggers stop the application and its bugs, not someone with database access: the API's own database user owns the tables, so its credentials can disable or drop a trigger (the API tests' reset disables the TRUNCATE guards inside its own transaction) and then edit or remove rows. Protect `DATABASE_URL` accordingly.

## What leaves the server

- **5xx responses never show their cause.** The error handler (`apps/api/src/app.ts`) answers "Something went wrong on the server… (ref <request id>)"; a database error's message holds the SQL and every value bound to it, so the log gets the error code, message and SQL text without the bound values. A failed job stores plain words for people and a separate technical detail, never SQL or values (`failure` in `apps/api/src/jobs.ts`). The web shows only plain messages (`errorText` in `apps/web/src/components/ui.tsx`).
- **Logs** hold the method and route pattern of each request, never bodies, ids, query strings, contract text or amounts.
- **Blind entry** keeps a withheld value, and what it decides (`alsoWithheld`), out of every response: versions, search (which reads the masked master), diff, the audit log and alerts. Its evidence goes out without its printed text and at its page only. The numbers are blanked in what could restate it: its item's other words and location, notes about it, a money term quoted from any line of its sentence, and every money term on its page when it's known only by its page (`packages/shared/src/blind.ts`; see [api.md](phase-1/api.md#review-questions-adr-001)).
- **Idempotent replays** return the saved response byte for byte, masked as it was when first sent, and are not masked again. For the 24 hours a response is kept, a replay can therefore show a value withheld since (an answer sent back or reported), but only to a client holding that request's key.
- Every API response has `X-Content-Type-Options: nosniff`; JSON is `Cache-Control: no-store`.

## Web headers

Set for every page in `apps/web/next.config.ts`, checked by the e2e on the production build:

- `Content-Security-Policy`: `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. Development adds `'unsafe-eval'` for React's tooling.
- The CSP is static, not nonce-based, because partial prerendering can't carry a per-request nonce; so inline scripts are allowed. zod runs `jitless` (`apps/web/src/instrumentation-client.ts`) so no `eval` is needed.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone, geolocation and browsing topics, and no `X-Powered-By`.
- Sample data can't reach a real build: `pnpm --filter web build` forces `NEXT_PUBLIC_API_MOCK` off, and the flag is inlined so the sample server isn't bundled.

## Uploads

- PDFs only: the `%PDF-` header (else 415), and mupdf, in its worker, must open the file and count its pages (400 if it can't, 422 if not within 30 s).
- At most 50 MB per file, 50 files, 10 fields and 60 parts per request (413), 100 pages per PDF (422).
- Stored once by sha256 under `UPLOAD_DIR`, written and flushed to disk before the row commits, all files of a request or none. Nothing deletes uploads automatically.

## Secrets

- Secrets live only in `.env` (git-ignored) or the environment. `.env.example` holds placeholders only.
- The API's settings check never prints a value; `DATABASE_URL` and the API keys are treated as secrets.
- The defaults `postgres://dct:dct@localhost:5434/...` are the local development container's, in `apps/api/scripts/db.sh`, and apply only inside the repo checkout: outside it the API refuses to start without `DATABASE_URL` (and `UPLOAD_DIR`).
- The guards around the test databases check the database's own name, not the URL: the API tests refuse one whose name doesn't end in `_test` (global setup and `testApp`), and `e2e-reset` one not ending in `_e2e`, naming the database, never the URL with its password.
- Real contracts, answer keys and uploads live in `data/` (git-ignored). Never commit, paste or log anything from `data/` or `.env`. The eval and evidence scripts print counts and scores only.

## Known gaps

- No login, so no real identities (above).
- No HTTPS while it runs on 127.0.0.1.
- Uploaded PDFs and the database are not encrypted at rest beyond what the disk provides.
- No backups (see the [runbook](runbook.md#backups)).
