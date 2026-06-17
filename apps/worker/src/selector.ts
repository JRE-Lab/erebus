// ============================================================================
// The selector — decides what the worker works on next (CLAUDE.md §3.2.4, §10).
//
// Priority, top to bottom:
//   1) GREEN LAUNCH POINTS — nodes that reality has confirmed (state
//      'corroborated' OR is_launch_point). Build forward on solid ground. Among
//      these, prefer the ones with the FEWEST children (least-explored first).
//   2) A shallow speculative LEAF with no children — keep the frontier of pure
//      forward speculation advancing where the tree is thinnest.
//
// Returns null only when there is genuinely nothing to do (empty / fully
// dormant tree). Fully guarded; never throws.
// ============================================================================
import { pool } from "@erebus/db";

export type WorkerAction = "expand" | "synthesize" | "shadow";

export interface Pick {
  action: WorkerAction;
  nodeId: string;
  reason: string;
}

// Nodes the selector will never pick to extend from (terminal / inert states).
const INERT_STATES = ["dormant", "merged", "resolved_true", "resolved_false"];

// 1) Prefer a green launch point with the fewest children. Corroborated nodes
//    are solid ground; we branch forward from there. Ties broken by recency of
//    confirmation (most recently greened first) then id for determinism.
async function pickLaunchPoint(): Promise<Pick | null> {
  try {
    const res = await pool.query<{ id: string; child_count: number }>(
      `SELECT n.id,
              (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id)::int AS child_count
         FROM nodes n
        WHERE (n.state = 'corroborated' OR n.is_launch_point = true)
          AND n.state <> 'merged'
          AND n.resolved IS NOT TRUE
        ORDER BY child_count ASC, n.updated_at DESC, n.id ASC
        LIMIT 1`
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      action: "expand",
      nodeId: row.id,
      reason: `green launch point (${row.child_count} children) — branching forward from confirmed ground`,
    };
  } catch {
    return null;
  }
}

// 2) Otherwise a shallow speculative leaf with no children — push the frontier
//    where the tree is thinnest. Shallowest first (closest to a root), so the
//    tree fans out broadly before it runs deep.
async function pickSpeculativeLeaf(): Promise<Pick | null> {
  try {
    const inertList = INERT_STATES.map((s) => `'${s}'`).join(", ");
    const res = await pool.query<{ id: string; depth: number }>(
      `WITH RECURSIVE tree AS (
         SELECT id, parent_id, state, 0 AS depth FROM nodes WHERE parent_id IS NULL
         UNION ALL
         SELECT n.id, n.parent_id, n.state, t.depth + 1
           FROM nodes n JOIN tree t ON n.parent_id = t.id
       )
       SELECT t.id, t.depth
         FROM tree t
        WHERE t.state NOT IN (${inertList})
          AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = t.id)
        ORDER BY t.depth ASC, t.id ASC
        LIMIT 1`
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      action: "expand",
      nodeId: row.id,
      reason: `shallow speculative leaf (depth ${row.depth}) — extending the forward frontier`,
    };
  } catch {
    return null;
  }
}

// pickNext — the worker's "what now?" Green launch points first, then the
// thinnest speculative frontier. Null when the tree has nothing live to extend.
export async function pickNext(): Promise<Pick | null> {
  const launch = await pickLaunchPoint();
  if (launch) return launch;

  const leaf = await pickSpeculativeLeaf();
  if (leaf) return leaf;

  return null;
}
