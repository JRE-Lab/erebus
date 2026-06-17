// ============================================================================
// The matcher — second stage of the Corroboration Engine. Take a signal,
// find its nearest forecast nodes by embedding, judge confirm/refute/neutral
// per candidate (LLM, Sonnet tier), record a signal_matches row, and green/red
// the node via applyMatch. Offline-safe: callJSON returns the neutral fallback.
// ============================================================================
import { eq } from "drizzle-orm";
import { db, signals, signalMatches, nodes, nearest } from "@erebus/db";
import { callJSON, matchPrompt } from "@erebus/agents";
import { applyMatch } from "@erebus/core";
import type { MatchEffect } from "@erebus/core";

const CANDIDATES = 8;

interface MatchVerdict {
  effect: MatchEffect;
  weight: number;
  rationale: string;
}

export interface MatchRecord {
  signalId: string;
  nodeId: string;
  effect: MatchEffect;
  weight: number;
  rationale: string;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function normEffect(e: unknown): MatchEffect {
  return e === "confirm" || e === "refute" ? e : "neutral";
}

// Match a single signal against its nearest forecast nodes. Returns every
// signal_matches row created (including neutral ones).
export async function matchSignal(signalId: string): Promise<MatchRecord[]> {
  const [signal] = await db.select().from(signals).where(eq(signals.id, signalId)).limit(1);
  if (!signal || !signal.embedding) return [];

  const candidates = await nearest("nodes", signal.embedding, CANDIDATES);
  const made: MatchRecord[] = [];

  for (const cand of candidates) {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, cand.id)).limit(1);
    if (!node) continue;

    const { data } = await callJSON<MatchVerdict>(
      matchPrompt(
        { title: signal.title ?? "", summary: signal.summary ?? "" },
        {
          question: node.question,
          outcome: node.outcome,
          indicators: node.indicators,
          falsifiers: node.falsifiers,
        }
      ),
      { effect: "neutral", weight: 0, rationale: "" },
      { tier: "sonnet", agent: "match", targetNode: node.id, maxTokens: 500 }
    );

    const effect = normEffect(data.effect);
    const weight = clamp01(data.weight);
    const rationale = typeof data.rationale === "string" ? data.rationale : "";

    const [matchRow] = await db
      .insert(signalMatches)
      .values({
        signalId: signal.id,
        nodeId: node.id,
        effect,
        weight,
        rationale,
      })
      .returning({ id: signalMatches.id });

    // confirm/refute green or red the node; neutral records only.
    if ((effect === "confirm" || effect === "refute") && weight > 0) {
      await applyMatch(node.id, effect, weight, matchRow?.id);
    }

    made.push({ signalId: signal.id, nodeId: node.id, effect, weight, rationale });
  }

  return made;
}
