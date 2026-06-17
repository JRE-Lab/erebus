// Keeps the portfolio current: runs the Shadow Board on the theory that has
// gone longest without scrutiny, which also triggers a rescore.
import { query } from "@erebus/db";
import { runShadowBoard } from "../shadowboard/board.js";
import { withinBudget } from "./budget.js";

export async function runTheoryRefiner(): Promise<{ theoryId: string | null }> {
  if (!(await withinBudget())) {
    console.log("[refiner] daily budget reached, skipping");
    return { theoryId: null };
  }
  const [theory] = await query<{ id: string }>(
    `SELECT t.id
       FROM theories t
      WHERE t.status = 'ACTIVE'
      ORDER BY (
        SELECT COALESCE(MAX(created_at), 'epoch') FROM lens_verdicts WHERE theory_id = t.id
      ) ASC
      LIMIT 1`
  );
  if (!theory) return { theoryId: null };
  await runShadowBoard(theory.id);
  return { theoryId: theory.id };
}
