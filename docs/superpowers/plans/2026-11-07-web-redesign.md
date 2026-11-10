# Web redesign — brief for every agent

Owner-agreed 2026-11-07. The backend is built and strong; the web must show every capability, look premium, and never overflow. Read `AGENTS.md` first (non-negotiables apply to you). Judge the current UI by what it does, not how it looks; **reuse its pieces** (`components/ui.tsx`, `lib/queries.ts`, `lib/api.ts`, `lib/types.ts`, `lib/money.ts`, `lib/acting-as.ts`, `components/proof/*`, `components/rulebook/*`, `components/version/*`) and reshape them to the plan below. Read `apps/web/node_modules/next/dist/docs/` before writing web code (Next 16).

## Look and feel
- Keep the tokens in `apps/web/src/app/globals.css` (warm canvas, white rounded cards, blue primary, pills). The final look for the **sidebar and Contracts list** is the owner's screenshot: sidebar with search (⌘K) and a bell; "Contracts" expandable with sub-filters (Needs you, Waiting for approval, Live, Couldn't read) and counts; Activity; How it works; Settings; "Choose your name" chip at the bottom. Main area is one big rounded white panel. List: title + one-line description, "Add contract" button, filter pills with counts (All, Needs you, Waiting for approval, Live, Couldn't read), search box (protocol, sponsor, site, doctor), a table with Contract / Where it is / Next step / Updated. "Where it is" = five dots plus the label.
- Every page must work from 1024 px wide up, and degrade down to phone width without horizontal page scroll. Tables scroll inside their own box. Long text wraps or truncates with a title. Test long names and big numbers.
- Light mode only. Plain English for an accountant: what happened and what to do. No codes, no stack traces.
- Empty, loading (skeleton, not a bare spinner where layout is known) and error states on every screen.

## The five steps (the only steps)
1. **Add files** — no PDFs yet. 2. **Reading** — a read is running. 3. **Decisions** — draft with blocking questions or failing checks (or a failed read: "Couldn't read"). 4. **Approve** — draft with nothing blocking. 5. **Live** — approved. A live contract with a newer reading/draft keeps a "New version in progress" tag. List tabs: Needs you = step 3; Waiting for approval = step 4; Live; Couldn't read = failed; Reading and Add files appear under All only.
Maker-checker: if the person using the app answered this version's questions, the approve button reads "Waiting for a colleague" (disabled, naming who answered).

## Study workspace (one page per contract)
Header: contract title, parties, stepper (circles, label and status under each), status banner with the main action (Start reading / Answer N decisions / Review and approve / Open rulebook), version picker with "Approved by X · date · applies from date", search this contract, Export (hidden until the backend has it). Tabs: **Overview · Budget grid · Fees & invoiceables · Payment terms · Documents · History** (History hidden until the activity endpoint exists). The workspace opens on the step that needs the person.
- **Overview = a card for EVERY term, no cap**, grouped under headings with counts, all expanded, cards that need attention first. Card: small label (category), big value (amount, or the rule), one line of detail (unit, trigger, cap, conditions, deadline), proof badge (math / quote / two reads / house rule / person), who proofread it, "Show in the contract". Core money rules always get a card, with "None found in this contract" if absent: payment terms, holdback, overhead, screen failures, unscheduled visits, invoice deadlines. Per-patient total per arm comes from the grids. Below the cards, "How the numbers were checked" from coverage (matched / confirmed by a person / proofread) and a Proofread button.
- "Show in the contract" opens a side panel (PDF page, quote highlighted). "Proofread" opens the full split view. Highlights default to problems only (missing, doubtful) with a toggle for everything.
- **Decisions** = focus mode, one question at a time, page crop beside the options, suggestion marked, "Question 2 of 5".
- **Approve** = one page: open items, key terms to tick (8–12), everything else with proof.
- A new version shows the whole new rulebook (no diff yet).
- Cost is never shown to accountants.

## Backend contract (so web and API agents can work in parallel)
`GET /studies` rows gain: `pi: string|null`, `updatedAt: string`, `liveVersion: number|null`, `openDecisions: number` (open blocking questions plus 1 if the draft has failing checks and no open question, for the latest version only), `newVersionInProgress: boolean`, `answeredBy: string[]` (names that answered the latest draft), and `latestVersion` becomes `{ id, number, status }|null`.
`GET /versions/:id` gains `proofreads: { item: string; by: string; at: string }[]`. `item` is a term id, or `grid:<gridId>:<row>:<col>` for one grid cell. New `POST /versions/:id/proofread { by, items: string[] }` (adds marks, ignores repeats) and `DELETE /versions/:id/proofread?by=&item=` (removes your own mark). Allowed on a draft or approved version, never on a reading or failed one. Record only; approval does not wait for it. Every write is audited.

## Rules for agents
- Own only the files your task lists. Need a change in someone else's file or a shared type? Say so in your report; do not edit it.
- Never stop or start the owner's servers (web 3100, API 4100). Never touch the dev database `dct_finance`. Never start a real contract read or any paid model call. Tests use fixtures and fakes.
- Run only checks scoped to your area: typecheck and lint for your package, and tests for your files. API tests and e2e touch shared databases; only the agent whose task says so may run API tests, and nobody runs e2e (the manager does). Errors in files you do not own are not yours: report them.
- No commits. No new dependencies without asking the manager: if you need a component (loader, drop zone, toast, resizable panes, etc.) that `components/ui.tsx` lacks, build a plain placeholder with the existing primitives, leave a clear `// COMPONENT:` comment naming what the owner should drop in, and list it in your report.
- Comments explain why, not what. Conventional naming and the repo's style. Add or update tests for logic (state derivation, grouping, card mapping, endpoints).
- Final report: what you built, files touched, checks run and their results, anything you could not do, components wanted.
