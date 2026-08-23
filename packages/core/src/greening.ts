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

// Bayesian update scale: how many nats of evidence a unit-weight match carries.
// ~3-4 strong (weight 1) confirms cross into corroborated, matching the prior
// feel of the system while giving proper diminishing returns near certainty.
const LLR_SCALE = 0.5;
const P_FLOOR = 0.02;
const P_CEIL = 0.98;

const clampP = (p: number) => Math.max(P_FLOOR, Math.min(P_CEIL, p));
const toLogOdds = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const fromLogOdds = (lo: number) => clampP(1 / (1 + Math.exp(-lo)));
// confirmation (the display/state scalar in [-1,1]) is a pure view of probability.
const confFromP = (p: number) => 2 * clampP(p) - 1;
const pFromConf = (c: number) => clampP((c + 1) / 2);

// Below this equilibrium-stability, a confirming node is "tipping": greening on
// reality yet sitting on a fragile equilibrium a small move could flip.
export const FRAGILE_BELOW = 0.35;

export function stateFromConfirmation(
  confirmation: number,
  resolved?: boolean | null,
  brier?: number | null,
  stability?: number | null,
  resolvedOutcome?: boolean | null
): NodeState {
  // Resolved state comes from the ACTUAL outcome, never from the Brier score
  // (a correctly-resolved-true node at p=0.4 has brier=0.36 — the old proxy
  // rendered it resolved_false). Brier remains only as a legacy fallback for
  // rows adjudicated before resolvedOutcome existed.
  if (resolved) {
    const happened = resolvedOutcome ?? (brier ?? 1) < 0.25;
    return happened ? "resolved_true" : "resolved_false";
  }
  if (confirmation <= THRESH.contradicted) return "contradicted";
  const fragile = typeof stability === "number" && stability < FRAGILE_BELOW;
  // A forecast that's confirming but on a knife-edge equilibrium is "tipping".
  if (confirmation >= THRESH.corroborating && fragile) return "tipping";
  if (confirmation >= THRESH.corroborated) return "corroborated";
  if (confirmation >= THRESH.corroborating) return "corroborating";
  return "speculative";
}

// Apply a single signal match as a BAYESIAN update: the match contributes a
// log-likelihood-ratio (± weight*scale nats) to the node's P(outcome). The
// confirmation scalar [-1,1] is a pure view of that probability (2p-1), so the
// state machine + UI keep working. Sigmoid gives natural diminishing returns
// near certainty (no more raw volume saturation).
// A node reality has finished with (resolved) or the gardener has retired
// (dormant/merged) must never receive further evidence updates — resolved
// probabilities are the calibration ledger, and merged/dormant nodes would
// otherwise "resurrect" into live states.
function isTerminal(node: { resolved: boolean | null; state: string; mergedInto: string | null }): boolean {
  return Boolean(node.resolved) || node.mergedInto !== null || node.state === "dormant" || node.state === "merged";
}

export async function applyMatch(
  nodeId: string,
  effect: MatchEffect,
  weight: number,
  causeId?: string
): Promise<{ confirmation: number; state: NodeState; probability: number } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;
  if (isTerminal(node)) {
    return { confirmation: node.confirmation, state: node.state as NodeState, probability: node.probability ?? pFromConf(node.confirmation) };
  }

  const p0 = node.probability ?? pFromConf(node.confirmation);
  const w = Math.max(0, Math.min(1, weight));
  const dir = effect === "confirm" ? 1 : effect === "refute" ? -1 : 0;
  // Neutral, or a zero/non-positive-weight match: no evidence, no DB write.
  if (dir === 0 || w === 0) {
    return { confirmation: confFromP(p0), state: node.state as NodeState, probability: p0 };
  }

  const llr = dir * w * LLR_SCALE;
  const probability = fromLogOdds(toLogOdds(p0) + llr);
  const confirmation = confFromP(probability);
  const state = stateFromConfirmation(confirmation, node.resolved, node.brier, node.stability);
  const isLaunch = state === "corroborated";

  // ACH unification: the same evidence reallocates mass among the rival
  // hypotheses — the stated-outcome hypothesis moves by the same LLR and the
  // rivals renormalize, so reality SELECTS among the competing equilibria.
  let hypotheses = node.hypotheses as Array<{ label: string; probability: number; isOutcome?: boolean }> | null;
  if (Array.isArray(hypotheses) && hypotheses.length > 1 && hypotheses.some((h) => h?.isOutcome)) {
    const hs = hypotheses.map((h) => ({ ...h }));
    const oi = hs.findIndex((h) => h.isOutcome);
    const prev = Math.max(P_FLOOR, Math.min(P_CEIL, hs[oi]!.probability));
    const next = fromLogOdds(toLogOdds(prev) + llr);
    const restPrev = 1 - prev;
    const restNext = 1 - next;
    for (let i = 0; i < hs.length; i++) {
      if (i === oi) hs[i]!.probability = next;
      else hs[i]!.probability = restPrev > 0 ? (hs[i]!.probability / restPrev) * restNext : restNext / (hs.length - 1);
    }
    // renormalize (clamping can introduce small drift) so the masses sum to 1
    const total = hs.reduce((a, h) => a + h.probability, 0);
    if (total > 0) for (const h of hs) h.probability = h.probability / total;
    hypotheses = hs;
  } else {
    hypotheses = null; // unchanged — don't rewrite the column
  }

  await db
    .update(nodes)
    .set({
      probability,
      confirmation,
      state,
      isLaunchPoint: isLaunch || node.isLaunchPoint,
      ...(hypotheses ? { hypotheses: hypotheses as object } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, nodeId));

  await recordEvent({
    nodeId,
    kind: state !== node.state ? "state_change" : "confirmation_change",
    causeType: "signal_match",
    causeId,
    before: { state: node.state, probability: Number(p0.toFixed(3)), confirmation: node.confirmation },
    after: { state, probability: Number(probability.toFixed(3)), confirmation, llr: Number(llr.toFixed(3)) },
  });
  return { confirmation, state, probability };
}

// Set a node's P(outcome) directly (e.g. from an ACH posterior) and recompute
// confirmation + state. Returns the new derived values.
export async function setProbability(
  nodeId: string,
  probability: number
): Promise<{ confirmation: number; state: NodeState; probability: number } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;
  if (isTerminal(node)) {
    return { confirmation: node.confirmation, state: node.state as NodeState, probability: node.probability ?? pFromConf(node.confirmation) };
  }
  const p = clampP(probability);
  const confirmation = confFromP(p);
  const state = stateFromConfirmation(confirmation, node.resolved, node.brier, node.stability);
  const isLaunch = state === "corroborated";
  await db
    .update(nodes)
    .set({ probability: p, confirmation, state, isLaunchPoint: isLaunch || node.isLaunchPoint, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId));
  if (state !== node.state) {
    await recordEvent({
      nodeId,
      kind: "state_change",
      causeType: "job",
      before: { state: node.state, probability: node.probability },
      after: { state, probability: p },
    });
  }
  return { confirmation, state, probability: p };
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
  if (isTerminal(node)) return { state: node.state as NodeState, stability: node.stability };
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
