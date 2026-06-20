// Analysis of Competing Hypotheses. Instead of confirming one favored outcome,
// enumerate 3-5 rival equilibria and track a posterior distribution over them as
// evidence arrives — reality SELECTS among hypotheses. The mass on the node's
// own stated outcome becomes its P(outcome), so ACH feeds the greening state.
import { eq, desc } from "drizzle-orm";
import { db, nodes, signalMatches, signals } from "@erebus/db";
import { callJSON, achPrompt, OPUS } from "@erebus/agents";

export interface Hypothesis {
  label: string;
  probability: number;
}

interface AchShape {
  hypotheses: Hypothesis[];
  outcomeIndex: number;
  note: string;
}

function normalize(hyps: Hypothesis[]): Hypothesis[] {
  const clean = hyps
    .filter((h) => h && typeof h.label === "string" && h.label.trim())
    .map((h) => ({ label: h.label.trim(), probability: Math.max(0, Number(h.probability) || 0) }))
    .slice(0, 6);
  const sum = clean.reduce((a, h) => a + h.probability, 0);
  if (sum <= 0) {
    const u = clean.length ? 1 / clean.length : 0;
    return clean.map((h) => ({ ...h, probability: u }));
  }
  return clean.map((h) => ({ ...h, probability: h.probability / sum }));
}

export interface AchResult {
  hypotheses: Hypothesis[];
  outcomeProbability: number | null;
  leaderIsOutcome: boolean;
  note: string;
  cost: number;
  offline: boolean;
}

export async function runACH(nodeId: string): Promise<AchResult | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;

  // Recent matched-signal titles as the evidence set (diagnostic for ACH).
  const evid = await db
    .select({ title: signals.title, effect: signalMatches.effect })
    .from(signalMatches)
    .leftJoin(signals, eq(signalMatches.signalId, signals.id))
    .where(eq(signalMatches.nodeId, nodeId))
    .orderBy(desc(signalMatches.createdAt))
    .limit(12);
  const evidence = evid
    .filter((e) => e.title)
    .map((e) => `${e.title} [${e.effect}]`);

  const { data, cost, offline } = await callJSON<AchShape>(
    achPrompt({ question: node.question, outcome: node.outcome }, evidence),
    { hypotheses: [], outcomeIndex: 0, note: "" },
    { tier: "opus", agent: "ach", targetNode: nodeId, maxTokens: 1200 }
  );

  // Capture the stated-outcome label from the RAW array BEFORE normalize()
  // filters/reorders — otherwise outcomeIndex would point at the wrong entry.
  const rawHyps = Array.isArray(data.hypotheses) ? data.hypotheses : [];
  const rawIdx = Number.isInteger(data.outcomeIndex) ? data.outcomeIndex : 0;
  const targetLabel = (rawHyps[rawIdx]?.label ?? "").trim();

  const hypotheses = normalize(rawHyps);
  if (!hypotheses.length) {
    return { hypotheses: [], outcomeProbability: null, leaderIsOutcome: false, note: data.note ?? "", cost, offline };
  }

  // Which hypothesis is the stated outcome (matched by label, falling back to 0)?
  let idx = targetLabel ? hypotheses.findIndex((h) => h.label === targetLabel) : 0;
  if (idx < 0) idx = 0;
  const outcomeProbability = hypotheses[idx]!.probability;
  let leaderIdx = 0;
  for (let i = 1; i < hypotheses.length; i++) if (hypotheses[i]!.probability > hypotheses[leaderIdx]!.probability) leaderIdx = i;
  const leaderIsOutcome = leaderIdx === idx;

  // Persist the distribution as a NON-DESTRUCTIVE analytical overlay. We do NOT
  // overwrite the node's signal-accumulated probability — a one-shot ACH read
  // must not wipe out evidence-driven greening. (Future: let the matcher update
  // these hypothesis posteriors directly so reality SELECTS among them.)
  await db.update(nodes).set({ hypotheses: hypotheses as object, updatedAt: new Date() }).where(eq(nodes.id, nodeId));

  return { hypotheses, outcomeProbability, leaderIsOutcome, note: data.note ?? "", cost, offline };
}
