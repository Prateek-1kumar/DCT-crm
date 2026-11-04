# Contract Harness — Design

Date: 2026-11-05 · Branch: `feature/contract-harness` (cut from `feature/phase1-accuracy`) · Status: draft for approval

## 1. Why this exists

DCT's accountants receive clinical-trial site contracts (CTAs, work orders, amendments, budgets) from any sponsor, in any layout. They need each contract turned into a **rulebook**: every way the site gets paid and every rule that changes money, so they can bill without reopening the PDF.

The previous pipeline worked, but it read contracts with layout-specific code (a grid reader, a text "binder", a solver, a money sweep) and asked a person to settle anything that code couldn't match. On clean, signed, native PDFs it still asked **67 questions (CBT-CS301) and 85 (MK-0616)**, almost all of them "confirm this number", where the answer was printed in the PDF or proven by the contract's own totals. The client found this unacceptable. Every new sponsor layout meant more parsing code, a loop with no end.

**The new approach works like Claude Code, but for contracts.** An AI agent reads the documents with tools and writes the rulebook. Code does not read the contract; **code only checks** what the agent wrote: the grid arithmetic, that quotes exist on their pages, and that every dollar amount is accounted for. The agent fixes what fails. Reading doubts are settled by two independent model reads. A person sees only real decisions, the questions the contract itself doesn't answer.

### Evidence (spike, 2026-11-05)

A throwaway Python harness (Claude Opus 5.5, about 360 lines; kept for reference at `docs/superpowers/spike/harness.py`) was run on three contracts. Each output was audited independently by a separate model reading the PDF from scratch.

| Contract | Old questions | Harness questions | Wrong values (audit) | Missed billables | Cost / time |
|---|---|---|---|---|---|
| CBT-CS301 (CTA + Amendment 1) | 67 | 2 (both genuine) | 0 of ~150 cells, 20 terms | 1 minor (record storage at sponsor's expense) | $0.50 / 1.7 min |
| MK-0616-015-0096 | 85 | 0 | 0 of 44 visit amounts, 42 terms | 0 | $0.53 / 1.9 min |
| Shionogi 2402T1432 (never seen before) | — | 2 (1 genuine, 1 weak) | 0 of 173 cells, 33 terms | 0 dollar items | $0.87 / 3.2 min |

**What the audits found wrong:** the harness made **silent judgment calls**, about 3–4 genuine decisions per contract that it never raised. Examples: MK-0616 screen failure at Visit 1 (the contract says "in accordance with work completed", so possibly $4,000 rather than $5,995); whether the 5% holdback applies to screen-fail invoices; Shionogi's combined Screening/Day 1 visit dropping a $135 dispensing fee; asking "flat fee or cap?" about Advertising but not about two fees printed the same way. Also, one grid was marked "proven" with nothing actually cross-checked. This design fixes all of these (§5.4, §5.5, §6).

## 2. Goals, non-goals, anti-goals

**Goals**
- Any contract bundle in, a complete rulebook out, in **≤ 10 minutes** and **≤ $2 of model spend** per bundle (spike: about 3 minutes and under $1).
- **0 wrong values approved. Nothing billable missed.** Measured on the golden set (§9).
- **About 7 or fewer questions per contract**, every one a real decision a person must make.
- Every value shows **how it is proven**: by the contract's own arithmetic, its quote on the page, two independent reads, a house rule, or a person.
- Accountants correct things **in plain words** ("that $200 is a cap, not a per-visit amount"), and can choose to **save the correction as a house rule** for future contracts.
- A live rulebook is never changed. Any change, whether an amendment, a correction or "this looks wrong", produces a new version, approved by looking at **only what changed**.

**Non-goals (this phase)**
- Generating invoices from visit data (Clinical Conductor / EDC). The rulebook must be trusted first.
- Login and authentication. Names are entered as today; DTR integration brings real identity later.
- DTR deployment and Forgejo process (later; the code must stay compatible with their rules: synthetic data in the repo, feature switch).
- Layout or table-recognition models, vector databases, workflow engines, fine-tuning.

**Anti-goals (failure even if it "works")**
- Asking a person to confirm a value the checks already prove.
- Settling a judgment call silently (§5.4).
- Code that knows a specific sponsor's layout. Sponsor knowledge lives in prompts and house rules, never in parsers.
- Changing a live rulebook in place.
- Unbounded model spend. Every read has a hard budget.

## 3. Constraints

- **Stack:** TypeScript monorepo as today (pnpm, Node ≥ 24, Fastify 5, Postgres 16, Drizzle, pg-boss, zod, Next.js, vitest, Playwright). The harness is TypeScript; the Python spike is reference only.
- **Licences:** permissive only (MIT, Apache-2.0, BSD). **No AGPL or GPL**, so no MuPDF and no Poppler. Default PDF stack: `pdfjs-dist` (Apache-2.0) for text with word positions, plus `@napi-rs/canvas` (MIT) for rendering. The builder may swap in PDFium (BSD/Apache, e.g. via WASM) if rendering fidelity requires it.
- **Models:** Anthropic (primary) and OpenAI (second reader and reviewer), both approved by the user on 2026-11-05 for contract pages. Use them deliberately: **no model call without a reason, every call costed, a hard budget per read.** Model IDs come from configuration, never hard-coded. Defaults: compile **`claude-sonnet-5-5`** at effort `high` (owner's choice, about half Opus's cost); `claude-opus-5-5` is a setting, switched on only if Sonnet fails the golden set. The spike measured Opus, so the first golden run proves Sonnet. Second reader and reviewer come from `OPENAI_MODEL` (currently `gpt-5.5`). **Development spend:** test runs are capped at **$10 in total** until the owner allots more. Every paid run is announced beforehand, with a running total.
- **Data handling:** only contract pages are sent to models, never patient data. Bank account, routing and similar numbers are masked in all text sent to models, and painted over in page images wherever their position is known from the text layer. *Known limit:* on image-only pages (scans, vector-outlined text), bank details can't be located and are sent unmasked. Real contracts and answer keys live in `data/`, which is gitignored; only synthetic fixtures are committed.
- **Money** is stored as integer cents.

## 4. How the accountant experiences it

1. **Upload.** They drop in the study's PDFs (CTA, amendments, budget). The system lists each file and what it looks like (text pages, image pages, page count) and suggests each document's role (CTA, amendment, budget, protocol). They confirm the study details.
2. **Reading (live).** A progress feed in plain words, built from the agent's steps: "Reading Exhibit A (pp. 17–20)", "Budget on p. 7: all 13 visit totals add up ✓", "Re-reading a blurry cell on p. 21: two reads agree ✓". About 2–5 minutes.
3. **Decisions.** Typically 0–7 cards. Each shows the exact page spot, the quote, what the contract says and doesn't say, the options, and the system's suggestion with its reason. Answer by picking an option or writing in plain words. Each card has **"Save as house rule"** with a scope (this sponsor / this CRO / all contracts), unticked by default, so the accountant chooses each time.
4. **Approve.** One page, three sections:
   - **Needs your decision:** anything still open. Approval waits on these.
   - **Key terms to tick (8–12):** payment terms, holdback, overhead, screen-fail rule, per-patient total per arm, the largest site fees, invoice deadlines, when an amendment applies. One click shows where each came from in the PDF.
   - **Everything else, proven:** each line carries its proof badge ("totals add up p. 7", "quote on p. 4", "two reads agree", "house rule #12"). Proofreading is optional.

   Maker-checker: whoever answered decisions or made corrections on a version can't approve it.
5. **Live.** The rulebook is locked and exported (Excel plus a printable summary). Every line shows its proof and, where a house rule changed how it bills, **the contract's words and the house rule side by side**.
6. **Later changes.** "This looks wrong", a plain-words correction, or an uploaded amendment starts a **new version**. The whole bundle is re-read, and the approver sees **only the differences** from the live version, plus any decisions. Live stays live until the new version is approved.
7. **House rules page.** All saved rules with scope, author, date and the version where each was created. Rules can be edited or retired; changes affect future reads only, never a live rulebook.

## 5. The engine

### 5.1 Intake (no AI)
For each PDF: check the file (`%PDF-` header, size and page limits, opens cleanly), store it by sha256, then build a **page inventory**:
- text layer per page, with word positions
- `TEXT` vs `IMAGE` page: an `IMAGE` page is a scan, or vector-outlined text with almost no characters but many drawing operations (e.g. APL_3007, about 72 characters per page)
- the first line of each page

Bank details are masked in the stored text that models see.

### 5.2 Compile (agent loop)
One agent (compile model) runs a tool-use loop until it calls `finish` and the checks pass, or until it runs out of budget, turns or finish attempts. Tools (the spike's set, proven to work):

| Tool | Does |
|---|---|
| `read_pages(doc, pages[])` | Layout-preserving text of up to ~15 pages. `IMAGE` pages say "use view_page". |
| `view_page(doc, page, region?, dpi?)` | Render a page or a region (fractions 0–1) at up to 300 dpi, with known bank-detail regions painted over. For dense grids and footnotes. |
| `search(pattern)` | Regex over all documents' text, returning doc, page and line. |
| `put_study(study)` | Study details and each document's role and supersession. |
| `put_terms(terms[])` | Upsert terms. **Returns check results immediately** (quote on page, required fields). |
| `put_grid(grid)` | Upsert one budget grid. **Returns the arithmetic check immediately.** |
| `put_accounted(items[])` | Dollar amounts or whole pages that are deliberately not rulebook values (superseded budget, insurance limits, citations, DocuSign IDs), each with a reason. |
| `put_questions(questions[])` | Decisions the agent knows a person must make. |
| `finish()` | Runs every check (§5.3). Problems come back to the agent; on the last allowed finish they become open items. |

Applicable **house rules** (by sponsor, CRO, site entity, or global) go into the agent's context at the start. When one changes how a term bills, the term records the house rule's id; the contract quote stays.

The system prompt is the spike's prompt (`docs/superpowers/spike/harness.py`, the source of truth for its prompt, tools and checks) adapted to the schema in §6. Rule of thumb: read text pages as text, use images only for `IMAGE` pages or to settle a dense spot, and keep the printed subtotal and total rows because they are what proves the cells.

### 5.3 Checks (deterministic code, the "unit tests")
1. **Grid arithmetic:** row cells sum to the printed row total; column cells sum to the printed subtotal; overhead = subtotal × rate (within $0.50 for whole-dollar rounding, flagged as rounded); subtotal + overhead + additions = printed visit total; visit totals sum to the printed grand total. Lengths must match the visit count.
2. **"Proven" means really cross-checked.** A grid is proven only if every numeric cell takes part in at least one identity whose printed side was captured and holds. Cells not covered need cell-level evidence instead: on `TEXT` pages, the value at that position in the text layer; on `IMAGE` pages, two independent reads (§5.5). *This fixes the spike's MK-0616 home-health grid, which was marked proven with nothing to check it against.*
3. **Quote on page:** each term's quote is found on its page (whitespace- and case-insensitive). On `IMAGE` pages, quotes can't be text-checked, so the term's amounts need arithmetic proof or two independent reads.
4. **Every dollar accounted for:** every amount-shaped string on every money-bearing page (`$`, `US$`, `USD`, or `#,###.##`) appears in the rulebook or in `accounted`. Documents marked as having no money (e.g. a protocol) are skipped. *Known weakness:* a coincidental number match counts as accounted. Acceptable for now; the golden set measures it.
5. **Required-decision rules**, which make silent assumptions impossible by construction:
   - a term with `billing: unknown`
   - a holdback that exists but whose scope over this term is `unclear`
   - an overhead whose application to this term is `unclear`
   - an amendment with no clear effective date
   - a formula or cap that depends on an unstated rounding or proration rule

   Each of these produces a decision question automatically.

### 5.4 Reviewer pass (second model, independent)
After compile passes its checks, a **reviewer** (default: the OpenAI model) gets the rulebook plus the documents' text, and the page images only for `IMAGE` pages. It does not see the compile agent's conversation. Its only job is to list:
- **silent judgment calls:** places where the rulebook chose one reading of something the contract doesn't settle (proration of screen-fails, holdback or overhead scope, a combined visit dropping a line, conditions on pre-screen payments)
- **inconsistency:** similar items treated differently (e.g. one "Invoiceable" fee asked about, two identical ones not)
- **contradictions** inside the bundle (e.g. MK-1406: 75% in Exhibit A vs 60% in the grid)
- **possibly missed money rules**, especially rules with no dollar amount (deadlines, record storage at the sponsor's expense)

Each finding becomes a candidate question with a page and region, and goes to the resolver. The reviewer never edits the rulebook.

### 5.5 Resolver (before any person sees a question)
Each candidate question, from a failed check, the compile agent or the reviewer, has a kind. **The kind needs no extra model call:** a failed arithmetic or quote check is `reading`; a required-decision rule (§5.3.5) is `decision`; the compile agent's `put_questions` and the reviewer's output schema each declare the kind and the page region for every question they raise. The kinds:

| Kind | Meaning | Resolution |
|---|---|---|
| **reading** | What does this spot say? | Crop the region at high dpi. **Two models (Claude and OpenAI) read it independently**, neither seeing the other's answer or the current value. If both agree **and** every arithmetic identity touching the value still holds, it is settled automatically, with evidence `two_reads`. If they disagree, it becomes a person's question showing both readings and the crop. |
| **elsewhere** | The answer may be in another clause or document | Search the bundle (and an amendment's supersession) and the house rules. If found, it is settled with the citation. If not, it becomes a **decision**. |
| **decision** | The contract doesn't say | If a matching house rule exists, apply it and cite it. Otherwise it is a person's question. **Never settled by models agreeing.** |

Every automatic resolution is recorded with its evidence and visible on the rulebook line. A reading resolution changes a value only through the same checks; a `two_reads` value that breaks an identity becomes a person's question.

### 5.5a How an answer changes the rulebook
An answer is a **structured patch**, never a re-read. Every question's options carry the patch each option would apply, for example `{term: sf_full, set: {formula: "pro-rated by procedures completed, max $5,995"}}`, written by whoever raised the question. A free-text answer goes through the same small model call as a plain-words correction (§5.6): it is turned into a patch and shown as before → after, and the person confirms. The patched value's evidence becomes `person`. The checks re-run on the patched rulebook with no model call; if an answer breaks an identity, that is asked straight away.

### 5.6 Corrections in plain words
On any rulebook line, the accountant writes what's wrong ("this $200 is a maximum per visit, not a fixed amount").
1. A small model call turns the note into a **proposed structured change** shown as before → after (e.g. `amount 200, unit per visit` → `cap 200 per visit, billed actual`).
2. The person confirms or edits it. The line keeps the contract quote and adds the note, the name and the date.
3. The card offers **"Save as house rule"** with a scope.

On a draft, the change applies to the draft. On a live version, it creates a new version (§4, step 6).

### 5.7 Amendments and versions
- Statuses: `reading` → `draft` (or `failed`) → `approved` (live, immutable, enforced by the API and a database trigger) → `superseded`.
- An amendment or correction is a **full re-read of the whole bundle** with the new documents. Re-reading is cheap, and the agent sorts out supersession, so there is no patching of the old rulebook.
- The new draft is **diffed against the live version** by term id or semantic key and grid cell. The approval page shows only changes plus decisions. Previous answers to decisions carry forward when the same question arises with the same quote; otherwise they're asked again.
- If an amendment's effective or retroactive date is unclear, that is a required decision (§5.3.5).

### 5.8 Budget and limits
- Per read: a hard cap on model spend (default **$3**, configurable). When it's reached, the read stops and the version fails in plain words ("stopped at the $3 limit after reading 40 of 62 pages"). Spend is recorded per model call.
- Compile: at most ~80 turns and 3 finish attempts. Prompt caching is on. Effort is tuned on the golden set: lower it wherever the golden metrics hold.
- Reading resolutions crop small regions, about a cent each. The reviewer is one call per read.

### 5.9 Trace
Every read stores its full trace: model calls (model, tokens, cost), tool calls and results (images by reference), check results, reviewer findings and resolver decisions. It is used to debug, to audit "why does the rulebook say this", and for the golden-set reports.

## 6. Rulebook (core schema, zod)

A fixed core with an open edge. Exact names are left to the builder; the meaning is fixed.

- **Study:** protocol, sponsor, payer (CRO/SMO), site legal entity, site number, PI, effective dates, and `documents[]`, each with role, what it supersedes, effective-from date, and whether it is retroactive.
- **Term:** id; category (`payment_terms | invoicing | holdback | overhead | site_fee | recurring_fee | invoiceable | conditional_procedure | screen_failure | unscheduled_visit | stipend_travel | bonus | cap_or_limit | deadline | other`); name; amount in cents or null; unit; `billing: auto_paid | invoice | unknown`; trigger; cap (kind `count | amount | ratio | hours | none`, value, period, text); formula (text, e.g. "100% V1 + 75% V2, max 41; first 10 as they occur, then 9 per 11 randomized"); conditions; `holdbackApplies: yes | no | unclear | n/a`; `overheadApplies: included | added | no | unclear | n/a`; deadline; source (doc, page, quote, region); **evidence** (`math | quote | two_reads | house_rule | person`); house-rule ids; notes.
- **Grid:** id, name, arm, doc, pages, visits[], overhead rate, rows[] (name, code, unit cost, cells[], where each cell is cents, a printed text such as "Invoice" / "Inc in PE" / "N/A", or blank; printed row total), subtotal[], overhead[], additions[] (lines after overhead, such as stipends and bonuses), total[], grand total, proof status per cell. Cells reading "Invoice" must also have a matching `invoiceable` term.
- **Accounted:** {doc, page | pages, amount?, reason}.
- **Question:** id, kind (`reading | elsewhere | decision`), origin (check, compile, reviewer, required-rule), page and region, quote, what the contract says and doesn't, options, suggestion with reason, readings (for reading kind), state (`open | auto_resolved | answered`), answer, answered-by, "saved as house rule" id.
- **Parties:** sponsors, CROs/SMOs and site entities are records, each with a name and aliases. At study setup, the person confirms each party. The system suggests a known record by normalised name and aliases (e.g. "Merck Sharp & Dohme LLC" → Merck), or the person creates a new one or adds an alias. House rules attach to these records, so matching is **exact on the record**, never fuzzy on PDF text.
- **House rule:** id, scope (`sponsor | cro | site_entity | global`) and the party record it attaches to, plain-words text, author, created-from (question or correction and version), active flag, edit history.

Anything a contract has that doesn't fit goes in an `other` term with formula and conditions. The every-dollar check (§5.3.4) ensures nothing falls through both.

## 7. Data (tables, indicative)
`documents` (sha256, pages, inventory), `studies`, `study_documents`, `versions` (status, rulebook JSONB, parent version, diff summary, approver), `reads` (job, budget, spend, trace pointer, outcome), `questions`, `house_rules` (plus history), `corrections`, `audit_log`. Old migrations are dropped and replaced by a fresh schema.

## 8. Web screens
Upload and study details · Reading (live progress feed) · Decisions (cards) · Approve (three sections) · Rulebook (live or draft, with proof badges, "this looks wrong" and plain-words correction on each line) · Version diff · House rules · Export (Excel and print). **Keep the existing design language** (owner, 2026-11-05): the sidebar, pills, and the current look and feel. What each screen contains is free to change to fit this design, and is decided as each screen is built.

## 9. Golden set and evaluation
- **Golden bundles** (local, in gitignored `data/`): CBT-CS301 (CTA + Amendment 1), MK-0616-015-0096, Shionogi 2402T1432, plus EFC18243 COPD. Existing answer keys in `data/keys/` and `data/golden/copd-native.json` may seed theirs after checking them against the new schema. **Building the keys is part of the build** (plan step 2), from the audited spike outputs; the owner reviews them. A key holds: (a) every expected value (terms and grid cells); (b) every expected billable item; (c) every **expected decision question**, by topic and page (e.g. "MK-0616 p.18: screen-fail pro-rating at Visit 1"). A key records which questions must be raised, not how a person answers them, so no business answers are needed to build it.
- **Next to measure** (before claiming "any contract"): `APL_3007-GA-201_SPA` (vector-outlined, no text) and `TGC12301…CSA15SEP2023` (full scan). If scans need text for quote checks, add Tesseract (Apache-2.0) **only** after measuring.
- **Metrics per bundle:** wrong values, missed billables, questions (and how many are genuine), automatic resolutions by kind, cost and time.
- **Gate:** no prompt, model, effort or check change merges without a golden run that keeps wrong values = 0 and missed billables = 0, raises **every** expected decision question, and raises **no** question that isn't in the key. Any extra question is reviewed by the owner: either it is genuine and added to the key, or it is noise and the change doesn't merge. The raw count isn't the gate; the key is. Golden runs cost money, so they run on demand before merging, not on every CI push. CI runs the deterministic checks and the API and web tests on synthetic fixtures, with the model calls faked.

## 10. Decided by the user (2026-11-05)
- Build the agentic harness. The checks are the "unit tests"; the old layout-specific pipeline is retired.
- Resolver loop: reading doubts are settled by two independent model reads at the exact spot; decisions go to a person.
- A person's answer becomes a house rule only when they tick **"Save as house rule"**. They choose each time.
- Live rulebooks are immutable; every change is a new version reviewed as a diff.
- Proofreading and approval flow: designer's choice, as in §4.4.
- OpenAI may receive contract pages (used sparingly). No MuPDF licence, so permissive PDF libraries only.
- Compile model defaults to Claude Sonnet 5.5, with Opus only if the golden set needs it. Development test spend is capped at $10 for now.
- The 7 old studies in the dev database are dropped; start fresh.
- Keep the UI's design language (sidebar, pills); what each screen contains can change.
- Build method: parallel Sonnet agents (effort high) do the implementation; the principal engineer (Claude, this session) reviews every change so the design stays intact. The owner also reviews. One step at a time, starting with the clean-up.
- Work on a new branch. The old extraction code, review-question system, agent instruction files and old docs are deleted first, so old logic can't leak in.

## 11. Calls made by the designer (check these)
- TypeScript harness on the Anthropic and OpenAI SDKs with a hand-written loop (~100 lines), not an agent framework.
- `pdfjs-dist` + `@napi-rs/canvas` as the PDF stack.
- Reviewer and second reader default to OpenAI, for model diversity.
- $3 default budget per read; compile effort `high` until the golden set shows lower holds.
- The "proven" definition in §5.3.2, and the required-decision rules in §5.3.5.
- Amendments re-read the whole bundle rather than patching.
- Export: Excel plus printable summary, as before.
- Answers are structured patches confirmed by the person, never a re-read (§5.5a).
- A question's kind comes from its origin or the raiser's schema, with no sorting call (§5.5).
- Parties (sponsor, CRO, site) are records confirmed at setup, so house rules match exactly (§6).
- Golden keys list expected decision questions; the gate is the key, not the raw question count (§9).
- The spike harness is copied into `docs/superpowers/spike/` as the reference for prompt, tools and checks.

## 12. Left to the builder
Exact schema field names; module layout; prompt wording beyond the rules here; the resolver's region-cropping details; progress-feed wording; UI layout and styling; how the diff keys terms across versions; the Excel layout; test structure.

## 13. Suggested build order (the plan refines this)
1. **Clean-up commit:** delete `packages/extraction` (including the OCR tree), the review-question system and its UI, all `AGENTS.md` and `CLAUDE.md` files, old ADRs and phase-1 docs, old migrations, and tests of deleted code. Keep the plumbing: the monorepo, Fastify bootstrap, database connection, pg-boss wiring, file storage, Next.js shell and styles, and the money and zod basics in `packages/shared` (only the money helpers `parseCents` and `parsePercent`; everything else in `shared`, including `questions`, `answer`, `evidence`, `problems`, `diff` and `xlsx`, goes). Maker-checker, the append-only audit log, the immutability triggers and the Excel export are **rewritten** for the new rulebook, not carried over. Write one fresh, short root `AGENTS.md` (with `CLAUDE.md` containing `@AGENTS.md`) that carries forward only the operational rules: never commit or log `data/` or `.env`; no AI spend without the owner's approval; never stop the owner's dev servers (3100/4100) or Postgres container, and never point a second API at `dct_finance`; Postgres runs in Apple `container`; Next.js 16 docs live in `node_modules/next/dist/docs/`; test databases end in `_test` or `_e2e`; user-facing words in plain English; Conventional Commits with no AI attribution; commit only when asked.
2. **Harness core as a CLI:** intake, compile loop, checks. Run it on the golden set and match the spike.
3. **Reviewer and resolver:** the golden set should show the auditors' missed decisions now raised, and no "confirm a number" questions.
4. **API, database and jobs:** studies, reads with budget and trace, versions, questions, approval, immutability.
5. **Web:** upload, progress feed, decisions, approve, rulebook, export.
6. **Corrections, house rules, amendments and diff.**
7. **Hard documents:** measure APL (vector) and TGC (scan) and add what they need.
