// ============================================================================
// LOOM Phase 1 read layer — everything the narrative tab renders. The centroid
// vector is NEVER selected (same rule as node embeddings: 1536 floats do not
// belong in an API response). Unlabeled narratives fall back to their seed
// article's title so the list renders even when the LLM is offline.
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

export interface LoomNarrativeCard {
  id: string;
  label: string | null;
  summary: string | null;
  seedTitle: string | null; // display fallback when label is NULL
  state: string;
  articleCount: number;
  outletCount: number;
  langCount: number;
  vel24: number;
  seededAt: string | null;
  promotedAt: string | null;
  peakAt: string | null;
  lastSeenAt: string | null;
}

type Rows = { rows: Array<Record<string, unknown>> };

const VALID_STATES = new Set(["seeding", "amplifying", "peak", "decaying", "dormant"]);

export async function listLoomNarratives(opts?: {
  state?: string;
  limit?: number;
}): Promise<LoomNarrativeCard[]> {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts?.limit ?? 50)));
  const state = opts?.state && VALID_STATES.has(opts.state) ? opts.state : null;
  const res = await db.execute(sql`
    SELECT n.id, n.label, n.summary, n.state,
           n.article_count, n.outlet_count, n.lang_count,
           n.seeded_at::text  AS seeded_at,
           n.promoted_at::text AS promoted_at,
           n.peak_at::text     AS peak_at,
           n.last_seen_at::text AS last_seen_at,
           (SELECT a.title FROM loom_articles a
             WHERE a.narrative_id = n.id ORDER BY a.first_seen_at ASC LIMIT 1)   AS seed_title,
           COALESCE((SELECT m.vel24 FROM loom_narrative_metrics m
             WHERE m.narrative_id = n.id ORDER BY m.ts DESC LIMIT 1), 0)         AS vel24
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
       ${state ? sql`AND n.state = ${state}` : sql``}
     ORDER BY n.last_seen_at DESC
     LIMIT ${limit}
  `);
  return (res as unknown as Rows).rows.map(cardOf);
}

export interface LoomNarrativeDetail extends LoomNarrativeCard {
  articles: Array<{
    id: string;
    title: string | null;
    url: string;
    outlet: string | null;
    publishedAt: string | null; // claimed (R1)
    firstSeenAt: string | null; // observed (R1)
  }>;
  metrics: Array<{ ts: string; vel24: number; vel6: number; accel: number; reachOutlets: number; state: string }>;
  transitions: Array<{ fromState: string; toState: string; at: string; metrics: unknown }>;
  // Phase 2-4 card sections
  frame: Record<string, string> | null;
  coordination: { score: number; ciLow: number; ciHigh: number; wireSharePct: number; firstMover: string | null } | null;
  entities: Array<{ name: string; kind: string; ticker: string | null; salience: number }>;
  eventStudies: Array<{ symbol: string; carPre: number | null; carEvent: number | null; carPost: number | null }>;
  judgment: {
    topH: string; topLabel: string; topBand: string;
    runnerH: string; runnerLabel: string; runnerBand: string;
    confidence: string; falsifiers: string[]; publishedAt: string;
  } | null;
  beneficiaries: Array<{ name: string; rationale: string | null; falsifier: string; rank: number }>;
  flags: Array<{ symbol: string; composite: number; placeboPctl: number; windowStart: string; windowEnd: string }>;
  forecasts: Array<{
    id: string; claimType: string; direction: string | null; magnitudeBand: string | null;
    target: unknown; prob: number; windowEnd: string; issuedAt: string;
    outcome: boolean | null; brier: number | null;
  }>;
}

const H_LABELS: Record<string, string> = {
  H1: "organic newsworthiness",
  H2: "editorial herding",
  H3: "access journalism / official seeding",
  H4: "commercial PR push",
  H5: "state information operation",
  H6: "market manipulation",
  H7: "policy ground-preparation",
};

export async function getLoomNarrative(id: string): Promise<LoomNarrativeDetail | null> {
  const head = await db.execute(sql`
    SELECT n.id, n.label, n.summary, n.state,
           n.article_count, n.outlet_count, n.lang_count,
           n.seeded_at::text AS seeded_at, n.promoted_at::text AS promoted_at,
           n.peak_at::text AS peak_at, n.last_seen_at::text AS last_seen_at,
           n.frame, n.coordination_score, n.coord_ci_low, n.coord_ci_high,
           n.wire_share_pct, n.first_mover_outlet,
           (SELECT a.title FROM loom_articles a
             WHERE a.narrative_id = n.id ORDER BY a.first_seen_at ASC LIMIT 1)   AS seed_title,
           COALESCE((SELECT m.vel24 FROM loom_narrative_metrics m
             WHERE m.narrative_id = n.id ORDER BY m.ts DESC LIMIT 1), 0)         AS vel24
      FROM loom_narratives n
     WHERE n.id = ${id}::uuid
  `);
  const row = (head as unknown as Rows).rows[0];
  if (!row) return null;

  const [articles, metrics, transitions] = await Promise.all([
    db.execute(sql`
      SELECT a.id, a.title, a.url_canon AS url, o.domain AS outlet,
             a.published_at::text AS published_at, a.first_seen_at::text AS first_seen_at
        FROM loom_articles a
        LEFT JOIN loom_outlets o ON o.id = a.outlet_id
       WHERE a.narrative_id = ${id}::uuid
       ORDER BY a.first_seen_at DESC
       LIMIT 30
    `),
    db.execute(sql`
      SELECT ts::text AS ts, vel24, vel6, accel, reach_outlets, state
        FROM loom_narrative_metrics
       WHERE narrative_id = ${id}::uuid
       ORDER BY ts DESC
       LIMIT 48
    `),
    db.execute(sql`
      SELECT from_state, to_state, at::text AS at, metrics
        FROM loom_narrative_transitions
       WHERE narrative_id = ${id}::uuid
       ORDER BY at DESC
       LIMIT 20
    `),
  ]);

  // Phase 2-4 card sections (all read-only; observables and inference kept
  // in separate blocks — the UI renders intent ONLY from the judgment row,
  // which R2 guarantees carries runner-up + falsifiers).
  const [entities, studies, judgment, beneficiaries, flags, forecasts] = await Promise.all([
    db.execute(sql`
      -- The tradeable symbol for a country/commodity lives on its exposure
      -- edge (a proxy ETF), not on the entity row — surface either one so the
      -- exposure chips actually show what the narrative touches.
      SELECT e.canon_name AS name, e.kind, ne.salience,
             COALESCE(e.ticker, (SELECT i.symbol FROM loom_exposures x
                                   JOIN loom_instruments i ON i.id = x.instrument_id
                                  WHERE x.entity_id = e.id
                                  ORDER BY x.weight DESC LIMIT 1)) AS ticker
        FROM loom_narrative_entities ne JOIN loom_entities e ON e.id = ne.entity_id
       WHERE ne.narrative_id = ${id}::uuid ORDER BY ne.salience DESC LIMIT 8
    `),
    db.execute(sql`
      SELECT i.symbol, s.car_pre, s.car_event, s.car_post
        FROM loom_event_studies s JOIN loom_instruments i ON i.id = s.instrument_id
       WHERE s.narrative_id = ${id}::uuid ORDER BY s.computed_at DESC LIMIT 6
    `),
    db.execute(sql`
      SELECT top_h, top_band, runner_h, runner_band, confidence, falsifiers, published_at::text AS published_at
        FROM loom_judgments WHERE narrative_id = ${id}::uuid ORDER BY published_at DESC LIMIT 1
    `),
    db.execute(sql`
      SELECT name, rationale, falsifier, rank FROM loom_beneficiaries
       WHERE narrative_id = ${id}::uuid ORDER BY rank ASC LIMIT 5
    `),
    db.execute(sql`
      SELECT i.symbol, f.composite, f.placebo_pctl, f.window_start::text AS ws, f.window_end::text AS we
        FROM loom_preposition_flags f JOIN loom_instruments i ON i.id = f.instrument_id
       WHERE f.narrative_id = ${id}::uuid ORDER BY f.created_at DESC LIMIT 5
    `),
    db.execute(sql`
      SELECT f.id, f.claim_type, f.direction, f.magnitude_band, f.target_ref, f.prob,
             f.window_end::text AS window_end, f.issued_at::text AS issued_at,
             res.outcome, res.brier
        FROM loom_forecasts f LEFT JOIN loom_resolutions res ON res.forecast_id = f.id
       WHERE f.narrative_id = ${id}::uuid ORDER BY f.issued_at DESC LIMIT 12
    `),
  ]);
  const jRow = (judgment as unknown as Rows).rows[0];

  return {
    ...cardOf(row),
    articles: (articles as unknown as Rows).rows.map((a) => ({
      id: a.id as string,
      title: (a.title as string) ?? null,
      url: a.url as string,
      outlet: (a.outlet as string) ?? null,
      publishedAt: (a.published_at as string) ?? null,
      firstSeenAt: (a.first_seen_at as string) ?? null,
    })),
    metrics: (metrics as unknown as Rows).rows.map((m) => ({
      ts: m.ts as string,
      vel24: Number(m.vel24) || 0,
      vel6: Number(m.vel6) || 0,
      accel: Number(m.accel) || 0,
      reachOutlets: Number(m.reach_outlets) || 0,
      state: m.state as string,
    })),
    transitions: (transitions as unknown as Rows).rows.map((t) => ({
      fromState: t.from_state as string,
      toState: t.to_state as string,
      at: t.at as string,
      metrics: t.metrics,
    })),
    frame: (row.frame as Record<string, string>) ?? null,
    coordination:
      row.coordination_score == null
        ? null
        : {
            score: Number(row.coordination_score),
            ciLow: Number(row.coord_ci_low ?? row.coordination_score),
            ciHigh: Number(row.coord_ci_high ?? row.coordination_score),
            wireSharePct: Number(row.wire_share_pct ?? 0),
            firstMover: (row.first_mover_outlet as string) ?? null,
          },
    entities: (entities as unknown as Rows).rows.map((e) => ({
      name: e.name as string,
      kind: e.kind as string,
      ticker: (e.ticker as string) ?? null,
      salience: Number(e.salience) || 0,
    })),
    eventStudies: (studies as unknown as Rows).rows.map((s) => ({
      symbol: s.symbol as string,
      carPre: s.car_pre == null ? null : Number(s.car_pre),
      carEvent: s.car_event == null ? null : Number(s.car_event),
      carPost: s.car_post == null ? null : Number(s.car_post),
    })),
    judgment: jRow
      ? {
          topH: jRow.top_h as string,
          topLabel: H_LABELS[jRow.top_h as string] ?? (jRow.top_h as string),
          topBand: jRow.top_band as string,
          runnerH: jRow.runner_h as string,
          runnerLabel: H_LABELS[jRow.runner_h as string] ?? (jRow.runner_h as string),
          runnerBand: jRow.runner_band as string,
          confidence: jRow.confidence as string,
          falsifiers: (jRow.falsifiers as string[]) ?? [],
          publishedAt: jRow.published_at as string,
        }
      : null,
    beneficiaries: (beneficiaries as unknown as Rows).rows.map((b) => ({
      name: b.name as string,
      rationale: (b.rationale as string) ?? null,
      falsifier: b.falsifier as string,
      rank: Number(b.rank) || 0,
    })),
    flags: (flags as unknown as Rows).rows.map((f) => ({
      symbol: f.symbol as string,
      composite: Number(f.composite) || 0,
      placeboPctl: Number(f.placebo_pctl) || 0,
      windowStart: f.ws as string,
      windowEnd: f.we as string,
    })),
    forecasts: (forecasts as unknown as Rows).rows.map((f) => ({
      id: f.id as string,
      claimType: f.claim_type as string,
      direction: (f.direction as string) ?? null,
      magnitudeBand: (f.magnitude_band as string) ?? null,
      target: f.target_ref,
      prob: Number(f.prob) || 0,
      windowEnd: f.window_end as string,
      issuedAt: f.issued_at as string,
      outcome: f.outcome == null ? null : Boolean(f.outcome),
      brier: f.brier == null ? null : Number(f.brier),
    })),
  };
}

function cardOf(r: Record<string, unknown>): LoomNarrativeCard {
  return {
    id: r.id as string,
    label: (r.label as string) ?? null,
    summary: (r.summary as string) ?? null,
    seedTitle: (r.seed_title as string) ?? null,
    state: (r.state as string) || "seeding",
    articleCount: Number(r.article_count) || 0,
    outletCount: Number(r.outlet_count) || 0,
    langCount: Number(r.lang_count) || 0,
    vel24: Number(r.vel24) || 0,
    seededAt: (r.seeded_at as string) ?? null,
    promotedAt: (r.promoted_at as string) ?? null,
    peakAt: (r.peak_at as string) ?? null,
    lastSeenAt: (r.last_seen_at as string) ?? null,
  };
}
