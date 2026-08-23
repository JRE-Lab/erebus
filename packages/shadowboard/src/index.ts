// ============================================================================
// EREBUS v2 — Shadow Board (deception analysis). A "shadow read" runs an
// intelligence-tradecraft pass on a node: stated narrative vs. revealed
// preference, cui bono, counter-narrative, deception indicators, misdirection.
// Disciplined, not conspiratorial. May spawn a contested counter-forecast
// linked by a `tension` relationship. Fully resilient offline (the LLM
// fallback yields an empty read and never spawns).
// ============================================================================
import { eq } from "drizzle-orm";
import {
  db,
  nodes,
  shadowReads,
  relationships,
  recordEvent,
} from "@erebus/db";
import { callJSON, shadowReadPrompt, OPUS } from "@erebus/agents";
import { createForecast } from "@erebus/core";

// Shape the LLM returns (mirrors shadowReadPrompt's JSON contract).
interface ShadowShape {
  revealed_preference: string;
  cui_bono: string;
  counter_narrative: string;
  deception_indicators: string[];
  misdirection: string;
  spawn_contested: boolean;
}

const EMPTY_READ: ShadowShape = {
  revealed_preference: "",
  cui_bono: "",
  counter_narrative: "",
  deception_indicators: [],
  misdirection: "",
  spawn_contested: false,
};

export type ShadowReadRow = typeof shadowReads.$inferSelect;

export interface ShadowReadResult {
  shadowRead: ShadowReadRow | null;
  spawnedNode: string | null;
  cost: number;
  offline: boolean;
}

export async function runShadowRead(nodeId: string): Promise<ShadowReadResult> {
  // Load the node under analysis.
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) {
    return { shadowRead: null, spawnedNode: null, cost: 0, offline: false };
  }

  // Run the shadow read (Opus). Offline -> EMPTY_READ, no spawn, no crash.
  const { data, cost, offline, parsed } = await callJSON<ShadowShape>(
    shadowReadPrompt({ question: node.question, outcome: node.outcome }),
    EMPTY_READ,
    { tier: "opus", agent: "shadow", targetNode: nodeId }
  );
  // Never persist the EMPTY_READ fallback as a real analysis row.
  if (offline || !parsed) {
    return { shadowRead: null, spawnedNode: null, cost, offline };
  }

  // Persist the shadow read.
  const [sr] = await db
    .insert(shadowReads)
    .values({
      nodeId,
      revealedPreference: data.revealed_preference ?? null,
      cuiBono: data.cui_bono ?? null,
      counterNarrative: data.counter_narrative ?? null,
      deceptionIndicators: data.deception_indicators ?? [],
      misdirection: data.misdirection ?? null,
      model: OPUS,
    })
    .returning();

  let totalCost = cost;
  let spawnedNode: string | null = null;

  // If the read warrants it, spawn a contested counter-forecast and link it
  // with a `tension` relationship. Never fires offline (fallback => false).
  if (sr && data.spawn_contested === true && data.counter_narrative) {
    const contested = await createForecast(
      `Contested counter-read: ${node.question} -> ${data.counter_narrative}`
    );
    totalCost += contested.cost;
    // Never wire a fallback stub into the tree (budget/pause/parse failure
    // between the read and the spawn) — mirror genesis's stub cleanup.
    if (contested.offline || contested.node.outcome.startsWith("[offline]")) {
      try {
        await db.delete(nodes).where(eq(nodes.id, contested.node.id));
      } catch { /* best-effort */ }
      return { shadowRead: sr, spawnedNode: null, cost: totalCost, offline: false };
    }
    const newId = contested.node.id;
    spawnedNode = newId;

    // Connect the counter-forecast into the tree so it shows in the Explorer as
    // a contesting branch of the analyzed node (not a disconnected root). Marked
    // origin "shadow" + a ⚡ branch label so it reads as a tension branch.
    const siblings = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
    await db
      .update(nodes)
      .set({ parentId: nodeId, origin: "shadow", branchLabel: `⚡${siblings.length + 1}`, updatedAt: new Date() })
      .where(eq(nodes.id, newId));

    const rationale = `Shadow Board counter-read of ${nodeId}: ${data.counter_narrative}`;
    await db.insert(relationships).values({
      fromNode: nodeId,
      toNode: newId,
      type: "tension",
      rationale,
    });

    await db.update(shadowReads).set({ spawnedNode: newId }).where(eq(shadowReads.id, sr.id));

    await recordEvent({
      nodeId,
      kind: "link_created",
      causeType: "shadow_read",
      causeId: sr.id,
      after: { toNode: newId, type: "tension", rationale },
      model: OPUS,
    });
  }

  return {
    shadowRead: sr ? (spawnedNode ? { ...sr, spawnedNode } : sr) : null,
    spawnedNode,
    cost: totalCost,
    offline,
  };
}
