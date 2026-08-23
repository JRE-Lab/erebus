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
  date,
  doublePrecision,
  vector,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }), // gardener decay clock — do NOT reuse
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }), // resolution-verify backoff (verify.ts)
    lastExpandedAt: timestamp("last_expanded_at", { withTimezone: true }), // selector rotation key
    expandBlocked: boolean("expand_blocked").notNull().default(false), // max-depth/max-children — never re-pick
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
export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source"),
    url: text("url"),
    title: text("title"),
    summary: text("summary"),
    dedupHash: text("dedup_hash").unique(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    embedding: vector("embedding", { dimensions: EMB_DIM }),
  },
  (t) => ({ ingestedIdx: index("signals_ingested_idx").on(t.ingestedAt) })
);

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
  (t) => ({
    nodeIdx: index("matches_node_idx").on(t.nodeId),
    // One judgment per (signal, node) — enforced in the DB so concurrent sweeps
    // can never double-apply Bayesian evidence.
    pairUq: uniqueIndex("signal_matches_pair_uq").on(t.signalId, t.nodeId),
  })
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
  (t) => ({
    nodeIdx: index("events_node_idx").on(t.nodeId),
    createdIdx: index("events_created_idx").on(t.createdAt), // alerts-tick cursor scans
  })
);

// --- exploration_jobs -------------------------------------------------------
export const explorationJobs = pgTable(
  "exploration_jobs",
  {
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
  },
  (t) => ({
    finishedIdx: index("jobs_finished_idx").on(t.finishedAt), // sargable budget scans
    targetIdx: index("jobs_target_idx").on(t.targetNode), // FK delete support
  })
);

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
  (t) => ({
    createdIdx: index("alerts_created_idx").on(t.createdAt),
    seenIdx: index("alerts_seen_idx").on(t.seenAt), // unseen-count bell poll
  })
);

// ============================================================================
// LOOM — narrative intelligence layer (Phase 0: ingestion + dual timestamps).
// R1: every article stores published_at (claimed by the feed) AND first_seen_at
// (observed by our poller). All downstream event studies key on first_seen_at.
// Embeddings deliberately share EREBUS's 1536-dim space (one model, one space).
// ============================================================================
export const loomOutlets = pgTable("loom_outlets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  country: text("country"),
  lang: text("lang"),
  isWire: boolean("is_wire").notNull().default(false),
});

export const loomArticles = pgTable(
  "loom_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    urlCanon: text("url_canon").notNull().unique(),
    outletId: uuid("outlet_id").references(() => loomOutlets.id),
    title: text("title"),
    lede: text("lede"),
    textHash: text("text_hash"),
    lang: text("lang"),
    publishedAt: timestamp("published_at", { withTimezone: true }), // claimed (R1)
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(), // observed (R1)
    gdeltRef: text("gdelt_ref"),
    embedding: vector("embedding", { dimensions: EMB_DIM }), // populated by the Phase 1 cluster tick
    narrativeId: uuid("narrative_id").references(() => loomNarratives.id, { onDelete: "set null" }),
  },
  (t) => ({
    firstSeenIdx: index("loom_articles_first_seen_idx").on(t.firstSeenAt),
    narrativeIdx: index("loom_articles_narrative_idx").on(t.narrativeId),
    hashIdx: index("loom_articles_hash_idx").on(t.textHash),
  })
);

export const loomWireReleases = pgTable(
  "loom_wire_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wireName: text("wire_name").notNull(),
    url: text("url").notNull().unique(),
    title: text("title"),
    lede: text("lede"),
    textHash: text("text_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true }), // claimed (R1)
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(), // observed (R1)
    embedding: vector("embedding", { dimensions: EMB_DIM }),
  },
  (t) => ({
    firstSeenIdx: index("loom_wires_first_seen_idx").on(t.firstSeenAt),
    hashIdx: index("loom_wires_hash_idx").on(t.textHash), // provenance fingerprint lookups (M2)
    // Case-insensitive title probe for the coordination provenance component;
    // without it that half of the match degrades to a full scan of a table
    // that grows every 15 minutes.
    titleIdx: index("loom_wires_title_lower_idx").on(sql`lower(${t.title})`),
  })
);

// LOOM Phase 1 — narratives. An article joins the nearest narrative within a
// trailing window when cosine similarity clears LOOM_SIM_THRESHOLD; otherwise
// it seeds a CANDIDATE cluster (promoted_at NULL). A candidate promotes to a
// real narrative at >= LOOM_PROMOTE_MIN_ARTICLES from >= _MIN_OUTLETS distinct
// outlets; the LLM labels it at promotion (offline-safe: label stays NULL and
// is retried). Lifecycle (spec M2): seeding -> amplifying -> peak -> decaying
// -> dormant, with reignition, driven by velocity with hysteresis.
export const loomNarratives = pgTable(
  "loom_narratives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label"), // NULL until the LLM labels it (post-promotion)
    labelAttempts: integer("label_attempts").notNull().default(0), // real (non-offline) label failures; capped
    summary: text("summary"),
    state: text("state").notNull().default("seeding"), // seeding|amplifying|peak|decaying|dormant
    centroid: vector("centroid", { dimensions: EMB_DIM }).notNull(), // running mean of member embeddings
    articleCount: integer("article_count").notNull().default(0),
    outletCount: integer("outlet_count").notNull().default(0),
    langCount: integer("lang_count").notNull().default(0),
    maxVel24: real("max_vel24").notNull().default(0), // high-water trailing-24h count (hysteresis anchor)
    seededAt: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }), // NULL = candidate cluster
    peakAt: timestamp("peak_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastStateChangeAt: timestamp("last_state_change_at", { withTimezone: true }),
    modelVer: text("model_ver"), // model that wrote label/summary
    // Phase 4 (intent/coordination) denormalized card fields
    frame: jsonb("frame"), // modal framing slots {protagonist,antagonist,threat,remedy,urgency,impliedAction}
    coordinationScore: real("coordination_score"), // 0-100
    coordCiLow: real("coord_ci_low"),
    coordCiHigh: real("coord_ci_high"),
    wireSharePct: real("wire_share_pct"), // provenance: share of articles matching wire copy
    firstMoverOutlet: text("first_mover_outlet"),
    achScoredAt: timestamp("ach_scored_at", { withTimezone: true }),
    achAttempts: integer("ach_attempts").notNull().default(0), // real (non-offline) ACH failures; capped
    entitiesScannedAt: timestamp("entities_scanned_at", { withTimezone: true }), // NER ran (even if it found nothing)
  },
  (t) => ({
    stateIdx: index("loom_narratives_state_idx").on(t.state),
    lastSeenIdx: index("loom_narratives_last_seen_idx").on(t.lastSeenAt), // trailing-window candidate scan
  })
);

// Hourly metrics per promoted narrative (spec narrative_metrics_hourly).
// Deliberate Phase 1 MVP cuts vs the spec's field list: reach_countries
// (loom_outlets.country is never populated yet — outlet enrichment is a later
// phase), tone_mean/tone_var (need GDELT tone codings; the BigQuery arm is
// stubbed), and amp_ratio (needs the M2 wire-copy coordination matcher,
// Phase 4). Lifecycle transitions likewise gate on velocity only for now —
// the spec's reach thresholds join in when reach data is richer than 3 feeds.
export const loomNarrativeMetrics = pgTable(
  "loom_narrative_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    vel24: integer("vel24").notNull().default(0), // articles in trailing 24h
    vel6: integer("vel6").notNull().default(0), // articles in trailing 6h
    accel: real("accel").notNull().default(0), // vel24 delta vs previous measurement
    reachOutlets: integer("reach_outlets").notNull().default(0), // distinct outlets, trailing 24h
    reachLangs: integer("reach_langs").notNull().default(0),
    articleCount: integer("article_count").notNull().default(0), // lifetime total at measurement
    state: text("state").notNull(), // state AFTER this measurement's transition
  },
  (t) => ({
    narrativeTsIdx: index("loom_metrics_narrative_ts_idx").on(t.narrativeId, t.ts),
  })
);

// Lifecycle transition log (Phase 1 acceptance: "transitions logged and sane").
export const loomNarrativeTransitions = pgTable(
  "loom_narrative_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    metrics: jsonb("metrics").notNull().default({}), // {vel24, vel6, accel, maxVel24} at transition
  },
  (t) => ({
    narrativeIdx: index("loom_transitions_narrative_idx").on(t.narrativeId),
  })
);

// ============================================================================
// LOOM Phase 2 — entity graph + market linkage (spec M3 + event studies).
// MVP cuts (documented): companies/countries/commodities only (people and
// institutions v2); aliases live as a jsonb array on the entity row instead of
// a separate table; company→ticker resolves via SEC company_tickers.json only
// (US-listed; OpenFIGI needs a key); sector 0.4 / supply-chain 0.2 exposure
// edges are v2 — Phase 2 ships direct 1.0 + country/commodity proxy edges.
// ============================================================================
export const loomEntities = pgTable(
  "loom_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // company|country|commodity
    canonName: text("canon_name").notNull(),
    aliases: jsonb("aliases").notNull().default([]), // string[]
    ticker: text("ticker"), // resolved symbol (companies; proxies live on exposures)
    cik: text("cik"), // SEC CIK when resolved (companies)
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindNameUq: uniqueIndex("loom_entities_kind_name_uq").on(t.kind, t.canonName),
  })
);

export const loomInstruments = pgTable("loom_instruments", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull().unique(),
  kind: text("kind").notNull(), // equity|etf|index
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// entity -> instrument exposure edges (spec: direct 1.0 | sector 0.4 | ...).
export const loomExposures = pgTable(
  "loom_exposures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => loomEntities.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => loomInstruments.id, { onDelete: "cascade" }),
    weight: real("weight").notNull(),
    kind: text("kind").notNull(), // direct|country_proxy|commodity_proxy
  },
  (t) => ({
    pairUq: uniqueIndex("loom_exposures_pair_uq").on(t.entityId, t.instrumentId),
  })
);

export const loomNarrativeEntities = pgTable(
  "loom_narrative_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => loomEntities.id, { onDelete: "cascade" }),
    salience: real("salience").notNull().default(0.5),
    sentiment: real("sentiment"),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_narr_entities_pair_uq").on(t.narrativeId, t.entityId),
  })
);

// Daily OHLCV per instrument (free feeds; the substrate for detectors + CARs).
export const loomPrices = pgTable(
  "loom_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => loomInstruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    open: doublePrecision("open"),
    high: doublePrecision("high"),
    low: doublePrecision("low"),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume"),
  },
  (t) => ({
    instDateUq: uniqueIndex("loom_prices_inst_date_uq").on(t.instrumentId, t.date),
  })
);

// Event studies keyed on narrative first-seen (R1): market model r_i = a + b*r_m
// estimated over <=120 trading days ending T-11; CAR windows [-10,-1] / [0,+1]
// / [+2,+10]. car_post stays NULL until the window closes (upserted later).
export const loomEventStudies = pgTable(
  "loom_event_studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => loomInstruments.id, { onDelete: "cascade" }),
    carPre: real("car_pre"),
    carEvent: real("car_event"),
    carPost: real("car_post"),
    modelMeta: jsonb("model_meta").notNull().default({}), // {alpha,beta,n,sigma,eventDate}
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_event_studies_pair_uq").on(t.narrativeId, t.instrumentId),
  })
);

// ============================================================================
// LOOM Phase 3 — positioning (spec M5) + regimes (M6 slice).
// MVP cuts (documented): detectors are vol_z + resid_ret (full) and
// insider_score as an EDGAR Form-4 filing-count z proxy (real per-insider
// cluster parsing is v2); si_delta and all options detectors (oi_jump,
// pc_skew, iv_pctl) are v2/vendor-gated. R4 is enforced at the SCHEMA level:
// placebo_pctl on flags is NOT NULL — a flag without its placebo percentile
// cannot exist.
// ============================================================================
export const loomPositioning = pgTable(
  "loom_positioning",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => loomInstruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    volZ: real("vol_z"), // volume z vs trailing 60d
    residRet: real("resid_ret"), // residual daily return vs market model
    insiderScore: real("insider_score"), // Form-4 filing-count z proxy (documented cut)
    siDeltaPctl: real("si_delta_pctl"), // v2 — always NULL for now
  },
  (t) => ({
    instDateUq: uniqueIndex("loom_positioning_inst_date_uq").on(t.instrumentId, t.date),
  })
);

// Daily regime state (spec M6 conditioner, threshold MVP): risk_on|neutral|risk_off
// from VIX level + short trend; HY OAS / breadth join when a data key exists.
export const loomRegimes = pgTable("loom_regimes", {
  date: date("date").primaryKey(),
  state: text("state").notNull(),
  vix: real("vix"),
  vixTrend: real("vix_trend"), // 5d VIX change
  meta: jsonb("meta").notNull().default({}),
});

// Placebo distributions (R4): the same composite computed on random
// instrument-date draws, stratified by regime. Stored per run so stability
// across runs is checkable (Phase 3 acceptance).
export const loomPlaceboRuns = pgTable("loom_placebo_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  regimeState: text("regime_state").notNull(),
  samples: integer("samples").notNull(),
  mean: real("mean").notNull(),
  sd: real("sd").notNull(),
  quantiles: jsonb("quantiles").notNull().default({}), // {p50,p75,p90,p95,p99}
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loomPrepositionFlags = pgTable(
  "loom_preposition_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => loomInstruments.id, { onDelete: "cascade" }),
    windowStart: date("window_start").notNull(), // [T-10d, T-1] keyed on first_seen (R1)
    windowEnd: date("window_end").notNull(),
    composite: real("composite").notNull(),
    detectors: jsonb("detectors").notNull().default({}), // which detectors fired, with values
    placeboPctl: real("placebo_pctl").notNull(), // R4: NOT NULL — no flag without it
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_preposition_pair_uq").on(t.narrativeId, t.instrumentId),
  })
);

// ============================================================================
// LOOM Phase 5 — analogs (M7), source/actor behavioral priors (M4), negative
// space (M10), playbook automation (M9).
// The spec builds M7 on a GDELT backfill; that arm needs a GCP project, so the
// matcher here runs on LOOM's OWN accumulating narrative history instead. It
// is cold at first and strengthens every day — and the min-analog rule below
// means a thin precedent set falls back to the hand-set prior and SAYS SO
// rather than inventing a confident number (spec risk: "analog overfit").
// Options-flow detectors and social velocity stay unbuilt: both need paid
// vendors (spec Q1), and there is no free substitute.
// ============================================================================
export const loomAnalogs = pgTable(
  "loom_analogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    analogNarrativeId: uuid("analog_narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    sim: real("sim").notNull(), // centroid cosine
    regimeMatch: boolean("regime_match").notNull().default(false),
    outcomeSummary: jsonb("outcome_summary").notNull().default({}), // {reachedPeak,hoursToPeak,maxVel,carEvent}
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_analogs_pair_uq").on(t.narrativeId, t.analogNarrativeId),
    narrativeIdx: index("loom_analogs_narrative_idx").on(t.narrativeId),
  })
);

// M4: behavioral priors per outlet, recomputed on a slow cadence. These are
// statistics ABOUT AN OUTLET, never evidence about a specific story (R5/R7).
export const loomOutletPriors = pgTable(
  "loom_outlet_priors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => loomOutlets.id, { onDelete: "cascade" }),
    narratives: integer("narratives").notNull().default(0), // narratives this outlet appeared in
    firstMoverRate: real("first_mover_rate").notNull().default(0), // share where it seeded
    wireDependence: real("wire_dependence").notNull().default(0), // share of its articles matching wire copy
    avgLeadHours: real("avg_lead_hours"), // mean hours ahead of the narrative's seed time
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ outletUq: uniqueIndex("loom_outlet_priors_outlet_uq").on(t.outletId) })
);

// M10: absence as signal. `kind` = asymmetry (coverage skew vs baseline) or
// displacement (a narrative decaying faster than its fitted curve while
// another surges).
export const loomNegativeSpace = pgTable(
  "loom_negative_space",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // asymmetry|displacement
    detail: jsonb("detail").notNull().default({}),
    z: real("z").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One row per (narrative, kind): findings are refreshed, never appended —
  // otherwise every pass adds another copy of the same signal to the card.
  (t) => ({ narrativeKindUq: uniqueIndex("loom_negative_space_narrative_kind_uq").on(t.narrativeId, t.kind) })
);

// ============================================================================
// LOOM Phase 4 — intent (M8), framing/coordination (M2 back-half), forecasts
// + scoring (M11), playbooks (M9 pilot).
// R2 is enforced in code at the single judgment write path AND at render:
// no judgment persists or serializes without runner-up + >=1 falsifier.
// R3: loom_forecasts is APPEND-ONLY by code discipline — there is no update
// path; resolutions live in their own table.
// ============================================================================
export const loomFraming = pgTable("loom_framing", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .unique()
    .references(() => loomArticles.id, { onDelete: "cascade" }),
  protagonist: text("protagonist"),
  antagonist: text("antagonist"),
  threat: text("threat"),
  remedy: text("remedy"),
  urgency: text("urgency"), // low|medium|high
  impliedAction: text("implied_action"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loomHypotheses = pgTable(
  "loom_hypotheses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    code: text("code").notNull(), // H1..H7 (fixed taxonomy, spec M8)
    score: real("score").notNull().default(0), // least-inconsistent wins
    rank: integer("rank").notNull().default(0),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_hypotheses_pair_uq").on(t.narrativeId, t.code),
  })
);

export const loomEvidence = pgTable(
  "loom_evidence",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  narrativeId: uuid("narrative_id")
    .notNull()
    .references(() => loomNarratives.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // coordination|provenance|first_mover|beneficiary|preposition|negative_space
  payload: jsonb("payload").notNull().default({}),
    consistency: jsonb("consistency").notNull().default({}), // {H1:"C"|"I"|"N",...} + rationale
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ narrativeIdx: index("loom_evidence_narrative_idx").on(t.narrativeId) })
);

export const loomJudgments = pgTable(
  "loom_judgments",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  narrativeId: uuid("narrative_id")
    .notNull()
    .references(() => loomNarratives.id, { onDelete: "cascade" }),
  topH: text("top_h").notNull(),
  topBand: text("top_band").notNull(), // ICD 203 estimative band
  runnerH: text("runner_h").notNull(), // R2: runner-up always present
  runnerBand: text("runner_band").notNull(),
  confidence: text("confidence").notNull(), // low|moderate|high (separate from likelihood)
    falsifiers: jsonb("falsifiers").notNull(), // string[], length >= 1 enforced at the write path
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ narrativeIdx: index("loom_judgments_narrative_idx").on(t.narrativeId, t.publishedAt) })
);

export const loomBeneficiaries = pgTable(
  "loom_beneficiaries",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  narrativeId: uuid("narrative_id")
    .notNull()
    .references(() => loomNarratives.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id").references(() => loomEntities.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  rationale: text("rationale"),
    falsifier: text("falsifier").notNull(), // each row carries its own falsifier (R2/R7)
    rank: integer("rank").notNull().default(0),
  },
  (t) => ({ narrativeIdx: index("loom_beneficiaries_narrative_idx").on(t.narrativeId) })
);

// Pre-registered forecasts (R3: append-only; no update path exists in code).
export const loomForecasts = pgTable(
  "loom_forecasts",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  narrativeId: uuid("narrative_id")
    .notNull()
    .references(() => loomNarratives.id, { onDelete: "cascade" }),
  claimType: text("claim_type").notNull(), // lifecycle|market_move|preposition
  targetRef: jsonb("target_ref").notNull().default({}), // e.g. {instrument:"XLE"} or {toState:"peak"}
  direction: text("direction"), // up|down (market_move)
  magnitudeBand: text("magnitude_band"), // e.g. "1-3%"
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  prob: real("prob").notNull(),
  regimeAtIssue: text("regime_at_issue"),
    modelVer: text("model_ver"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    narrativeIdx: index("loom_forecasts_narrative_idx").on(t.narrativeId, t.issuedAt),
    windowEndIdx: index("loom_forecasts_window_end_idx").on(t.windowEnd), // due-resolution scan
  })
);

export const loomResolutions = pgTable(
  "loom_resolutions",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  forecastId: uuid("forecast_id")
    .notNull()
    .unique()
    .references(() => loomForecasts.id, { onDelete: "cascade" }),
    outcome: boolean("outcome").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    brier: real("brier").notNull(),
  },
  (t) => ({ resolvedIdx: index("loom_resolutions_resolved_idx").on(t.resolvedAt) }) // 90d scoreboard window
);

// M9 pilot: playbooks are pre-registered narrative predictions for a theory
// branch; the matcher scores promoted narratives against their watch patterns.
export const loomPlaybooks = pgTable("loom_playbooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  theoryRef: text("theory_ref").notNull(), // EREBUS node id
  outcomeDesc: text("outcome_desc").notNull(),
  pattern: jsonb("pattern").notNull().default({}), // {themes[], actors[], framingSignature, sequencing}
  confidence: real("confidence").notNull().default(0.5), // decays on non-matches
  model: text("model"),
  lastMatchedAt: timestamp("last_matched_at", { withTimezone: true }),
  decayedAt: timestamp("decayed_at", { withTimezone: true }), // last confidence decay applied
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loomPlaybookMatches = pgTable(
  "loom_playbook_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playbookId: uuid("playbook_id")
      .notNull()
      .references(() => loomPlaybooks.id, { onDelete: "cascade" }),
    narrativeId: uuid("narrative_id")
      .notNull()
      .references(() => loomNarratives.id, { onDelete: "cascade" }),
    matchScore: real("match_score").notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUq: uniqueIndex("loom_playbook_matches_pair_uq").on(t.playbookId, t.narrativeId),
  })
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
  loomOutlets,
  loomArticles,
  loomWireReleases,
  loomNarratives,
  loomNarrativeMetrics,
  loomNarrativeTransitions,
  loomEntities,
  loomInstruments,
  loomExposures,
  loomNarrativeEntities,
  loomPrices,
  loomEventStudies,
  loomPositioning,
  loomRegimes,
  loomPlaceboRuns,
  loomPrepositionFlags,
  loomFraming,
  loomHypotheses,
  loomEvidence,
  loomJudgments,
  loomBeneficiaries,
  loomForecasts,
  loomResolutions,
  loomPlaybooks,
  loomPlaybookMatches,
  loomAnalogs,
  loomOutletPriors,
  loomNegativeSpace,
  settings,
};
