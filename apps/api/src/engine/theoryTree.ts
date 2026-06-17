// Theory Tree engine: create theories and expand nodes (Opus-powered, with
// offline fallback so the tree still grows without an API key).
import { query, queryOne, embed, toVectorLiteral } from "@erebus/db";
import type { Theory, TheoryNode, NodeExpansion } from "@erebus/core";
import { callClaudeJSON } from "../llm/claude.js";
import { generateTheoryPrompt, expandNodePrompt } from "../llm/prompts/theory.js";
import { checkExpandBudget } from "./recursion.js";

function broadcast(type: string, payload: unknown) {
  (globalThis as { broadcast?: (t: string, p: unknown) => void }).broadcast?.(type, payload);
}

interface CreateInput {
  title?: string;
  context: string;
  slug?: string;
  rootEventId?: number;
  isShadow?: boolean;
}

export async function createTheory(input: CreateInput): Promise<Theory> {
  const fallback = {
    title: input.title || input.context.slice(0, 80),
    summary: input.context.slice(0, 240),
    full_analysis: "",
    domains: [] as string[],
    confidence: "EMERGING",
    novelty: { score: 0.5, reason: "" },
    change_everything: null as string | null,
    questions: [
      "What actors benefit most from this dynamic?",
      "What would falsify this theory?",
      "What is the timeline of key indicators?",
      "What second-order effects follow if true?",
    ],
  };
  const { data, cost } = await callClaudeJSON(
    generateTheoryPrompt({ title: input.title, context: input.context }),
    fallback,
    { tier: "deep", agent: "create-theory", maxTokens: 3000 }
  );

  const emb = await embed(`${data.title}\n${data.summary}`);
  const theory = await queryOne<Theory>(
    `INSERT INTO theories (slug, title, summary, full_analysis, confidence, domains, is_shadow, novelty, change_everything, root_event_id, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector) RETURNING *`,
    [
      input.slug ?? null,
      data.title,
      data.summary,
      data.full_analysis ?? "",
      data.confidence ?? "EMERGING",
      data.domains ?? [],
      input.isShadow ?? false,
      JSON.stringify(data.novelty ?? {}),
      data.change_everything ?? null,
      input.rootEventId ?? null,
      toVectorLiteral(emb),
    ]
  );
  if (!theory) throw new Error("theory insert failed");

  // Root node holds the thesis + first-branch questions.
  await query(
    `INSERT INTO theory_nodes (theory_id, parent_id, hypothesis, content, questions, depth, explored_by)
     VALUES ($1, NULL, $2, $3, $4, 0, 'user')`,
    [theory.id, theory.title, data.summary, JSON.stringify(data.questions ?? [])]
  );

  await query(
    `INSERT INTO feed_items (type, title, summary, priority, related_theory_ids)
     VALUES ('theory_update', $1, $2, 'HIGH', $3)`,
    [`New theory: ${theory.title}`, data.summary, [theory.id]]
  );
  broadcast("theory_created", { theory, cost });
  return theory;
}

export async function expandNode(
  nodeId: string,
  question?: string,
  exploredBy: "user" | "erebus" = "user"
): Promise<TheoryNode | null> {
  const node = await queryOne<TheoryNode & { theory_title: string; theory_summary: string }>(
    `SELECT tn.*, t.title AS theory_title, t.summary AS theory_summary
       FROM theory_nodes tn JOIN theories t ON t.id = tn.theory_id
      WHERE tn.id = $1`,
    [nodeId]
  );
  if (!node) return null;

  const budget = await checkExpandBudget(node.theory_id, node.depth);
  if (!budget.ok) {
    broadcast("expand_blocked", { nodeId, reason: budget.reason });
    return null;
  }

  const q = question || (Array.isArray(node.questions) ? node.questions[0] : undefined);
  if (!q) return null;

  const fallback: NodeExpansion = {
    content: `[offline] Pending analysis of: ${q}`,
    questions: [
      "What evidence would strengthen or weaken this?",
      "Which actors are most affected?",
      "What is the timeline?",
      "What changes everything here?",
    ],
    wildcard: "What are we not seeing?",
    keyInsight: "Further analysis required.",
    shadowFlag: false,
    financialSignal: false,
  };
  const { data, cost } = await callClaudeJSON<NodeExpansion>(
    expandNodePrompt({
      theoryTitle: node.theory_title,
      theorySummary: node.theory_summary,
      question: q,
      parentContent: node.content,
      depth: node.depth + 1,
    }),
    fallback,
    { tier: "deep", agent: "expand-node", maxTokens: 2500 }
  );

  const child = await queryOne<TheoryNode>(
    `INSERT INTO theory_nodes (theory_id, parent_id, hypothesis, content, questions, wildcard, key_insight, depth, explored_by, shadow_tagged, financial_signal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      node.theory_id,
      node.id,
      q,
      data.content,
      JSON.stringify(data.questions ?? []),
      data.wildcard ?? null,
      data.keyInsight ?? null,
      node.depth + 1,
      exploredBy,
      data.shadowFlag ?? false,
      data.financialSignal ?? false,
    ]
  );
  broadcast("node_expanded", { nodeId: child?.id, theoryId: node.theory_id, cost });
  return child;
}

// Fetch full tree (flat list; client nests by parent_id).
export async function getTree(theoryId: string): Promise<TheoryNode[]> {
  return query<TheoryNode>(
    "SELECT * FROM theory_nodes WHERE theory_id = $1 ORDER BY depth, created_at",
    [theoryId]
  );
}
