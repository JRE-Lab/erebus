// Periodically re-checks the most stale theory's branches against new evidence.
import { query } from "@erebus/db";
import { checkAllEvidence } from "../evidence/checker.js";
import { withinBudget } from "./budget.js";

export async function runEvidenceSweeper(): Promise<{ theoryId: string | null; checked: number }> {
  if (!(await withinBudget())) {
    console.log("[evidence-sweep] daily budget reached, skipping");
    return { theoryId: null, checked: 0 };
  }
  // Theory with the oldest (or never) evidence check among active theories.
  const [theory] = await query<{ id: string }>(
    `SELECT t.id
       FROM theories t
      WHERE t.status = 'ACTIVE'
      ORDER BY (
        SELECT COALESCE(MAX(evidence_checked_at), 'epoch') FROM theory_nodes WHERE theory_id = t.id
      ) ASC
      LIMIT 1`
  );
  if (!theory) return { theoryId: null, checked: 0 };
  const res = await checkAllEvidence(theory.id);
  return { theoryId: theory.id, checked: res.checked };
}
