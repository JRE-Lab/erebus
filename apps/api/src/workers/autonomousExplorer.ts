// Autonomously expands the most promising unexplored branch on an active theory.
import { query } from "@erebus/db";
import { expandNode } from "../engine/theoryTree.js";
import { withinBudget } from "./budget.js";

export async function runAutonomousExplorer(): Promise<{ expanded: number }> {
  if (!(await withinBudget())) {
    console.log("[explorer] daily budget reached, skipping");
    return { expanded: 0 };
  }

  // Find leaf nodes (no children) that still have open questions, preferring
  // shallower nodes on more recently active theories.
  const candidates = await query<{ id: string }>(
    `SELECT tn.id
       FROM theory_nodes tn
       JOIN theories t ON t.id = tn.theory_id
      WHERE t.status = 'ACTIVE'
        AND jsonb_array_length(tn.questions) > 0
        AND NOT EXISTS (SELECT 1 FROM theory_nodes c WHERE c.parent_id = tn.id)
      ORDER BY tn.shadow_tagged DESC, tn.financial_signal DESC, tn.depth ASC, t.updated_at DESC
      LIMIT 3`
  );

  let expanded = 0;
  for (const cand of candidates) {
    const child = await expandNode(cand.id, undefined, "erebus");
    if (child) expanded++;
  }
  if (expanded > 0) {
    await query(
      `INSERT INTO feed_items (type, title, summary, priority)
       VALUES ('theory_update', $1, 'EREBUS autonomously expanded the tree overnight.', 'MEDIUM')`,
      [`Autonomous exploration: ${expanded} branch(es)`]
    );
  }
  return { expanded };
}
