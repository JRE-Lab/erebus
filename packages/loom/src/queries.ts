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
}

export async function getLoomNarrative(id: string): Promise<LoomNarrativeDetail | null> {
  const head = await db.execute(sql`
    SELECT n.id, n.label, n.summary, n.state,
           n.article_count, n.outlet_count, n.lang_count,
           n.seeded_at::text AS seeded_at, n.promoted_at::text AS promoted_at,
           n.peak_at::text AS peak_at, n.last_seen_at::text AS last_seen_at,
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
