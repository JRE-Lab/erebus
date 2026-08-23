// N-round cross-examination: proposer -> adversary -> synthesis. Sharpens the
// forecast + indicators and adjusts INTERNAL confidence only (via a provenance
// event). Reality, not debate, moves confirmation.
import { eq } from "drizzle-orm";
import { db, nodes, debates, recordEvent } from "@erebus/db";
import { call, callJSON, OPUS } from "./client.js";
import { proposerPrompt, adversaryPrompt, synthesisPrompt, PROMPT_VERSION } from "./prompts.js";

export interface DebateResult {
  rounds: number;
  verdict: string;
  confidenceBefore: number;
  confidenceAfter: number;
  revisedOutcome?: string;
  cost: number;
}

export async function runDebate(nodeId: string, rounds = 1): Promise<DebateResult | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;

  let cost = 0;
  let roundsPersisted = 0;
  let verdict = "hold";
  let revisedOutcome: string | undefined;
  let indicators = node.indicators ?? [];
  let falsifiers = node.falsifiers ?? [];
  const before = node.confidence;
  let confidence = node.confidence;

  for (let round = 1; round <= rounds; round++) {
    const pro = await call(proposerPrompt({ question: node.question, outcome: revisedOutcome ?? node.outcome, rationale: node.rationale ?? undefined }), {
      tier: "opus",
      agent: "debate:proposer",
      targetNode: nodeId,
      maxTokens: 1200,
    });
    cost += pro.cost;
    // Paused/offline/over-budget: don't persist empty debate rounds or mutate
    // the node's outcome/confidence off fallback content.
    if (pro.offline || !pro.content) break;

    const con = await call(adversaryPrompt({ question: node.question, outcome: revisedOutcome ?? node.outcome }, pro.content), {
      tier: "opus",
      agent: "debate:adversary",
      targetNode: nodeId,
      maxTokens: 1200,
    });
    cost += con.cost;

    const synth = await callJSON<{
      synthesis: string;
      verdict: string;
      revised_outcome: string;
      indicators: string[];
      falsifiers: string[];
      confidence_delta: number;
    }>(
      synthesisPrompt({ question: node.question, outcome: revisedOutcome ?? node.outcome }, pro.content, con.content),
      { synthesis: "", verdict: "hold", revised_outcome: node.outcome, indicators, falsifiers, confidence_delta: 0 },
      { tier: "opus", agent: "debate:synthesis", targetNode: nodeId, maxTokens: 1500 }
    );
    cost += synth.cost;
    // A round is only real if all three legs completed with parseable output —
    // never persist empty adversary/synthesis rows off fallbacks.
    if (con.offline || !con.content || synth.offline || !synth.parsed) break;

    verdict = synth.data.verdict || verdict;
    revisedOutcome = synth.data.revised_outcome || revisedOutcome;
    if (synth.data.indicators?.length) indicators = synth.data.indicators;
    if (synth.data.falsifiers?.length) falsifiers = synth.data.falsifiers;
    confidence = Math.max(0, Math.min(1, confidence + (Number(synth.data.confidence_delta) || 0)));

    await db.insert(debates).values({
      nodeId,
      round,
      proposer: pro.content,
      adversary: con.content,
      synthesis: synth.data.synthesis,
      verdict,
      confidenceDelta: Number(synth.data.confidence_delta) || 0,
      model: OPUS,
      promptVersion: PROMPT_VERSION,
    });
    roundsPersisted++;
  }

  // No completed rounds (paused/over-budget/outage): nothing to apply — avoid
  // the no-op node touch + before==after provenance event per attempt.
  if (roundsPersisted === 0) {
    return { rounds: 0, verdict, confidenceBefore: before, confidenceAfter: before, revisedOutcome: undefined, cost };
  }

  await db
    .update(nodes)
    .set({ confidence, outcome: revisedOutcome ?? node.outcome, indicators, falsifiers, updatedAt: new Date() })
    .where(eq(nodes.id, nodeId));

  await recordEvent({
    nodeId,
    kind: "confidence_change",
    causeType: "debate",
    before: { confidence: before },
    after: { confidence },
    model: OPUS,
    promptVersion: PROMPT_VERSION,
  });

  return { rounds, verdict, confidenceBefore: before, confidenceAfter: confidence, revisedOutcome, cost };
}
