// ============================================================================
// EREBUS v2 — Drizzle schema (forecast-centric). Mirrors CLAUDE.md §7.
// Embedding dimension: 1536 (offline fallback now; OpenAI 3-small drops in).
// ============================================================================
import {
  pgTable,
  text,
  uuid,
  timestamp,
  real,
  integer,
  boolean,
  jsonb,
  vector,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const EMB_DIM = 1536;

// --- nodes: the Forecast Tree; each node IS a forecast ----------------------
export const nodes = pgTable(
  "nodes",
  {
    id: text("id").primaryKey(), // 'T-001' roots; generated ids for branches
    uuid: uuid("uuid").defaultRandom().notNull(),
    question: text("question").notNull(),
    outcome: text("outcome").notNull(), // the not-yet-happened answer (forecast)
    rationale: text("rationale"),
    indicators: text("indicators").array().notNull().default([]), // CONFIRM -> green
    falsifiers: text("falsifiers").array().notNull().default([]), // REFUTE -> red
    horizon: timestamp("horizon", { withTimezone: true }),
    branchLabel: text("branch_label"),
    parentId: text("parent_id").references((): AnyPgColumn => nodes.id),
    synthesizedFrom: text("synthesized_from").array().notNull().default([]),
    confirmation: real("confirmation").notNull().default(0), // THE GREEN LEVEL (derived from probability: 2p-1)
    probability: real("probability").notNull().default(0.5), // Bayesian P(outcome) — log-odds updated
    hypotheses: jsonb("hypotheses").notNull().default([]), // ACH rival outcomes [{label,probability}]
    confidence: real("confidence").notNull().default(0.5), // internal (debate), secondary
    stability: real("stability").notNull().default(0.5), // equilibrium stability [0..1] (game read)
    equilibriumType: text("equilibrium_type"), // nash|subgame_perfect|mixed|focal|none
    state: text("state").notNull().default("speculative"),
    // speculative|corroborating|corroborated|contradicted|tipping|resolved_true|resolved_false|dormant|merged
    resolved: boolean("resolved"),
    resolvedOutcome: boolean("resolved_outcome"), // did it ACTUALLY happen (external truth)
    resolvedSource: text("resolved_source"), // market|operator
    brier: real("brier"),
    isLaunchPoint: boolean("is_launch_point").notNull().default(false),
    origin: text("origin").notNull().default("user"), // user | erebus (autonomous)
    domains: text("domains").array().notNull().default([]),
    embedding: vector("embedding", { dimensions: EMB_DIM }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    mergedInto: text("merged_into").references((): AnyPgColumn => nodes.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index("nodes_parent_idx").on(t.parentId),
    stateIdx: index("nodes_state_idx").on(t.state),
  })
);

// --- signals: ingested reality ----------------------------------------------
export const signals = pgTable("signals", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source"),
  url: text("url"),
  title: text("title"),
  summary: text("summary"),
  dedupHash: text("dedup_hash").unique(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  embedding: vector("embedding", { dimensions: EMB_DIM }),
});

// --- signal_matches: the greening linkage -----------------------------------
export const signalMatches = pgTable(
  "signal_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    effect: text("effect").notNull(), // confirm|refute|neutral
    weight: real("weight").notNull().default(0.5),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ nodeIdx: index("matches_node_idx").on(t.nodeId) })
);

// --- relationships ----------------------------------------------------------
export const relationships = pgTable("relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromNode: text("from_node").references(() => nodes.id, { onDelete: "cascade" }),
  toNode: text("to_node").references(() => nodes.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // supports|contradicts|depends_on|validates|tension
  strength: real("strength").notNull().default(0.5),
  rationale: text("rationale").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- shadow_reads -----------------------------------------------------------
export const shadowReads = pgTable("shadow_reads", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  revealedPreference: text("revealed_preference"),
  cuiBono: text("cui_bono"),
  counterNarrative: text("counter_narrative"),
  deceptionIndicators: text("deception_indicators").array().notNull().default([]),
  misdirection: text("misdirection"),
  spawnedNode: text("spawned_node").references((): AnyPgColumn => nodes.id),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- debates ----------------------------------------------------------------
export const debates = pgTable("debates", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  round: integer("round"),
  proposer: text("proposer"),
  adversary: text("adversary"),
  synthesis: text("synthesis"),
  verdict: text("verdict"),
  confidenceDelta: real("confidence_delta"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- events: provenance (every state/confirmation change) -------------------
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    kind: text("kind"), // confirmation_change|state_change|link_created|synthesized|resolved|created
    causeType: text("cause_type"), // signal_match|debate|shadow_read|job
    causeId: uuid("cause_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ nodeIdx: index("events_node_idx").on(t.nodeId) })
);

// --- exploration_jobs -------------------------------------------------------
export const explorationJobs = pgTable("exploration_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type"), // expand|challenge|connect|synthesize|shadow|ingest|match
  targetNode: text("target_node").references(() => nodes.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"),
  result: jsonb("result"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// --- gardener_actions -------------------------------------------------------
export const gardenerActions = pgTable("gardener_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action"), // prune|merge|decay (NEVER prunes speculation)
  nodeId: text("node_id"),
  relatedNode: text("related_node"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- worldview_snapshots ----------------------------------------------------
export const worldviewSnapshots = pgTable("worldview_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  summary: text("summary"),
  nodeCount: integer("node_count"),
  greenCount: integer("green_count"),
  calibrationScore: real("calibration_score"),
  novelLinks: jsonb("novel_links"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- content_items (profit engine) ------------------------------------------
export const contentItems = pgTable("content_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  title: text("title"),
  script: text("script"),
  caption: text("caption"),
  data: jsonb("data").notNull().default({}), // { hook, scenes:[{narration,imagePrompt,image}], ... }
  audioUrl: text("audio_url"),
  videoUrl: text("video_url"),
  platform: text("platform"),
  status: text("status").notNull().default("draft"), // draft|scripted|visualized|voiced|rendered|published
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- game_reads: structured game-theory analysis per node -------------------
// Players + payoffs + the predicted equilibrium + stability + the decision layer
// (focal point, leverage move, no-regret action, reversal tripwire). The forecast
// becomes a falsifiable CLAIM: "this outcome IS the stable equilibrium".
export const gameReads = pgTable(
  "game_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    players: jsonb("players").notNull().default([]), // [{name,type,payoffRanking,batna,dominantStrategy,patience}]
    gameType: text("game_type"), // one_shot|repeated|sequential
    predictedEquilibrium: text("predicted_equilibrium"),
    equilibriumType: text("equilibrium_type"), // nash|subgame_perfect|mixed|focal|none
    outcomeIsEquilibrium: boolean("outcome_is_equilibrium"),
    stability: real("stability"), // [0..1]
    fragilityDrivers: text("fragility_drivers").array().notNull().default([]),
    // decision layer
    focalPoint: text("focal_point"),
    leverageMoves: jsonb("leverage_moves").notNull().default([]), // [{actor,move,mechanism,expectedShift,reversibility}]
    noRegretAction: text("no_regret_action"),
    reversalTripwire: text("reversal_tripwire"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ nodeIdx: index("game_reads_node_idx").on(t.nodeId) })
);

// --- node_instruments: theory <-> market instrument links (correlation) -----
// Each row says "if this theory is TRUE, this instrument should move <expectation>".
// Significant aligned/opposed price moves become market signals that green/contradict.
export const nodeInstruments = pgTable(
  "node_instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(), // catalog symbol, e.g. "CL" "XLE" "^SPX"
    name: text("name").notNull(), // human label, e.g. "WTI Crude Oil"
    kind: text("kind").notNull(), // commodity|equity|index|fx|crypto
    expectation: text("expectation").notNull().default("up"), // theory true -> up|down
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ nodeIdx: index("node_instruments_node_idx").on(t.nodeId) })
);

// --- alerts: things the operator should know NOW -----------------------------
// Derived from events by the worker's alert tick: a node greened / tipped /
// contradicted, a reversal tripwire fired, a dark theory was born, a forecast
// resolved. Rendered in the Explorer bell; optionally pushed via Telegram.
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // greened|tipping|contradicted|resolved|genesis|dark_genesis|fragile
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (t) => ({ createdIdx: index("alerts_created_idx").on(t.createdAt) })
);

// --- settings: key/value app config (autonomous toggle, etc.) ---------------
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  nodes,
  signals,
  signalMatches,
  relationships,
  shadowReads,
  debates,
  events,
  explorationJobs,
  gardenerActions,
  worldviewSnapshots,
  contentItems,
  nodeInstruments,
  gameReads,
  alerts,
  settings,
};
