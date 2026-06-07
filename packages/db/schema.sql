-- schema.sql: core PostgreSQL schema for EREBUS.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  source TEXT,
  title TEXT,
  body TEXT,
  observed_at TIMESTAMPTZ DEFAULT now(),
  embedding vector(3072)
);

CREATE TABLE theories (
  id BIGSERIAL PRIMARY KEY,
  root_event_id BIGINT REFERENCES events(id),
  summary TEXT,
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE theory_nodes (
  id BIGSERIAL PRIMARY KEY,
  theory_id BIGINT REFERENCES theories(id),
  parent_id BIGINT REFERENCES theory_nodes(id),
  hypothesis TEXT,
  score REAL,
  depth INT
);

CREATE TABLE lens_verdicts (
  id BIGSERIAL PRIMARY KEY,
  node_id BIGINT REFERENCES theory_nodes(id),
  lens TEXT,
  verdict TEXT,
  severity REAL,
  rationale TEXT
);
