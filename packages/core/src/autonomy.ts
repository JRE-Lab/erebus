// Autonomous roaming: EREBUS picks where to branch next and expands it on its
// own. Shared by the worker (scheduled) and the API (/api/roam on demand).
import { pool } from "@erebus/db";
import { expandForward } from "./tree.js";
import { resolveDueNodes } from "./scoring.js";

// Pick the most promising node to branch from. Deep-review fix: the old order
// (launch DESC, stability ASC, ...) was STICKY — expanding a node changed none
// of its ranking keys, so one fragile launch point absorbed the whole roam
// budget and, once depth-capped, deadlocked roaming forever. Now:
//  - expand_blocked (max-depth / max-children) and resolved nodes are excluded,
//  - child count ranks FIRST so expansion itself rotates selection,
//  - last_expanded_at breaks ties toward least-recently-touched,
//  - fragility (low stability) still matters, but can no longer pin selection.
export async function selectNext(): Promise<string | null> {
  const res = await pool.query(
    `SELECT n.id
       FROM nodes n
       LEFT JOIN (SELECT parent_id, count(*) AS c FROM nodes GROUP BY parent_id) ch ON ch.parent_id = n.id
      WHERE n.state IN ('speculative','corroborating','corroborated','tipping')
        AND n.merged_into IS NULL
        AND n.resolved IS NULL
        AND n.expand_blocked IS NOT TRUE
      ORDER BY n.is_launch_point DESC, COALESCE(ch.c, 0) ASC,
               n.last_expanded_at ASC NULLS FIRST, n.stability ASC, n.created_at ASC
      LIMIT 1`
  );
  return res.rows[0]?.id ?? null;
}

export interface RoamResult {
  status: "expanded" | "idle" | "blocked";
  nodeId?: string;
  expanded: number;
  childIds: string[]; // ids of the new children (so callers can green them)
  cost: number;
  blocked?: string;
}

// One autonomous step: resolve anything due, then branch one node forward.
// childIds lets the caller (worker/API) match the new branches against existing
// signals so autonomously-grown nodes green from reality, not just by chance.
export async function roamOnce(): Promise<RoamResult> {
  await resolveDueNodes();
  const id = await selectNext();
  if (!id) return { status: "idle", expanded: 0, childIds: [], cost: 0 };
  const r = await expandForward(id, "erebus");
  if (r.blocked) return { status: "blocked", nodeId: id, expanded: 0, childIds: [], cost: r.cost, blocked: r.blocked };
  return { status: "expanded", nodeId: id, expanded: r.children.length, childIds: r.children.map((c) => c.id), cost: r.cost };
}
