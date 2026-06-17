// ============================================================================
// EREBUS v2 — The Gardener. Prunes/merges/decays DEAD WOOD ONLY.
//
// Hard rule from CLAUDE.md §2.4 / §8: NEVER prune a node for being speculative
// or unproven. Forward speculation is the engine. The Gardener only touches:
//   - PRUNE  dead wood: dormant past TTL with zero children AND zero signal
//            matches (not corroborated, not recently touched) -> state 'dormant'
//   - MERGE  near-duplicate active nodes (cosine distance < 0.05) -> the lower
//            confirmation one is folded into the survivor, children repointed
//   - DECAY  un-revalidated corroborating/speculative nodes -> confidence * 0.9
//
// Nothing is ever deleted. Everything is guarded; never throws on an empty tree.
// ============================================================================
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  nodes,
  signalMatches,
  gardenerActions,
  recordEvent,
  nearest,
} from "@erebus/db";
import type { NodeRow } from "@erebus/core";

// States the Gardener is allowed to consider as "dead wood" candidates. These
// are the UNPROVEN / not-yet-grounded states — but they are only pruned when
// ALSO dormant, childless, and unmatched. Speculation alone is never prunable.
const DEAD_WOOD_STATES = ["speculative", "corroborating"] as const;

// Cosine distance below which two active nodes are treated as near-duplicates.
const MERGE_DISTANCE = 0.05;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GardenerResult {
  pruned: number;
  merged: number;
  decayed: number;
}

async function childCount(nodeId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(nodes)
      .where(eq(nodes.parentId, nodeId));
    return Number(row?.c ?? 0);
  } catch {
    return Number.MAX_SAFE_INTEGER; // on error, treat as "has children" -> never prune
  }
}

async function matchCount(nodeId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(signalMatches)
      .where(eq(signalMatches.nodeId, nodeId));
    return Number(row?.c ?? 0);
  } catch {
    return Number.MAX_SAFE_INTEGER; // on error, treat as "has matches" -> never prune
  }
}

async function logAction(action: "prune" | "merge" | "decay", nodeId: string, reason: string, relatedNode?: string) {
  try {
    await db.insert(gardenerActions).values({
      action,
      nodeId,
      relatedNode: relatedNode ?? null,
      reason,
    });
  } catch {
    /* action log is best-effort, never blocks the mutation */
  }
}

// ---------------------------------------------------------------------------
// PRUNE — dead wood only. A node is dead wood iff:
//   state IN (speculative, corroborating)  (unproven, never corroborated)
//   AND updatedAt older than `cutoff`       (not recently touched)
//   AND zero children                       (nothing branches off it)
//   AND zero signal_matches                 (reality never engaged it)
// We do NOT delete; we set state='dormant'.
// ---------------------------------------------------------------------------
async function prune(cutoff: Date): Promise<number> {
  let candidates: NodeRow[];
  try {
    candidates = await db
      .select()
      .from(nodes)
      .where(
        and(
          inArray(nodes.state, DEAD_WOOD_STATES as unknown as string[]),
          lt(nodes.updatedAt, cutoff)
        )
      );
  } catch {
    return 0;
  }

  let pruned = 0;
  for (const node of candidates) {
    // Re-affirm the safety invariant per node: must have NO children and NO matches.
    const kids = await childCount(node.id);
    if (kids > 0) continue;
    const matches = await matchCount(node.id);
    if (matches > 0) continue;

    const reason = `dead wood: dormant past TTL (updated ${node.updatedAt?.toISOString?.() ?? "?"}), 0 children, 0 signal matches, state ${node.state}`;
    try {
      await db
        .update(nodes)
        .set({ state: "dormant", updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
    } catch {
      continue;
    }
    await logAction("prune", node.id, reason);
    await recordEvent({
      nodeId: node.id,
      kind: "state_change",
      causeType: "job",
      before: { state: node.state },
      after: { state: "dormant", reason: "gardener-prune" },
    });
    pruned++;
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// MERGE — fold near-duplicate ACTIVE nodes together. We compare each active
// node against its nearest neighbours; if a different active node sits within
// MERGE_DISTANCE (cosine) we keep the higher-confirmation one as the survivor
// and merge the other into it: set mergedInto + state='merged', repoint the
// loser's children to the survivor. Each pair is handled once.
// ---------------------------------------------------------------------------
const ACTIVE_STATES = [
  "speculative",
  "corroborating",
  "corroborated",
  "contradicted",
] as const;

async function merge(): Promise<number> {
  let active: NodeRow[];
  try {
    active = await db
      .select()
      .from(nodes)
      .where(
        and(
          inArray(nodes.state, ACTIVE_STATES as unknown as string[]),
          isNull(nodes.mergedInto)
        )
      );
  } catch {
    return 0;
  }
  if (active.length < 2) return 0;

  const alive = new Map<string, NodeRow>();
  for (const n of active) alive.set(n.id, n);

  let merged = 0;
  for (const node of active) {
    if (!alive.has(node.id)) continue; // already merged away this pass
    const emb = node.embedding;
    if (!emb || emb.length === 0) continue;

    let neighbours: { id: string; distance: number }[];
    try {
      neighbours = await nearest("nodes", emb, 6);
    } catch {
      continue;
    }

    for (const nb of neighbours) {
      if (nb.id === node.id) continue;
      if (nb.distance >= MERGE_DISTANCE) continue; // ordered ascending; could break, but be safe
      const other = alive.get(nb.id);
      if (!other) continue; // neighbour isn't an active, unmerged candidate

      // Survivor = higher confirmation. Tie -> keep the current `node`.
      const survivor = other.confirmation > node.confirmation ? other : node;
      const loser = survivor.id === node.id ? other : node;
      if (survivor.id === loser.id) continue;

      const reason = `near-duplicate (cosine ${nb.distance.toFixed(4)} < ${MERGE_DISTANCE}); folded ${loser.id} (conf ${loser.confirmation.toFixed(2)}) into ${survivor.id} (conf ${survivor.confirmation.toFixed(2)})`;

      try {
        // Repoint loser's children to the survivor.
        await db
          .update(nodes)
          .set({ parentId: survivor.id, updatedAt: new Date() })
          .where(eq(nodes.parentId, loser.id));
        // Mark the loser merged.
        await db
          .update(nodes)
          .set({ mergedInto: survivor.id, state: "merged", updatedAt: new Date() })
          .where(eq(nodes.id, loser.id));
      } catch {
        continue;
      }

      await logAction("merge", loser.id, reason, survivor.id);
      await recordEvent({
        nodeId: loser.id,
        kind: "state_change",
        causeType: "job",
        before: { state: loser.state, mergedInto: null },
        after: { state: "merged", mergedInto: survivor.id, reason: "gardener-merge" },
      });

      alive.delete(loser.id); // loser is gone from the active set
      merged++;

      if (loser.id === node.id) break; // current node was the one merged; stop scanning its neighbours
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// DECAY — un-revalidated corroborating/speculative nodes lose confidence over
// time. Multiply confidence by 0.9 and stamp lastValidatedAt. This only nudges
// the SECONDARY internal-confidence signal; it never touches confirmation/state
// and never prunes. A node is due for decay when it has never been validated,
// or its last validation is older than `cutoff`.
// ---------------------------------------------------------------------------
async function decay(cutoff: Date): Promise<number> {
  let candidates: NodeRow[];
  try {
    candidates = await db
      .select()
      .from(nodes)
      .where(
        and(
          inArray(nodes.state, DEAD_WOOD_STATES as unknown as string[]),
          or(isNull(nodes.lastValidatedAt), lt(nodes.lastValidatedAt, cutoff))
        )
      );
  } catch {
    return 0;
  }

  const now = new Date();
  let decayed = 0;
  for (const node of candidates) {
    const before = node.confidence;
    const after = before * 0.9;
    try {
      await db
        .update(nodes)
        .set({ confidence: after, lastValidatedAt: now, updatedAt: now })
        .where(eq(nodes.id, node.id));
    } catch {
      continue;
    }
    await logAction("decay", node.id, `un-revalidated past TTL; confidence ${before.toFixed(3)} -> ${after.toFixed(3)}`);
    await recordEvent({
      nodeId: node.id,
      kind: "confirmation_change",
      causeType: "job",
      before: { confidence: before },
      after: { confidence: after, reason: "gardener-decay" },
    });
    decayed++;
  }
  return decayed;
}

// ---------------------------------------------------------------------------
// runGardener — one full pass: prune dead wood, merge duplicates, decay the
// un-revalidated. Fully guarded; returns zeroed counts on an empty tree.
// ---------------------------------------------------------------------------
export async function runGardener(
  { dormantDays = 30 }: { dormantDays?: number } = {}
): Promise<GardenerResult> {
  const days = Number.isFinite(dormantDays) && dormantDays > 0 ? dormantDays : 30;
  const cutoff = new Date(Date.now() - days * DAY_MS);

  let pruned = 0;
  let merged = 0;
  let decayed = 0;

  try {
    pruned = await prune(cutoff);
  } catch {
    pruned = 0;
  }
  try {
    merged = await merge();
  } catch {
    merged = 0;
  }
  try {
    decayed = await decay(cutoff);
  } catch {
    decayed = 0;
  }

  return { pruned, merged, decayed };
}
