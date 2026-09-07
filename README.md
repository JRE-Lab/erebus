# EREBUS

**Emergent Recursive Exploration & Branching Understanding System** — a
forward-branching forecast tree that greens as reality confirms it, with a
game-theory decision layer, a deception (Shadow Board) layer, an autonomous
theory factory, and **LOOM**, a narrative-intelligence layer that watches how
stories move and feeds the tree back.

| Read this for… | File |
|---|---|
| What it is, where it runs, contracts, how to operate it | [`HANDOFF.md`](HANDOFF.md) |
| The original v2 blueprint + build status | [`CLAUDE.md`](CLAUDE.md) |
| The LOOM specification (modules M1–M12, rules R1–R8) | `LOOM_SPEC.md` (operator's copy) |
| The deep code review that drove the hardening pass | [`docs/CODE_REVIEW_2026-07.md`](docs/CODE_REVIEW_2026-07.md) |
| Every tunable knob, commented | [`.env.example`](.env.example) |

## Layout
pnpm + Turborepo monorepo. `apps/web` (Next 15 UI + Hono API at `/api`),
`apps/worker` (timer ticks + continuous roam), `packages/{db, agents, core,
ingest, market, gametheory, shadowboard, gardener, evals, content, loom}`.
Postgres 16 + pgvector, Drizzle ORM, migrations in `packages/db/drizzle`.

## Local
```bash
pnpm install && docker compose up -d
pnpm --filter @erebus/db migrate
pnpm dev        # web
pnpm worker     # autonomous loop
```
Copy `.env.example` to `.env`. Blank `EREBUS_PASS` fails closed (503) — set
`EREBUS_ALLOW_NO_AUTH=1` for open local dev. Never commit `.env`.

## Discipline
Fallback LLM output never persists; only `embedStrict()` writes vectors; one
judgment per (signal, node); a shared daily budget is enforced inside every
model call and fails closed; forecasts are append-only. Every phase shipped
after an adversarial multi-agent review of the diff. Details in `HANDOFF.md` §5.
