// Shadow Board: runs all seven lenses in parallel against a theory, persists
// verdicts, computes an overall verdict, and triggers a rescore.
import { query, queryOne } from "@erebus/db";
import { LENS_KEYS, type LensKey, type LensVerdictValue, type ShadowBoardResult } from "@erebus/core";
import { callClaudeJSON } from "../llm/claude.js";
import { LENS_PROMPTS, lensUserPrompt } from "../llm/prompts/lenses.js";
import { rescoreTheory } from "../engine/scoring.js";

interface LensRaw {
  verdict: LensVerdictValue;
  severity: number;
  confidence: number;
  rationale: string;
}

function broadcast(type: string, payload: unknown) {
  (globalThis as { broadcast?: (t: string, p: unknown) => void }).broadcast?.(type, payload);
}

async function runLens(
  lens: LensKey,
  theory: { title: string; summary: string; full_analysis: string }
): Promise<LensRaw & { cost: number }> {
  const fallback: LensRaw = {
    verdict: "warn",
    severity: 0.3,
    confidence: 0.3,
    rationale: "[offline] Lens could not run without an LLM key.",
  };
  const { data, cost } = await callClaudeJSON<LensRaw>(
    lensUserPrompt({ title: theory.title, summary: theory.summary, analysis: theory.full_analysis }),
    fallback,
    { tier: "deep", agent: `lens:${lens}`, system: LENS_PROMPTS[lens], maxTokens: 700 }
  );
  return { ...data, cost };
}

export async function runShadowBoard(theoryId: string): Promise<ShadowBoardResult | null> {
  const theory = await queryOne<{ title: string; summary: string; full_analysis: string }>(
    "SELECT title, summary, full_analysis FROM theories WHERE id = $1",
    [theoryId]
  );
  if (!theory) return null;

  const results = await Promise.all(LENS_KEYS.map((lens) => runLens(lens, theory)));
  let totalCost = 0;

  const verdicts = results.map((r, i) => {
    totalCost += r.cost;
    return {
      lens: LENS_KEYS[i]!,
      verdict: r.verdict,
      severity: Number(r.severity) || 0,
      confidence: Number(r.confidence) || 0,
      rationale: r.rationale,
    };
  });

  // Clear prior verdicts for this theory, then insert the fresh set.
  await query("DELETE FROM lens_verdicts WHERE theory_id = $1 AND node_id IS NULL", [theoryId]);
  for (const v of verdicts) {
    await query(
      `INSERT INTO lens_verdicts (theory_id, lens, verdict, severity, confidence, rationale)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [theoryId, v.lens, v.verdict, v.severity, v.confidence, v.rationale]
    );
  }

  const fails = verdicts.filter((v) => v.verdict === "fail");
  const warns = verdicts.filter((v) => v.verdict === "warn");
  const overallVerdict: LensVerdictValue = fails.length >= 2 ? "fail" : fails.length + warns.length >= 3 ? "warn" : "pass";
  const overallSeverity = verdicts.reduce((s, v) => s + (v.verdict === "fail" ? v.severity : 0), 0) / 7;
  const summary = `${fails.length} fail, ${warns.length} warn, ${7 - fails.length - warns.length} pass across seven lenses.`;

  const { confidence } = await rescoreTheory(theoryId, "shadow board run");

  await query(
    `INSERT INTO feed_items (type, title, summary, priority, related_theory_ids)
     VALUES ('shadow', $1, $2, $3, $4)`,
    [
      `Shadow Board: ${theory.title}`,
      `${summary} New confidence: ${confidence}.`,
      fails.length >= 2 ? "HIGH" : "MEDIUM",
      [theoryId],
    ]
  );
  broadcast("shadowboard_complete", { theoryId, overallVerdict, cost: totalCost });

  return {
    theoryId,
    verdicts,
    overall: { verdict: overallVerdict, severity: overallSeverity, summary },
    cost: totalCost,
  };
}
