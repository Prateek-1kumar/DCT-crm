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
| [ADR-001](phase-1/adr-001-extraction-evidence.md) | Contract extraction requires evidence for every value: a value is unconfirmed until the PDF's own text or a person confirms it; approval is gated on invariants I1–I6 | **Proposed** (2026-10-28), and largely built. See below |

**ADR-001, what is built** (checked in code on 2026-10-29; details and the product choices made while building are in its "Implementation notes"): the text layer, the binder and the evidence ledger (steps 1–2); the coverage sweep and the bill-by-hand (`unclassified`) list (part of step 3); the $20 runaway cap (part of step 4); the API's gate (step 5); the review lists of §6: interpretations picked blind, the bill-by-hand list and the 10-value blind sample with its miss gate (most of step 6); scan mode (part of step 7); the test that only `packages/extraction` imports a model SDK (§9).

**Not built yet:**
- schema version 2: `other` plus `asWritten` on every enum, `perPatientTotals[].visitCodes` (step 3);
- reading every page for terms: the classifier still decides which pages go to the terms reader. The sweep covers every text page;
- removing the second read, the OpenAI client, `LOW_CONFIDENCE`, `AI_DISAGREEMENT` and cost-based re-read skipping. They still run, but are never asked about (step 4);
- the prompt and check clean-up of §8, including the deadlines prompt's "only these kinds" (`packages/extraction/src/prompts.ts`), and the test that greps prompts for names from the answer keys (step 7);
- dismissing a whole section at once (§6), and the §9 hashes stored with a sign-off;
- the held-out development set and lockbox runs (step 8).

The first four need prompt changes and a live eval, which the owner hasn't approved.

## History

These record how Phase 1 was planned and first built. They keep decisions and bugs worth knowing, and they are not kept up to date. Where a section is out of date it says "Superseded" and points to the current doc.

| Doc | What it is | Status |
|---|---|---|
| [PHASE-1.md](PHASE-1.md) | The Phase 1 plan of 2026-10-25: decisions, journeys, the interfaces between workstreams | Partly superseded (marked inline). The routes as built are in api.md |
| [phase-1/extraction.md](phase-1/extraction.md) | Workstream B log for `packages/extraction`: decisions, resource limits, the 2026-10-26 cost decision | Limits and model choices current; accuracy and cost estimates superseded (marked inline) |
| [phase-1/testing.md](phase-1/testing.md) | Integration testing: how the e2e runs and what it covers, the API's write and job suites, then the first integration pass's bugs | Top sections current; "Earlier integration notes" are history |
| [phase-1/web.md](phase-1/web.md) | Workstream C log: the first build of the web | History: the screens and review flow were replaced on 2026-10-28. Its first section lists what the web does now that the log doesn't |
