# EREBUS

**A recursive intelligence platform that generates, adversarially challenges, and continuously refines theories about world events.**

> **Status:** This repository documents EREBUS's architecture and module layout. The core services are being ported in from an earlier prototype; the design, data model, and module boundaries below are stable. See the [Roadmap](#roadmap).

---

## Overview

EREBUS ingests real-world events and builds a recursive **Theory Tree** of competing explanations. Every theory is stress-tested by a **Shadow Board**: a panel of seven deception-analysis lenses drawn from structured intelligence-analysis tradecraft. Background workers continuously re-embed new information, surface related theories by vector similarity, and re-score the tree so its conclusions stay current.

The goal is not to produce one confident answer, but to hold many explanations at once, attack each of them honestly, and track how well each survives scrutiny over time.

## Core ideas

- **Theory Tree.** Each node is a hypothesis that can branch into sub-hypotheses. Expansion runs under explicit depth and branch budgets so the search stays bounded and legible.
- **Shadow Board (seven lenses).** Each lens independently red-teams a theory for one specific failure mode and returns a structured verdict (verdict, severity, rationale). The seven lenses are source reliability, confirmation bias, denial and deception, analysis of competing hypotheses, incentive analysis, logical coherence, and base rates. See [`docs/shadow-board.md`](docs/shadow-board.md).
- **Continuous refinement.** Workers embed events and theories into `pgvector`, link related theories by similarity, and re-run scoring as new evidence arrives.

## Tech stack

| Layer | Choice |
|------|--------|
| Frontend | Next.js (App Router), React, Tailwind |
| API | Hono (TypeScript) |
| Data | PostgreSQL 16 + pgvector |
| LLM | Anthropic Claude API |
| Workers | Node background workers + scheduler |
| Monorepo | pnpm workspaces + Turborepo |

## Repository layout

```
erebus/
├── apps/
│   ├── web/                     Next.js dashboard (Theory Tree + Shadow Board UI)
│   │   ├── app/                 routes: dashboard, theory detail
│   │   ├── components/          TheoryTree, ShadowBoard, EventFeed
│   │   └── lib/                 typed API client
│   └── api/                     Hono API
│       └── src/
│           ├── routes/          theories, events, shadowboard
│           ├── engine/          theory tree, recursion control, scoring
│           ├── shadowboard/     board + the seven lenses
│           └── llm/             Claude client + prompt templates
├── packages/
│   ├── db/                      schema, client, pgvector helpers, migrations
│   └── core/                    shared domain types
├── workers/                     theory refiner, embedding indexer, scheduler
└── docs/                        architecture and Shadow Board notes
```

## How it works

1. Events are ingested and embedded into `pgvector`.
2. The Theory Tree engine expands one or more root hypotheses, branching under depth and branch budgets.
3. Each node is sent to the Shadow Board; the seven lenses red-team it in parallel and return verdicts.
4. Scoring combines lens verdicts, supporting evidence, and novelty into a confidence score.
5. Workers re-embed new events, link related theories, and re-score, keeping the tree current.

## Quickstart

```bash
cp .env.example .env          # add your ANTHROPIC_API_KEY
docker compose up -d          # Postgres (pgvector) + Redis
pnpm install
pnpm dev                      # web + api
pnpm workers                  # background refinement
```

## Roadmap

- [ ] Port the Theory Tree engine (expansion, branching, pruning)
- [ ] Port the seven Shadow Board lenses
- [ ] Wire continuous-refinement workers
- [ ] Theory Tree visualization in the web app
- [ ] Evaluation: track calibration of confidence scores against outcomes

## License

[MIT](LICENSE)
