# EREBUS v2

**A recursive intelligence platform that generates, adversarially challenges, and continuously refines theories about world events — with live data ingestion, evidence confirmation tracking, and autonomous agents.**

---

## What it does

EREBUS ingests real-world events, builds a recursive **Theory Tree** of competing explanations, stress-tests each theory with a seven-lens **Shadow Board**, and then **tracks whether each branch actually comes true** against incoming news. Background workers keep the whole picture current without you touching it.

### The four pillars
- **Live ingestion** — RSS/news pollers fetch events, embed them into `pgvector`, dedup, and feed the tree.
- **Theory Tree** — recursive hypotheses (Opus-powered expansion) under explicit depth/branch budgets. Indigo = you, amber = EREBUS.
- **Shadow Board** — seven independent red-team lenses (source reliability, confirmation bias, denial & deception, ACH, incentives, logical coherence, base rates) score each theory.
- **Evidence tracking** — every branch is auto-checked against ingested events and marked `confirmed` / `partial` / `disconfirmed` / `pending`, with a live colour-coded tree.
- **Autonomous agents** — a scheduler runs ingestion, tree expansion, evidence sweeps, and re-scoring on intervals, within a daily LLM budget.

## Stack

| Layer | Choice |
|------|--------|
| Monorepo | pnpm workspaces + Turborepo |
| API | Hono (TypeScript), WebSocket live updates |
| Web | Next.js 15 (App Router), React 19, Tailwind v4 |
| Data | PostgreSQL 16 + pgvector |
| LLM | Anthropic Claude (model-swappable: deep/fast), cost-tracked, offline fallback |
| Embeddings | Voyage / OpenAI / deterministic offline fallback |
| Auth | Basic-auth gate (dashboard + API) |

## Layout

```
erebus/
├── apps/
│   ├── api/   Hono API — engine/ (theory tree, scoring), shadowboard/, evidence/, ingestion/, routes/, workers/, llm/
│   └── web/   Next.js dashboard — Theory Tree viz, Shadow Board, Evidence panel, Event feed, Sources, Settings
├── packages/
│   ├── core/  shared types + constants (the seven lenses, colours, budgets)
│   └── db/    Postgres schema, client, pgvector + embeddings helpers
└── docker-compose.yml / docker-compose.prod.yml
```

## Run locally

```bash
cp .env.example .env            # add ANTHROPIC_API_KEY (optional — runs offline without it)
docker compose up -d            # Postgres (pgvector) + Redis
pnpm install
pnpm --filter @erebus/db push   # apply schema
pnpm --filter @erebus/db seed   # seed default news sources
pnpm dev                        # api :8787 + web :3000
```

Open http://localhost:3000.

## Deploy (VPS)

```bash
# on the server, in the repo:
cp .env.example .env            # set EREBUS_PASS, ANTHROPIC_API_KEY, POSTGRES_PASSWORD
bash scripts/deploy.sh          # builds + starts the prod stack on :4000 (web) / :4001 (api)
```

The production stack uses ports 4000/4001/5433/6380 to stay isolated from anything else on the box.

## Offline mode

With no `ANTHROPIC_API_KEY`, EREBUS still runs: ingestion, the tree, the dashboard, and evidence scaffolding all work; LLM-generated content is flagged `[offline]` until a key is added. Add credits and the same buttons produce real analysis.
