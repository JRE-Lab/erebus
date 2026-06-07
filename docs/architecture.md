# Architecture

EREBUS is a TypeScript monorepo (pnpm + Turborepo) with three runtimes: a Next.js web app, a Hono API, and a set of Node background workers, all backed by PostgreSQL 16 with the pgvector extension and the Anthropic Claude API.

## Flow

1. Events are ingested and embedded into pgvector.
2. The Theory Tree engine expands one or more root hypotheses, branching into sub-hypotheses under depth and branch budgets.
3. Each node is sent to the Shadow Board, where seven independent lenses red-team it for a specific failure mode and return structured verdicts.
4. Scoring combines lens verdicts, evidence and novelty into a confidence score.
5. Background workers re-embed new events, surface related theories by similarity, and re-run scoring so the tree stays current.
