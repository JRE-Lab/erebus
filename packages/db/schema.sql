-- ============================================================================
-- EREBUS v2 — PostgreSQL schema (Postgres 16 + pgvector)
-- Embedding dimension: 1024 (Voyage voyage-3.5 / offline fallback).
-- Idempotent: safe to run repeatedly.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- EVENTS — ingested real-world signals (news, RSS, manual)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'manual',
  source_type   TEXT NOT NULL DEFAULT 'manual',        -- rss | newsapi | manual | api
  url           TEXT,
  title         TEXT NOT NULL,
  body          TEXT,
  author        TEXT,
  published_at  TIMESTAMPTZ,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedup_hash    TEXT UNIQUE,                            -- sha256 of normalized title+url
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding     vector(1024)
);
CREATE INDEX IF NOT EXISTS idx_events_observed ON events (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source ON events (source);
CREATE INDEX IF NOT EXISTS idx_events_embedding ON events USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- THEORIES — top-level hypotheses about why something is happening
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT UNIQUE,                          -- e.g. T-015
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL DEFAULT '',
  full_analysis    TEXT NOT NULL DEFAULT '',
  confidence       TEXT NOT NULL DEFAULT 'EMERGING',     -- SPECULATIVE|EMERGING|MEDIUM|HIGH|CONFIRMED|DEAD
  score            REAL NOT NULL DEFAULT 0.5,            -- 0..1 computed confidence
  status           TEXT NOT NULL DEFAULT 'ACTIVE',       -- ACTIVE|DORMANT|DEAD|ARCHIVED
  domains          TEXT[] NOT NULL DEFAULT '{}',
  is_shadow        BOOLEAN NOT NULL DEFAULT FALSE,       -- deception/red-team theory
  novelty          JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_everything TEXT,
  root_event_id    BIGINT REFERENCES events(id) ON DELETE SET NULL,
  embedding        vector(1024),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_theories_status ON theories (status);
CREATE INDEX IF NOT EXISTS idx_theories_updated ON theories (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_theories_embedding ON theories USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- THEORY_NODES — recursive Theory Tree
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theory_nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theory_id           UUID NOT NULL REFERENCES theories(id) ON DELETE CASCADE,
  parent_id           UUID REFERENCES theory_nodes(id) ON DELETE CASCADE,
  hypothesis          TEXT NOT NULL,                     -- the question/branch label
  content             TEXT NOT NULL DEFAULT '',          -- the analysis at this node
  questions           JSONB NOT NULL DEFAULT '[]'::jsonb,-- generated follow-up questions
  wildcard            TEXT,
  key_insight         TEXT,
  depth               INT NOT NULL DEFAULT 0,
  score               REAL NOT NULL DEFAULT 0.5,
  explored_by         TEXT NOT NULL DEFAULT 'user',      -- user | erebus
  shadow_tagged       BOOLEAN NOT NULL DEFAULT FALSE,
  financial_signal    BOOLEAN NOT NULL DEFAULT FALSE,
  -- evidence confirmation tracking
  evidence_status     TEXT NOT NULL DEFAULT 'pending',   -- pending|confirmed|partial|disconfirmed
  evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_checked_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nodes_theory ON theory_nodes (theory_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON theory_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_evidence ON theory_nodes (evidence_status);

-- ---------------------------------------------------------------------------
-- LENS_VERDICTS — Shadow Board (seven lenses) output
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lens_verdicts (
  id          BIGSERIAL PRIMARY KEY,
  theory_id   UUID REFERENCES theories(id) ON DELETE CASCADE,
  node_id     UUID REFERENCES theory_nodes(id) ON DELETE CASCADE,
  lens        TEXT NOT NULL,                             -- sourceReliability | confirmationBias | ...
  verdict     TEXT NOT NULL,                             -- pass | warn | fail
  severity    REAL NOT NULL DEFAULT 0,                   -- 0..1
  confidence  REAL NOT NULL DEFAULT 0.5,
  rationale   TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verdicts_theory ON lens_verdicts (theory_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_node ON lens_verdicts (node_id);

-- ---------------------------------------------------------------------------
-- THEORY_CONNECTIONS — relationships between theories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS theory_connections (
  id           BIGSERIAL PRIMARY KEY,
  a_id         UUID NOT NULL REFERENCES theories(id) ON DELETE CASCADE,
  b_id         UUID NOT NULL REFERENCES theories(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,                            -- supports|contradicts|tension|explains|predicts|deepens
  strength     REAL NOT NULL DEFAULT 0.5,
  rationale    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_connection CHECK (a_id <> b_id)
);
CREATE INDEX IF NOT EXISTS idx_conn_a ON theory_connections (a_id);
CREATE INDEX IF NOT EXISTS idx_conn_b ON theory_connections (b_id);

-- ---------------------------------------------------------------------------
-- EVIDENCE_LINKS — events linked to nodes as supporting/contradicting evidence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_links (
  id         BIGSERIAL PRIMARY KEY,
  node_id    UUID NOT NULL REFERENCES theory_nodes(id) ON DELETE CASCADE,
  event_id   BIGINT REFERENCES events(id) ON DELETE CASCADE,
  stance     TEXT NOT NULL,                              -- supporting | contradicting
  weight     REAL NOT NULL DEFAULT 0.5,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evlinks_node ON evidence_links (node_id);

-- ---------------------------------------------------------------------------
-- PREDICTIONS — testable, dated forecasts derived from theories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS predictions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theory_id   UUID NOT NULL REFERENCES theories(id) ON DELETE CASCADE,
  statement   TEXT NOT NULL,
  deadline    TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'PENDING',           -- PENDING|CONFIRMED|REFUTED|EXPIRED
  confidence  REAL NOT NULL DEFAULT 0.5,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pred_theory ON predictions (theory_id);
CREATE INDEX IF NOT EXISTS idx_pred_status ON predictions (status);

-- ---------------------------------------------------------------------------
-- CONFIDENCE_HISTORY — audit trail of confidence changes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS confidence_history (
  id         BIGSERIAL PRIMARY KEY,
  theory_id  UUID NOT NULL REFERENCES theories(id) ON DELETE CASCADE,
  level      TEXT NOT NULL,
  score      REAL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_confhist_theory ON confidence_history (theory_id);

-- ---------------------------------------------------------------------------
-- FEED_ITEMS — activity stream (what EREBUS did / found)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_items (
  id                 BIGSERIAL PRIMARY KEY,
  type               TEXT NOT NULL,                      -- theory_update|evidence|connection|shadow|ingestion|system
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'MEDIUM',     -- LOW|MEDIUM|HIGH|CRITICAL
  related_theory_ids TEXT[] NOT NULL DEFAULT '{}',
  read               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_items (created_at DESC);

-- ---------------------------------------------------------------------------
-- SOURCES — ingestion source registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'rss',               -- rss | newsapi
  url         TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  tier        INT NOT NULL DEFAULT 2,
  last_polled TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'healthy',           -- healthy|degraded|down
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_url ON sources (url);

-- ---------------------------------------------------------------------------
-- COST_ENTRIES — LLM spend tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cost_entries (
  id            BIGSERIAL PRIMARY KEY,
  model         TEXT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  agent         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_entries (created_at DESC);

-- ---------------------------------------------------------------------------
-- SETTINGS — key/value app config (API keys, toggles)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
