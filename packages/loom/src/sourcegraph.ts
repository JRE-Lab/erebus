// ============================================================================
// LOOM M4 + M10 (Phase 5) — source/actor behavioral priors and negative space.
//
// M4: provenance as a statistic. Per outlet: how often it SEEDS narratives,
// how much of its output is verbatim wire copy, and how far ahead of the
// narrative it typically publishes. Per R5/R7 these are statistics ABOUT AN
// OUTLET — never evidence about any specific story.
//
// TIMESTAMP DISCIPLINE (review lesson): first_seen_at is OUR poll time. Every
// article from one ingest pass is stamped milliseconds apart in FEED ORDER, so
// ranking outlets by it measures our own feed-list order, not who published
// first. Ordering here uses the CLAIMED publish time, and a narrative only
// counts toward first-mover when the winner's lead exceeds MIN_LEAD_MIN —
// anything tighter is a tie we cannot resolve at our polling resolution.
//
// M10: absence as signal.
//   asymmetry    — coverage skewed by outlet country vs a LEAVE-ONE-OUT
//                  baseline (including the narrative in its own expectation
//                  lets a dominant story define the norm it is judged against).
//   displacement — attention is roughly zero-sum: a narrative falling much
//                  faster than its own trend WHILE the corpus stays active.
// Findings are upserted per (narrative, kind), never appended, so one signal
// stays one row instead of accumulating a copy every pass.
// All free: SQL + arithmetic. No LLM, no embeddings.
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

const ASYMMETRY_Z = Number(process.env.LOOM_ASYMMETRY_Z || 2);
const DISPLACEMENT_Z = Number(process.env.LOOM_DISPLACEMENT_Z || 1.5);
// Normal approximation to the binomial needs a real sample; at n=4 it is noise.
const ASYM_MIN_N = Number(process.env.LOOM_ASYMMETRY_MIN_N || 12);
const MIN_LEAD_MIN = Number(process.env.LOOM_LEAD_MIN_GAP_MIN || 10);
const WINDOW_DAYS = Number(process.env.LOOM_SOURCE_WINDOW_DAYS || 60);
// Below this many resolvable narratives an outlet's rates are not reportable.
const MIN_PRIOR_N = Number(process.env.LOOM_PRIOR_MIN_N || 3);

type Rows = { rows: Array<Record<string, unknown>> };

// Domains we ship by default; extend freely — an unknown domain simply has no
// country and is excluded from the asymmetry baseline rather than guessed.
const DOMAIN_COUNTRY: Record<string, string> = {
  "bbci.co.uk": "GB", "bbc.co.uk": "GB", "bbc.com": "GB", "theguardian.com": "GB",
  "aljazeera.com": "QA", "nytimes.com": "US", "washingtonpost.com": "US",
  "wsj.com": "US", "cnn.com": "US", "foxnews.com": "US", "npr.org": "US",
  "reuters.com": "GB", "apnews.com": "US", "bloomberg.com": "US", "ft.com": "GB",
  "cnbc.com": "US", "politico.com": "US", "axios.com": "US", "thehill.com": "US",
  "dw.com": "DE", "spiegel.de": "DE", "lemonde.fr": "FR", "france24.com": "FR",
  "scmp.com": "HK", "japantimes.co.jp": "JP", "timesofindia.indiatimes.com": "IN",
  "cbc.ca": "CA", "globalnews.ca": "CA", "theglobeandmail.com": "CA",
  "abc.net.au": "AU", "smh.com.au": "AU", "rt.com": "RU", "tass.com": "RU",
  "prnewswire.com": "US", "globenewswire.com": "US", "businesswire.com": "US",
  "foreignpolicy.com": "US", "warontherocks.com": "US", "oilprice.com": "US",
  "economist.com": "GB", "telegraph.co.uk": "GB", "independent.co.uk": "GB",
  "haaretz.com": "IL", "timesofisrael.com": "IL", "kyivindependent.com": "UA",
  "themoscowtimes.com": "RU", "straitstimes.com": "SG", "channelnewsasia.com": "SG",
};
const WIRE_RE = /prnewswire|globenewswire|businesswire/;

export interface LoomSourceGraphResult {
  outletsTagged: number;
  priorsComputed: number;
  asymmetries: number;
  displacements: number;
}

export async function runSourceGraph(): Promise<LoomSourceGraphResult> {
  const r: LoomSourceGraphResult = { outletsTagged: 0, priorsComputed: 0, asymmetries: 0, displacements: 0 };

  // --- 0) tag outlet country/wire status where we know it -------------------
  // One statement for the whole map rather than ~35 sequential UPDATEs.
  const pairs = Object.entries(DOMAIN_COUNTRY);
  const values = sql.join(
    // Explicit casts: a bare parameter inside VALUES has no inferred type, so
    // Postgres compares it as text ("operator does not exist: boolean = text").
    pairs.map(([d, c]) => sql`(${d}::text, ${c}::text, ${WIRE_RE.test(d)}::boolean)`),
    sql`, `
  );
  const tagged = await db.execute(sql`
    UPDATE loom_outlets o
       SET country = v.country, is_wire = v.is_wire
      FROM (VALUES ${values}) AS v(domain, country, is_wire)
     WHERE (o.domain = v.domain OR o.domain = 'www.' || v.domain)
       AND (o.country IS DISTINCT FROM v.country OR o.is_wire IS DISTINCT FROM v.is_wire)
     RETURNING o.id
  `);
  r.outletsTagged = (tagged as Rows).rows.length;

  // --- 1) behavioral priors per outlet (M4) ---------------------------------
  const priors = await db.execute(sql`
    WITH art AS (
      SELECT a.narrative_id, a.outlet_id,
             COALESCE(a.published_at, a.first_seen_at) AS at
        FROM loom_articles a
        JOIN loom_narratives n ON n.id = a.narrative_id AND n.promoted_at IS NOT NULL
       WHERE a.outlet_id IS NOT NULL
         AND a.first_seen_at >= now() - make_interval(days => ${WINDOW_DAYS})
    ),
    outlet_first AS (
      SELECT narrative_id, outlet_id, min(at) AS first_at
        FROM art GROUP BY narrative_id, outlet_id
    ),
    ordered AS (
      SELECT narrative_id, outlet_id, first_at,
             row_number() OVER (PARTITION BY narrative_id ORDER BY first_at ASC) AS rn
        FROM outlet_first
    ),
    -- A narrative contributes to first-mover only when the winner's lead over
    -- the SECOND OUTLET is bigger than our polling resolution.
    resolvable AS (
      SELECT w.narrative_id, w.outlet_id AS seed_outlet, w.first_at AS seed_at
        FROM ordered w JOIN ordered s
          ON s.narrative_id = w.narrative_id AND s.rn = 2
       WHERE w.rn = 1
         AND s.first_at - w.first_at >= make_interval(mins => ${MIN_LEAD_MIN})
    ),
    wire AS (
      SELECT a.outlet_id,
             count(*)::float8 AS total,
             count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM loom_wire_releases w WHERE w.text_hash = a.text_hash)
                  OR EXISTS (SELECT 1 FROM loom_wire_releases w2
                              WHERE lower(w2.title) = lower(a.title)
                                AND w2.first_seen_at >= now() - make_interval(days => ${WINDOW_DAYS}))
             )::float8 AS wired
        FROM loom_articles a
       WHERE a.outlet_id IS NOT NULL
         AND a.first_seen_at >= now() - make_interval(days => ${WINDOW_DAYS})
       GROUP BY a.outlet_id
    )
    SELECT o.outlet_id,
           count(*)::int AS narratives,
           (count(*) FILTER (WHERE rs.seed_outlet = o.outlet_id))::float8 / count(*) AS first_mover_rate,
           avg(EXTRACT(EPOCH FROM (o.first_at - rs.seed_at)) / 3600.0) AS avg_lag_hours,
           COALESCE(max(w.wired) / NULLIF(max(w.total), 0), 0) AS wire_dependence
      FROM outlet_first o
      JOIN resolvable rs ON rs.narrative_id = o.narrative_id
      LEFT JOIN wire w ON w.outlet_id = o.outlet_id
     GROUP BY o.outlet_id
    HAVING count(*) >= ${MIN_PRIOR_N}
  `);
  for (const row of (priors as Rows).rows) {
    // Stored as LEAD (positive = published ahead of the seed). The query
    // measures lag from the seed, so the sign is flipped once, here.
    const lag = row.avg_lag_hours == null ? null : Number(row.avg_lag_hours);
    await db.execute(sql`
      INSERT INTO loom_outlet_priors (outlet_id, narratives, first_mover_rate, wire_dependence, avg_lead_hours, computed_at)
      VALUES (${row.outlet_id as string}::uuid, ${Number(row.narratives)},
              ${Number(row.first_mover_rate) || 0}, ${Number(row.wire_dependence) || 0},
              ${lag == null ? null : -lag}, now())
      ON CONFLICT (outlet_id) DO UPDATE SET
        narratives = EXCLUDED.narratives,
        first_mover_rate = EXCLUDED.first_mover_rate,
        wire_dependence = EXCLUDED.wire_dependence,
        avg_lead_hours = EXCLUDED.avg_lead_hours,
        computed_at = now()
    `);
    r.priorsComputed++;
  }

  // --- 2) coverage asymmetry (M10) ------------------------------------------
  const asym = await db.execute(sql`
    WITH tagged AS (
      SELECT a.narrative_id, o.country
        FROM loom_articles a JOIN loom_outlets o ON o.id = a.outlet_id
        JOIN loom_narratives n ON n.id = a.narrative_id AND n.promoted_at IS NOT NULL
       WHERE o.country IS NOT NULL
    ),
    per_n AS (
      SELECT narrative_id, country, count(*)::float8 AS k,
             sum(count(*)) OVER (PARTITION BY narrative_id) AS n
        FROM tagged GROUP BY narrative_id, country
    ),
    totals AS (
      SELECT country, count(*)::float8 AS c, (SELECT count(*)::float8 FROM tagged) AS all_c
        FROM tagged GROUP BY country
    ),
    loo AS (
      -- leave-one-out baseline: the corpus MINUS this narrative
      SELECT p.narrative_id, p.country, p.k, p.n,
             (t.c - p.k) / NULLIF(t.all_c - p.n, 0) AS baseline
        FROM per_n p JOIN totals t USING (country)
       WHERE p.n >= ${ASYM_MIN_N}
         AND (SELECT count(DISTINCT country) FROM totals) >= 2
    )
    SELECT narrative_id, country, k, n, baseline,
           (k - n * baseline) / NULLIF(sqrt(n * baseline * (1 - baseline)), 0) AS z
      FROM loo
     WHERE baseline > 0 AND baseline < 1
       -- normal approximation validity: both tails need mass
       AND n * baseline >= 5 AND n * (1 - baseline) >= 5
  `);
  for (const row of (asym as Rows).rows) {
    const z = Number(row.z);
    if (!Number.isFinite(z) || Math.abs(z) < ASYMMETRY_Z) continue;
    await db.execute(sql`
      INSERT INTO loom_negative_space (narrative_id, kind, detail, z)
      VALUES (${row.narrative_id as string}::uuid, 'asymmetry',
              ${JSON.stringify({
                country: row.country,
                articles: Number(row.k),
                ofTagged: Number(row.n),
                baselineShare: Number(row.baseline),
                direction: z > 0 ? "over-covered" : "under-covered",
              })}::jsonb, ${z})
      ON CONFLICT (narrative_id, kind) DO UPDATE
        SET detail = EXCLUDED.detail, z = EXCLUDED.z, created_at = now()
    `);
    r.asymmetries++;
  }

  // --- 3) displacement (M10) ------------------------------------------------
  // Only meaningful when the corpus as a whole did NOT quiet down: a narrative
  // fading while everything fades is ordinary decay, not displacement.
  const disp = await db.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (narrative_id) narrative_id, ts, vel24, accel
        FROM loom_narrative_metrics ORDER BY narrative_id, ts DESC
    ),
    hist AS (
      SELECT narrative_id, avg(accel) AS mean_accel, stddev_samp(accel) AS sd_accel, count(*) AS n
        FROM loom_narrative_metrics
       WHERE ts > now() - interval '7 days'
       GROUP BY narrative_id
    ),
    corpus AS (
      SELECT sum(vel24)::float8 AS now_total FROM latest
    ),
    corpus_prev AS (
      SELECT sum(vel24)::float8 AS prev_total FROM (
        SELECT DISTINCT ON (narrative_id) narrative_id, vel24
          FROM loom_narrative_metrics
         WHERE ts <= now() - interval '12 hours'
         ORDER BY narrative_id, ts DESC
      ) q
    )
    SELECT l.narrative_id, l.vel24, l.accel, h.mean_accel, h.sd_accel, h.n,
           (l.accel - h.mean_accel) / NULLIF(h.sd_accel, 0) AS z,
           (SELECT now_total FROM corpus) AS corpus_vel,
           (SELECT prev_total FROM corpus_prev) AS corpus_prev_vel
      FROM latest l JOIN hist h USING (narrative_id)
     WHERE h.n >= 6 AND h.sd_accel > 0
       -- corpus attention held up (within 10%) or grew
       AND (SELECT now_total FROM corpus) >= 0.9 * COALESCE((SELECT prev_total FROM corpus_prev), 0)
  `);
  for (const row of (disp as Rows).rows) {
    const z = Number(row.z);
    if (!Number.isFinite(z) || z > -DISPLACEMENT_Z) continue; // only sharp DROPS
    await db.execute(sql`
      INSERT INTO loom_negative_space (narrative_id, kind, detail, z)
      VALUES (${row.narrative_id as string}::uuid, 'displacement',
              ${JSON.stringify({
                vel24: Number(row.vel24),
                accel: Number(row.accel),
                meanAccel: Number(row.mean_accel),
                corpusVelocity: Number(row.corpus_vel),
                corpusPrevVelocity: row.corpus_prev_vel == null ? null : Number(row.corpus_prev_vel),
                note: "fell faster than its own trend while corpus attention held up",
              })}::jsonb, ${z})
      ON CONFLICT (narrative_id, kind) DO UPDATE
        SET detail = EXCLUDED.detail, z = EXCLUDED.z, created_at = now()
    `);
    r.displacements++;
  }

  return r;
}

// Card payload. `narratives` is carried so the UI can show the sample size —
// a rate with no n reads as a fact. Outlets with no computed prior return
// nulls, NOT zeros: "no data" and "never seeds" are different claims.
export async function narrativeSourcePriors(narrativeId: string): Promise<
  Array<{
    domain: string;
    country: string | null;
    narratives: number | null;
    firstMoverRate: number | null;
    wireDependence: number | null;
    avgLeadHours: number | null;
  }>
> {
  const res = await db.execute(sql`
    SELECT DISTINCT o.domain, o.country, p.narratives, p.first_mover_rate, p.wire_dependence, p.avg_lead_hours
      FROM loom_articles a
      JOIN loom_outlets o ON o.id = a.outlet_id
      LEFT JOIN loom_outlet_priors p ON p.outlet_id = o.id
     WHERE a.narrative_id = ${narrativeId}::uuid
     ORDER BY p.first_mover_rate DESC NULLS LAST
     LIMIT 8
  `);
  return (res as Rows).rows.map((x) => ({
    domain: x.domain as string,
    country: (x.country as string) ?? null,
    narratives: x.narratives == null ? null : Number(x.narratives),
    firstMoverRate: x.first_mover_rate == null ? null : Number(x.first_mover_rate),
    wireDependence: x.wire_dependence == null ? null : Number(x.wire_dependence),
    avgLeadHours: x.avg_lead_hours == null ? null : Number(x.avg_lead_hours),
  }));
}

export async function narrativeNegativeSpace(narrativeId: string): Promise<
  Array<{ kind: string; z: number; detail: unknown; at: string }>
> {
  const res = await db.execute(sql`
    SELECT kind, z, detail, created_at::text AS at FROM loom_negative_space
     WHERE narrative_id = ${narrativeId}::uuid
     ORDER BY created_at DESC LIMIT 6
  `);
  return (res as Rows).rows.map((x) => ({
    kind: x.kind as string,
    z: Number(x.z) || 0,
    detail: x.detail,
    at: x.at as string,
  }));
}
