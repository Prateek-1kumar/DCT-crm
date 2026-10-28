# Documentation

Start with the [repo README](../README.md) to run it, and [AGENTS.md](../AGENTS.md) before changing code.

## Current

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Components, the data flow from upload to approval and amendments, jobs, study stages, glossary |
| [runbook.md](runbook.md) | Settings, production build and start, migrations, health checks, AI models and the spend cap, logs, shutdown, troubleshooting, backups |
| [security.md](security.md) | The threat model, and what must change before more than one person uses the app |
| [phase-1/api.md](phase-1/api.md) | The API as built: every route, the review questions, blind entry, the sign-off gate, idempotency and atomicity, jobs, decisions. The reference for API behavior |
| [PHASES.md](PHASES.md) | What we're building, phase by phase. Phase 1 (contracts) is built; phases 2–6 are plans |

Each package also has an `AGENTS.md`: [apps/api](../apps/api/AGENTS.md), [apps/web](../apps/web/AGENTS.md), [packages/shared](../packages/shared/AGENTS.md), [packages/extraction](../packages/extraction/AGENTS.md).

## Decisions (ADRs)

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](phase-1/adr-001-extraction-evidence.md) | Contract extraction requires evidence for every value: a value is unconfirmed until the PDF's own text or a person confirms it; approval is gated on invariants I1–I6 | **Proposed** (2026-10-28), and mostly built. See below |

**ADR-001, what is built** (checked in code on 2026-10-29): the text layer with boxes, text-source and hidden-text detection, and bank masking (build step 1); the binder and the evidence ledger, including re-pointed page citations (step 2); the coverage sweep that asks about unaccounted money terms (part of step 3); the $20 runaway cap on real spend (part of step 4); the API's sign-off gate and blind answering (step 5); the review UI with blind answers next to the page close-up (most of step 6); scan mode with arithmetic confirmation and page attestation (part of step 7).

**Not built yet:**
- schema version 2: `other` plus `asWritten` on every enum, the `unclassified` list, `perPatientTotals[].visitCodes` (step 3);
- removing the second read, the OpenAI client, `LOW_CONFIDENCE` and `AI_DISAGREEMENT`. They still run, but are never asked about (step 4);
- the classifier still decides which pages go to the terms reader. The sweep still covers every text page;
- the prompt and check clean-up of §8, including the deadlines prompt's "only these kinds" (`packages/extraction/src/prompts.ts`), and the test that greps prompts for names from the answer keys (step 7);
- the 10-value blind re-key sample on read contracts (§6). Only hand-typed contracts get a blind re-type today;
- the test that only `packages/extraction` imports a model SDK (§9);
- the held-out development set and lockbox runs (step 8).

## History

These record how Phase 1 was planned and first built. They keep decisions and bugs worth knowing, and they are not kept up to date. Where a section is out of date it says "Superseded" and points to the current doc.

| Doc | What it is | Status |
|---|---|---|
| [PHASE-1.md](PHASE-1.md) | The Phase 1 plan of 2026-10-25: decisions, journeys, the interfaces between workstreams | Partly superseded (marked inline). The routes as built are in api.md |
| [phase-1/extraction.md](phase-1/extraction.md) | Workstream B log for `packages/extraction`: decisions, resource limits, the 2026-10-26 cost decision | Limits and model choices current; accuracy and cost estimates superseded (marked inline) |
| [phase-1/testing.md](phase-1/testing.md) | Integration testing: how the e2e runs and what it covers, the API's write and job suites, then the first integration pass's bugs | Top sections current; "Earlier integration notes" are history |
| [phase-1/web.md](phase-1/web.md) | Workstream C log: the first build of the web | History: the screens and review flow were replaced on 2026-10-28 |
