// ============================================================================
// LOOM M7 (Phase 5) — analog matcher + empirical priors.
//
// The spec builds this on a GDELT backfill; that arm needs a GCP project, so
// the matcher runs on LOOM's OWN accumulating narrative history. It is cold on
// day one and strengthens continuously.
//
// THE RULE THAT MATTERS (learned the hard way in review): an analog prior must
// measure EXACTLY the claim it prices.
//   * lifecycle claims resolve on "amplifying -> peak within 72h", so the
//     analog outcome is measured from the analog's OWN amplifying transition,
//     not from when its first article appeared.
//   * market claims resolve on "raw close-to-close move >= X% in a stated
//     direction over 7 days", so the analog outcome is that same raw move on
//     THE SAME INSTRUMENT — not an abnormal return, not averaged across an
//     analog's other instruments.
//   * the direction is pre-declared by the target's own observed signal and
//     then scored; picking the analogs' majority side and reporting its own
//     frequency is post-selection bias (a coin flip reads ~63%).
// Anything that cannot be measured on the claim's own terms falls back to the
// hand-set prior and says so — spec risk "analog overfit".
// Free: centroid cosine + stored prices. No LLM.
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

const TOP_K = Number(process.env.LOOM_ANALOG_K || 7);
const MIN_SIM = Number(process.env.LOOM_ANALOG_MIN_SIM || 0.55);
// A near-duplicate is the SAME story re-clustered, not a precedent. The
// clusterer admits members at LOOM_SIM_THRESHOLD (0.70), so two narratives
// above that are effectively one story split by the trailing window.
const MAX_SIM = Number(process.env.LOOM_ANALOG_MAX_SIM || 0.85);
const MIN_ANALOGS = Number(process.env.LOOM_ANALOG_MIN || 5); // below this the prior is NOT used
const MIN_AGE_HOURS = Number(process.env.LOOM_ANALOG_MIN_AGE_H || 96); // an analog must have played out

type Rows = { rows: Array<Record<string, unknown>> };

export interface LoomAnalogResult {
  narrativesMatched: number;
  analogsWritten: number;
  pruned: number;
}

// Build/refresh the analog set for promoted narratives. An analog must be
// OLDER than the target by MIN_AGE_HOURS so its outcome is actually observed,
// and its similarity must sit in [MIN_SIM, MAX_SIM] — above the ceiling it is
// the same story, not a precedent.
//
// Rows are REPLACED per target, not accumulated: outcomes evolve (an analog
// can reach peak after its row was written) and a stale row would otherwise
// keep a superseded outcome and let the pool drift past TOP_K.
export async function buildAnalogs(limit = 15): Promise<LoomAnalogResult> {
  const r: LoomAnalogResult = { narrativesMatched: 0, analogsWritten: 0, pruned: 0 };

  const targets = await db.execute(sql`
    SELECT n.id, n.centroid::text AS c, n.seeded_at
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
     ORDER BY n.last_seen_at DESC
     LIMIT ${limit}
  `);

  for (const t of (targets as Rows).rows) {
    const id = t.id as string;
    const analogs = await db.execute(sql`
      SELECT a.id,
             1 - (a.centroid <=> ${t.c as string}::vector) AS sim,
             -- The analog's OWN amplifying transition: the clock the lifecycle
             -- claim is actually scored on.
             (SELECT min(tr.at) FROM loom_narrative_transitions tr
               WHERE tr.narrative_id = a.id AND tr.to_state = 'amplifying') AS amp_at,
             (SELECT min(tr.at) FROM loom_narrative_transitions tr
               WHERE tr.narrative_id = a.id AND tr.to_state = 'peak') AS peak_at,
             a.max_vel24,
             (SELECT r1.state FROM loom_regimes r1
               WHERE r1.date <= a.seeded_at::date ORDER BY r1.date DESC LIMIT 1) AS analog_regime,
             (SELECT r2.state FROM loom_regimes r2
               WHERE r2.date <= ${t.seeded_at as string}::date ORDER BY r2.date DESC LIMIT 1) AS target_regime
        FROM loom_narratives a
       WHERE a.id <> ${id}::uuid
         AND a.promoted_at IS NOT NULL
         AND a.seeded_at < ${t.seeded_at as string}::timestamptz - make_interval(hours => ${MIN_AGE_HOURS})
         AND 1 - (a.centroid <=> ${t.c as string}::vector) BETWEEN ${MIN_SIM} AND ${MAX_SIM}
       ORDER BY a.centroid <=> ${t.c as string}::vector
       LIMIT ${TOP_K}
    `);

    const rows = (analogs as Rows).rows;
    // Replace the whole set for this target (see note above).
    const del = await db.execute(sql`DELETE FROM loom_analogs WHERE narrative_id = ${id}::uuid RETURNING id`);
    r.pruned += (del as Rows).rows.length;

    for (const a of rows) {
      const ampAt = a.amp_at as string | null;
      const peakAt = a.peak_at as string | null;
      // Lifecycle outcome measured on the CLAIM's clock: amplifying -> peak.
      // An analog that never amplified cannot speak to this claim at all.
      const hoursAmpToPeak =
        ampAt && peakAt ? (Date.parse(peakAt) - Date.parse(ampAt)) / 3_600_000 : null;
      // A regime is only a "match" when BOTH sides are known. NULL === NULL is
      // true in JS and used to stamp unknown-vs-unknown as a positive match,
      // manufacturing the regime conditioning the card then advertises.
      const regimeMatch =
        a.analog_regime != null && a.target_regime != null && a.analog_regime === a.target_regime;

      await db.execute(sql`
        INSERT INTO loom_analogs (narrative_id, analog_narrative_id, sim, regime_match, outcome_summary)
        VALUES (${id}::uuid, ${a.id as string}::uuid, ${Number(a.sim)}, ${regimeMatch},
                ${JSON.stringify({
                  amplifiedAt: ampAt,
                  reachedPeak: peakAt != null,
                  hoursAmpToPeak,
                  amplified: ampAt != null,
                  maxVel: Number(a.max_vel24) || 0,
                  regimeKnown: a.analog_regime != null && a.target_regime != null,
                })}::jsonb)
        ON CONFLICT (narrative_id, analog_narrative_id)
        DO UPDATE SET sim = EXCLUDED.sim, outcome_summary = EXCLUDED.outcome_summary,
                      regime_match = EXCLUDED.regime_match
      `);
      r.analogsWritten++;
    }
    if (rows.length) r.narrativesMatched++;
  }
  return r;
}

export interface AnalogPrior {
  prob: number;
  n: number; // precedents actually behind the number
  informative: boolean; // false => hand-set prior stands, and the card says so
  basis: string;
}

// P(amplifying -> peak within `withinHours`) from regime-matched precedents.
// Only analogs that THEMSELVES amplified are eligible: the claim is conditional
// on amplification, so a narrative that never amplified is not a trial.
export async function lifecyclePrior(
  narrativeId: string,
  withinHours = 72,
  fallback = 0.45
): Promise<AnalogPrior> {
  const res = await db.execute(sql`
    SELECT outcome_summary, regime_match FROM loom_analogs
     WHERE narrative_id = ${narrativeId}::uuid
  `);
  const pool = (res as Rows).rows
    .filter((x) => x.regime_match === true)
    .map((x) => x.outcome_summary as { amplified?: boolean; reachedPeak?: boolean; hoursAmpToPeak?: number | null })
    .filter((o) => o?.amplified === true); // eligible trials only

  if (pool.length < MIN_ANALOGS) {
    return {
      prob: fallback,
      n: pool.length,
      informative: false,
      basis: `hand-set prior (${pool.length} eligible regime-matched precedents, need ${MIN_ANALOGS})`,
    };
  }
  const hits = pool.filter(
    (o) => o.reachedPeak === true && o.hoursAmpToPeak != null && o.hoursAmpToPeak <= withinHours
  ).length;
  const prob = (hits + 1) / (pool.length + 2); // Laplace
  return { prob, n: pool.length, informative: true, basis: `${pool.length} regime-matched precedents` };
}

// P(raw close-to-close move >= minMagnitude in `direction` over `days`) for a
// SPECIFIC symbol, measured on precedents that were themselves exposed to that
// symbol. The direction is an INPUT (declared from the target's own observed
// signal), never chosen from the analogs — choosing the winning side and then
// reporting its frequency is post-selection bias.
export async function marketPrior(
  narrativeId: string,
  symbol: string,
  direction: "up" | "down",
  minMagnitude = 0.01,
  days = 7,
  fallback = 0.55
): Promise<AnalogPrior> {
  const res = await db.execute(sql`
    WITH pool AS (
      SELECT a.analog_narrative_id AS aid,
             (a.outcome_summary->>'amplifiedAt')::timestamptz AS amp_at
        FROM loom_analogs a
       WHERE a.narrative_id = ${narrativeId}::uuid
         AND a.regime_match = true
         AND (a.outcome_summary->>'amplified')::boolean = true
         -- the precedent must have been exposed to THIS instrument
         AND EXISTS (
           SELECT 1 FROM loom_narrative_entities ne
             JOIN loom_exposures x ON x.entity_id = ne.entity_id
             JOIN loom_instruments i ON i.id = x.instrument_id
            WHERE ne.narrative_id = a.analog_narrative_id AND i.symbol = ${symbol}
         )
    )
    SELECT p.aid,
           (SELECT pr.close FROM loom_prices pr JOIN loom_instruments i ON i.id = pr.instrument_id
             WHERE i.symbol = ${symbol} AND pr.date <= p.amp_at::date
             ORDER BY pr.date DESC LIMIT 1) AS c0,
           (SELECT pr.close FROM loom_prices pr JOIN loom_instruments i ON i.id = pr.instrument_id
             WHERE i.symbol = ${symbol} AND pr.date <= (p.amp_at + make_interval(days => ${days}))::date
             ORDER BY pr.date DESC LIMIT 1) AS c1
      FROM pool p
  `);
  const moves = (res as Rows).rows
    .map((x) => {
      const c0 = x.c0 == null ? null : Number(x.c0);
      const c1 = x.c1 == null ? null : Number(x.c1);
      return c0 && c1 && c0 > 0 ? c1 / c0 - 1 : null;
    })
    .filter((v): v is number => v != null && Number.isFinite(v));

  if (moves.length < MIN_ANALOGS) {
    return {
      prob: fallback,
      n: moves.length,
      informative: false,
      basis: `hand-set prior (${moves.length} ${symbol} precedents with price coverage, need ${MIN_ANALOGS})`,
    };
  }
  // Scored EXACTLY as the claim resolves: signed move clears the magnitude.
  const hits = moves.filter((m) => (direction === "up" ? m : -m) >= minMagnitude).length;
  const prob = (hits + 1) / (moves.length + 2);
  return {
    prob,
    n: moves.length,
    informative: true,
    basis: `${moves.length} regime-matched ${symbol} precedents (${days}d ≥${(100 * minMagnitude).toFixed(0)}% ${direction})`,
  };
}

// Precedents shown on the card ("prior built from these N analogs"). Only the
// rows that actually feed a prior are returned, so the count on the card and
// the count behind the number cannot disagree.
export async function narrativeAnalogs(narrativeId: string): Promise<
  Array<{ id: string; label: string | null; sim: number; regimeMatch: boolean; outcome: unknown }>
> {
  const res = await db.execute(sql`
    SELECT a.analog_narrative_id AS id, n.label, a.sim, a.regime_match, a.outcome_summary
      FROM loom_analogs a JOIN loom_narratives n ON n.id = a.analog_narrative_id
     WHERE a.narrative_id = ${narrativeId}::uuid
     ORDER BY a.regime_match DESC, a.sim DESC LIMIT 7
  `);
  return (res as Rows).rows.map((x) => ({
    id: x.id as string,
    label: (x.label as string) ?? null,
    sim: Number(x.sim) || 0,
    regimeMatch: x.regime_match === true,
    outcome: x.outcome_summary,
  }));
}
