// Evidence confirmation: judge whether a Theory Tree branch has been confirmed,
// partially confirmed, disconfirmed, or remains pending — grounded in ingested
// events + the activity feed.
import { query, queryOne } from "@erebus/db";
import type { EvidenceStatus, EvidenceDetail } from "@erebus/core";
import { callClaudeJSON } from "../llm/claude.js";

function broadcast(type: string, payload: unknown) {
  (globalThis as { broadcast?: (t: string, p: unknown) => void }).broadcast?.(type, payload);
}

interface EvidenceJudgement {
  status: EvidenceStatus;
  confidence: number;
  summary: string;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  key_indicator: string;
}

export interface EvidenceCheckResult {
  nodeId: string;
  status: EvidenceStatus;
  evidence: EvidenceDetail;
  cost: number;
}

export async function checkNodeEvidence(nodeId: string): Promise<EvidenceCheckResult | null> {
  const node = await queryOne<{
    content: string;
    questions: string[];
    theory_title: string;
    theory_summary: string;
  }>(
    `SELECT tn.content, tn.questions, t.title AS theory_title, t.summary AS theory_summary
       FROM theory_nodes tn JOIN theories t ON t.id = tn.theory_id
      WHERE tn.id = $1`,
    [nodeId]
  );
  if (!node) return null;

  const events = await query<{ title: string; published_at: string | null }>(
    "SELECT title, published_at FROM events ORDER BY observed_at DESC LIMIT 40"
  );
  const feed = await query<{ title: string; summary: string }>(
    "SELECT title, summary FROM feed_items ORDER BY created_at DESC LIMIT 20"
  );

  const eventCtx =
    events.map((e) => `- [${e.published_at?.slice(0, 10) ?? "recent"}] ${e.title}`).join("\n") ||
    "No ingested events yet.";
  const feedCtx = feed.map((f) => `- ${f.title}: ${f.summary}`).join("\n") || "No findings yet.";

  const system = `You are EREBUS evaluating whether a theory branch has materialized in the real world. Be strict and evidence-based.
- confirmed: strong direct evidence the branch's claim has happened
- partial: some supporting evidence, key elements missing
- disconfirmed: evidence contradicts the claim
- pending: insufficient evidence either way`;

  const fallback: EvidenceJudgement = {
    status: "pending",
    confidence: 0.3,
    summary: "[offline] No LLM available to evaluate evidence.",
    supporting_evidence: [],
    contradicting_evidence: [],
    key_indicator: "Add an Anthropic API key to enable evidence checking.",
  };

  const prompt = `THEORY: ${node.theory_title}
SUMMARY: ${node.theory_summary}

BRANCH TO EVALUATE:
${node.content}

QUESTIONS THIS BRANCH OPENED:
${(node.questions || []).map((q, i) => `${i + 1}. ${q}`).join("\n")}

RECENT EVENTS:
${eventCtx}

RECENT FINDINGS:
${feedCtx}

Has this branch been confirmed, partially confirmed, disconfirmed, or is it still pending? Cite specific events.
Return JSON: { "status","confidence","summary","supporting_evidence":[],"contradicting_evidence":[],"key_indicator" }`;

  const { data, cost } = await callClaudeJSON<EvidenceJudgement>(prompt, fallback, {
    tier: "deep",
    agent: "evidence-checker",
    system,
    maxTokens: 1200,
  });

  const evidence: EvidenceDetail = {
    summary: data.summary,
    confidence: data.confidence,
    supporting: data.supporting_evidence ?? [],
    contradicting: data.contradicting_evidence ?? [],
    key_indicator: data.key_indicator,
    checked_at: new Date().toISOString(),
  };

  await query(
    "UPDATE theory_nodes SET evidence_status = $1, evidence = $2, evidence_checked_at = now() WHERE id = $3",
    [data.status, JSON.stringify(evidence), nodeId]
  );
  broadcast("evidence_checked", { nodeId, status: data.status });
  return { nodeId, status: data.status, evidence, cost };
}

export async function checkAllEvidence(
  theoryId: string
): Promise<{ checked: number; totalCost: number; results: Array<{ nodeId: string; status: EvidenceStatus }> }> {
  const nodes = await query<{ id: string }>(
    "SELECT id FROM theory_nodes WHERE theory_id = $1 AND content <> '' ORDER BY depth, created_at",
    [theoryId]
  );
  const results: Array<{ nodeId: string; status: EvidenceStatus }> = [];
  let totalCost = 0;
  for (const n of nodes) {
    const r = await checkNodeEvidence(n.id);
    if (r) {
      results.push({ nodeId: r.nodeId, status: r.status });
      totalCost += r.cost;
    }
  }
  return { checked: results.length, totalCost, results };
}
