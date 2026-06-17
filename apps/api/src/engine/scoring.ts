// Confidence scoring: combine Shadow Board verdicts + evidence into a 0..1 score
// and map to the confidence ladder.
import { query } from "@erebus/db";
import { CONFIDENCE_SCORE, type Confidence, type LensVerdictValue } from "@erebus/core";

export function scoreToConfidence(score: number): Confidence {
  if (score >= 0.9) return "CONFIRMED";
  if (score >= 0.7) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  if (score >= 0.3) return "EMERGING";
  if (score > 0.05) return "SPECULATIVE";
  return "DEAD";
}

// Lens verdicts pull the score down by their severity when they fail/warn.
function lensPenalty(verdicts: Array<{ verdict: LensVerdictValue; severity: number }>): number {
  let penalty = 0;
  for (const v of verdicts) {
    if (v.verdict === "fail") penalty += 0.12 * v.severity;
    else if (v.verdict === "warn") penalty += 0.05 * v.severity;
  }
  return Math.min(penalty, 0.6);
}

export interface RescoreResult {
  score: number;
  confidence: Confidence;
}

// Recompute a theory's score from its current confidence anchor, lens verdicts,
// and evidence-confirmed nodes. Persists score + confidence + history.
export async function rescoreTheory(theoryId: string, reason = "rescore"): Promise<RescoreResult> {
  const theory = await query<{ confidence: Confidence }>(
    "SELECT confidence FROM theories WHERE id = $1",
    [theoryId]
  );
  const base = CONFIDENCE_SCORE[theory[0]?.confidence ?? "EMERGING"] ?? 0.4;

  const verdicts = await query<{ verdict: LensVerdictValue; severity: number }>(
    "SELECT verdict, severity FROM lens_verdicts WHERE theory_id = $1 ORDER BY created_at DESC LIMIT 7",
    [theoryId]
  );

  const ev = await query<{ confirmed: string; disconfirmed: string }>(
    `SELECT
       count(*) FILTER (WHERE evidence_status = 'confirmed')::text AS confirmed,
       count(*) FILTER (WHERE evidence_status = 'disconfirmed')::text AS disconfirmed
     FROM theory_nodes WHERE theory_id = $1`,
    [theoryId]
  );
  const confirmed = Number(ev[0]?.confirmed ?? 0);
  const disconfirmed = Number(ev[0]?.disconfirmed ?? 0);
  const evidenceAdj = Math.max(-0.25, Math.min(0.25, 0.05 * confirmed - 0.08 * disconfirmed));

  let score = base - lensPenalty(verdicts) + evidenceAdj;
  score = Math.max(0, Math.min(1, score));
  const confidence = scoreToConfidence(score);

  await query("UPDATE theories SET score = $1, confidence = $2, updated_at = now() WHERE id = $3", [
    score,
    confidence,
    theoryId,
  ]);
  await query(
    "INSERT INTO confidence_history (theory_id, level, score, reason) VALUES ($1,$2,$3,$4)",
    [theoryId, confidence, score, reason]
  );
  return { score, confidence };
}
