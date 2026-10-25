# DCT AI Finance: What We're Building

## In one line

A tool that reads DCT's sponsor contracts, checks DCT's billing data from Clinical Conductor against them, and shows every place DCT **missed charging, charged wrong, or wasn't paid**, with the $ amount and proof.

## How it works

```
Contract PDF ──► AI reads it ──► Rulebook (every fee, cap, deadline, with page refs)
                                      │  accountant reviews + signs off
CTMS exports ──► Import ──────────────┤
                                      ▼
                          Anomaly engine (one small rule per loss type)
                                      ▼
                    Anomalies list: what · $ · days left · proof
```

## Phases

### Phase 1: Contracts
- Upload a contract PDF; the AI (Claude) extracts the **rulebook**.
- Automatic contract checks:
  - totals add up
  - overhead matches its label
  - no two conflicting budget tables
  - no duplicate items
  - no missing master agreements
- Review screen: each number next to its contract page → **sign off** → locked, versioned.

**Done when:** all 4 real contracts are extracted correctly, and McAllen's conflicting tables are flagged.

### Phase 2: Billing anomalies
- Import CTMS exports (visits, invoices).
- Rules:
  - screen fails over the cap
  - billed rate ≠ contract rate
  - fees in the contract never billed
  - days left before an item can no longer be invoiced
- Anomalies screen: filter by study, type, $, urgency; each anomaly shows the contract clause + CTMS row.

**Done when:** on COPD data it finds what we found by hand: $52,185 screen fails, $1,120 vs $800 rate, $12,000 admin fee.

### Phase 3: Payments
- Import sponsor payments.
- Match payments to invoices: short payments, unapplied cash, lump sums.
- Overview dashboard: billed / paid / open / at risk, by study and site.

**Done when:** COPD shows $1,086 short-paid and $9,420.04 unapplied, and the lump sums are matched.

### Phase 4: More anomaly rules
One rule at a time, as data arrives:
- missed procedures inside visits
- annual fees
- holdback (5%) not collected
- duplicate billing
- stipend refunds
- dispute-window timers
- amendments not applied

### Phase 5: Invoices + QuickBooks
- Build invoices only from lines that pass every check (or are overridden by a named person with a reason).
- QuickBooks import file with control numbers.

### Phase 6: Handover
- Move to DCT's Forgejo, behind an on/off switch.
- Their review, their deploy.

## Stack

| Part | Tech |
|---|---|
| Frontend | Next.js · Tailwind (`apps/web`) |
| Backend | Fastify · Drizzle · Postgres · pg-boss (`apps/api`, added in Phase 1) |
| AI | Claude Opus 5.5 via DCT's Anthropic key, all calls through one wrapper |
| Language | TypeScript throughout |

## Rules we follow from day one

- Real contracts and exports live in `data/`, which is **never committed**.
- Only contracts go to the AI. Patient data never does.
- No secrets in code: `.env` only.
- Every rule has a test. No anomaly is shown without its proof.
