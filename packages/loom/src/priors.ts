// ============================================================================
// LOOM M11 — empirical head priors (the calibration feedback loop).
//
// WHY THIS EXISTS. R6 flagged both forecast heads advisory, and the cause was
// entirely the hand-set prior:
//
//   head          n    base rate   we issued   Brier   climatology
//   lifecycle    246     0.915       0.450     0.294      0.078
//   market_move  123     0.268       0.550     0.276      0.196
//
// Every issued probability was EXACTLY the hand-set constant, which also tells
// us the M7 analog prior never fires in practice: it gates on 5 regime-matched
// precedents *per narrative*, a bar a young corpus rarely clears. So the
// scoreboard was measuring an error nothing could correct.
//
// This module closes the loop: a head's own resolved history supplies the
// prior once there is enough of it. The result is shrunk toward the hand-set
// constant (a Beta-style pseudo-count) so the prior moves smoothly and a thin
// or freshly-reset history cannot swing issuance.
//
// DISCIPLINE. This makes a head CALIBRATED, not SKILFUL. Issuing the base rate
// drives Brier to climatology and no further — the claim stops being wrong on
// average, but it carries no case-specific information. Real skill still has
// to come from the analog prior (M7) or from features of the individual case,
// and `loomScoreboard()` is deliberately built to tell those apart so this
// module can never be mistaken for the system having learned something.
//
// The window matches the scoreboard's (90 days) so the number you read on the
// scoreboard is the number issuance actually used.
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

// Resolutions required before a head's own history may set its prior.
const MIN_N = Number(process.env.LOOM_EMPIRICAL_MIN_N || 30);
// Pseudo-count pulling the estimate toward the hand-set constant. k=10 means
// the hand-set value carries the weight of 10 observations, so at n=30 the
// empirical rate holds ~75% of the mass and at n=200 ~95%.
const SHRINK_K = Number(process.env.LOOM_EMPIRICAL_SHRINK_K || 10);
const WINDOW_DAYS = Number(process.env.LOOM_SCOREBOARD_DAYS || 90);

export type PriorTier = "analog" | "empirical" | "hand-set";

export interface HeadPrior {
  prob: number;
  n: number; // resolutions behind the estimate
  tier: PriorTier;
  basis: string; // rendered verbatim on the narrative card
}

// P(claim resolves true) from the head's own resolved history.
export async function empiricalHeadPrior(
  claimType: string,
  fallback: number
): Promise<HeadPrior> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE r.outcome)::int AS hits
      FROM loom_resolutions r
      JOIN loom_forecasts f ON f.id = r.forecast_id
     WHERE f.claim_type = ${claimType}
       AND r.resolved_at > now() - make_interval(days => ${WINDOW_DAYS})
  `);
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
  const n = Number(row?.n ?? 0);
  const hits = Number(row?.hits ?? 0);

  if (n < MIN_N) {
    return {
      prob: fallback,
      n,
      tier: "hand-set",
      basis: `hand-set prior (${n} resolutions, need ${MIN_N})`,
    };
  }

  // Shrunk toward the hand-set constant.
  const prob = (hits + SHRINK_K * fallback) / (n + SHRINK_K);
  const rate = hits / n;
  return {
    prob,
    n,
    tier: "empirical",
    basis: `${n}-resolution base rate ${(100 * rate).toFixed(0)}% (shrunk to ${(100 * prob).toFixed(0)}%)`,
  };
}

// Tier order for a claim's probability: a genuinely informative analog prior
// beats the head average, which beats a constant someone guessed once.
export function choosePrior(
  analog: { prob: number; n: number; informative: boolean; basis: string } | null,
  empirical: HeadPrior
): HeadPrior {
  if (analog?.informative) {
    return { prob: analog.prob, n: analog.n, tier: "analog", basis: analog.basis };
  }
  return empirical;
}
