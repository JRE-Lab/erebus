// The greening state machine. Confirmation in [-1, 1] drives state along the
// gradient. Greening = grounding = calibration — one mechanism (CLAUDE.md §2.3).
import { eq } from "drizzle-orm";
import { db, nodes, recordEvent } from "@erebus/db";
import type { NodeState, MatchEffect } from "./types.js";

export const THRESH = {
  corroborating: 0.34, // amber
  corroborated: 0.67, // green -> launch point
  contradicted: -0.5, // red
};

// Below this equilibrium-stability, a confirming node is "tipping": greening on
// reality yet sitting on a fragile equilibrium a small move could flip.
export const FRAGILE_BELOW = 0.35;

export function stateFromConfirmation(
  confirmation: number,
  resolved?: boolean | null,
  brier?: number | null,
  stability?: number | null
): NodeState {
  if (resolved) return (brier ?? 1) < 0.25 ? "resolved_true" : "resolved_false";
  if (confirmation <= THRESH.contradicted) return "contradicted";
  const fragile = typeof stability === "number" && stability < FRAGILE_BELOW;
  // A forecast that's confirming but on a knife-edge equilibrium is "tipping".
  if (confirmation >= THRESH.corroborating && fragile) return "tipping";
  if (confirmation >= THRESH.corroborated) return "corroborated";
  if (confirmation >= THRESH.corroborating) return "corroborating";
  return "speculative";
}

// Apply a single signal match to a node: move confirmation, recompute state,
// promote to launch point when corroborated, and log provenance.
export async function applyMatch(
  nodeId: string,
  effect: MatchEffect,
  weight: number,
  causeId?: string
): Promise<{ confirmation: number; state: NodeState } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;

  const delta = effect === "confirm" ? weight : effect === "refute" ? -weight : 0;
  if (delta === 0) return { confirmation: node.confirmation, state: node.state as NodeState };

  // Each strong (weight~1) match moves confirmation ~0.4; ~2 cross into
  // corroborating, ~4 reach corroborated. Volume of matches is the main driver.
  const confirmation = Math.max(-1, Math.min(1, node.confirmation + delta * 0.4));
  const state = stateFromConfirmation(confirmation, node.resolved, node.brier, node.stability);
  const isLaunch = state === "corroborated";

  await db
    .update(nodes)
    .set({ confirmation, state, isLaunchPoint: isLaunch || node.isLaunchPoint, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId));

  if (state !== node.state) {
    await recordEvent({
      nodeId,
      kind: "state_change",
      causeType: "signal_match",
      causeId,
      before: { state: node.state, confirmation: node.confirmation },
      after: { state, confirmation },
    });
  } else {
    await recordEvent({
      nodeId,
      kind: "confirmation_change",
      causeType: "signal_match",
      causeId,
      before: { confirmation: node.confirmation },
      after: { confirmation },
    });
  }
  return { confirmation, state };
}

// Apply an equilibrium-stability reading (from a game read) to a node and
// recompute its state — so a confirming-but-fragile forecast flips to "tipping".
export async function applyStability(
  nodeId: string,
  stability: number,
  equilibriumType?: string | null
): Promise<{ state: NodeState; stability: number } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;
  const s = Math.max(0, Math.min(1, stability));
  const state = stateFromConfirmation(node.confirmation, node.resolved, node.brier, s);
  await db
    .update(nodes)
    .set({ stability: s, equilibriumType: equilibriumType ?? node.equilibriumType, state, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId));
  if (state !== node.state) {
    await recordEvent({
      nodeId,
      kind: "state_change",
      causeType: "job",
      before: { state: node.state, stability: node.stability },
      after: { state, stability: s },
    });
  }
  return { state, stability: s };
}
