// Recursion budget control for the Theory Tree.
import { query } from "@erebus/db";
import { TREE_BUDGET } from "@erebus/core";

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
}

export async function checkExpandBudget(theoryId: string, parentDepth: number): Promise<BudgetCheck> {
  if (parentDepth + 1 > TREE_BUDGET.maxDepth) {
    return { ok: false, reason: `max depth ${TREE_BUDGET.maxDepth} reached` };
  }
  const rows = await query<{ count: string }>(
    "SELECT count(*)::text FROM theory_nodes WHERE theory_id = $1",
    [theoryId]
  );
  if (Number(rows[0]?.count ?? 0) >= TREE_BUDGET.maxNodesPerTheory) {
    return { ok: false, reason: `max nodes ${TREE_BUDGET.maxNodesPerTheory} reached` };
  }
  return { ok: true };
}
