# DCT Finance

Turns clinical-trial site contracts into an approved **rulebook** for Discovery Clinical Trials' accountants. An AI agent reads the contract bundle; code checks everything it writes; only real decisions reach a person. Design: [docs/superpowers/specs/2026-11-05-contract-harness-design.md](docs/superpowers/specs/2026-11-05-contract-harness-design.md). Working rules: [AGENTS.md](AGENTS.md).

> Status: rebuilding on `feature/contract-harness`. The app is currently a bare skeleton (health probes and an empty web shell).

## Quick start

Needs Node 24 (`.nvmrc`), pnpm 10, and Apple [`container`](https://github.com/apple/container) (Postgres 16 runs in `dct-postgres` on port 5434). Google Chrome only for browser tests.

```sh
cp .env.example .env     # fill in keys
pnpm run setup           # install, start Postgres, apply migrations
pnpm dev                 # Postgres + API (4100) + web (3100)
```

| Command | What it does |
|---|---|
| `pnpm test` | All unit and API tests (needs Postgres; uses `dct_finance_test`) |
| `pnpm e2e` | Browser tests against production builds (`dct_finance_e2e`, ports 3301/4301) |
| `pnpm -r typecheck` / `pnpm lint` | Types and lint |
| `pnpm db:start` / `pnpm db:stop` | Start or stop Postgres |
