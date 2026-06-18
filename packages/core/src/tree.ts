// Forecast Tree operations: create, forward-expand (the recursion), synthesize.
import { eq, sql, inArray } from "drizzle-orm";
import { db, pool, nodes, embed, toVector, recordEvent } from "@erebus/db";
import {
  callJSON,
  generateForecastPrompt,
  expandForwardPrompt,
  synthesizeBranchesPrompt,
  suggestDirectionsPrompt,
  pursuePrompt,
  PROMPT_VERSION,
} from "@erebus/agents";
import type { NodeRow, TreeNode } from "./types.js";

const MAX_DEPTH = Number(process.env.MAX_DEPTH || 8);

function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

async function depthOf(nodeId: string): Promise<number> {
  const res = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 0 AS d FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, up.d + 1 FROM nodes n JOIN up ON n.id = up.parent_id
     ) SELECT COALESCE(MAX(d), 0) AS d FROM up`,
    [nodeId]
  );
  return Number(res.rows[0]?.d ?? 0);
}

async function embedExpr(text: string) {
  const v = await embed(text);
  return sql.raw(`'${toVector(v)}'::vector`);
}

interface ForecastShape {
  question: string;
  outcome: string;
  rationale?: string;
  indicators?: string[];
  falsifiers?: string[];
  horizon?: string | null;
  domains?: string[];
  confidence?: number;
}

export async function createForecast(
  context: string,
  opts: { id?: string } = {}
): Promise<{ node: NodeRow; cost: number; offline: boolean }> {
  const fallback: ForecastShape = {
    question: context.slice(0, 200),
    outcome: `[offline] forecast pending: ${context.slice(0, 160)}`,
    indicators: [],
    falsifiers: [],
    domains: [],
    confidence: 0.5,
  };
  const { data, cost, offline } = await callJSON<ForecastShape>(generateForecastPrompt(context), fallback, {
    tier: "opus",
    agent: "generate-forecast",
    maxTokens: 2000,
  });

  const id = opts.id ?? shortId("N");
  const emb = await embedExpr(`${data.question}\n${data.outcome}`);
  const [node] = await db
    .insert(nodes)
    .values({
      id,
      question: data.question,
      outcome: data.outcome,
      rationale: data.rationale ?? null,
      indicators: data.indicators ?? [],
      falsifiers: data.falsifiers ?? [],
      horizon: data.horizon ? new Date(data.horizon) : null,
      domains: data.domains ?? [],
      confidence: data.confidence ?? 0.5,
      embedding: emb,
    })
    .returning();
  await recordEvent({ nodeId: id, kind: "created", causeType: "job", promptVersion: PROMPT_VERSION });
  return { node: node!, cost, offline };
}

export async function expandForward(
  nodeId: string,
  origin: "user" | "erebus" = "user"
): Promise<{ children: NodeRow[]; cost: number; blocked?: string }> {
  const depth = await depthOf(nodeId);
  if (depth + 1 > MAX_DEPTH) return { children: [], cost: 0, blocked: `max depth ${MAX_DEPTH}` };

  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { children: [], cost: 0, blocked: "node not found" };

  const fallback = { children: [] as ForecastShape[] };
  const { data, cost } = await callJSON<{ children: ForecastShape[] }>(
    expandForwardPrompt({ question: node.question, outcome: node.outcome, depth }),
    fallback,
    { tier: "opus", agent: "expand-forward", targetNode: nodeId, maxTokens: 3000 }
  );

  const existing = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
  let n = existing.length;
  const inserted: NodeRow[] = [];

  for (const child of data.children ?? []) {
    if (!child.question || !child.outcome) continue;
    n++;
    const childId = `${nodeId}.${n}`;
    const emb = await embedExpr(`${child.question}\n${child.outcome}`);
    const [row] = await db
      .insert(nodes)
      .values({
        id: childId,
        question: child.question,
        outcome: child.outcome,
        rationale: child.rationale ?? null,
        indicators: child.indicators ?? [],
        falsifiers: child.falsifiers ?? [],
        horizon: child.horizon ? new Date(child.horizon) : null,
        domains: child.domains ?? node.domains ?? [],
        parentId: nodeId,
        branchLabel: String.fromCharCode(64 + n),
        origin,
        embedding: emb,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      inserted.push(row);
      await recordEvent({ nodeId: childId, kind: "created", causeType: "job", promptVersion: PROMPT_VERSION });
    }
  }
  return { children: inserted, cost };
}

export async function synthesizeBranches(
  nodeIds: string[]
): Promise<{ node: NodeRow | null; cost: number }> {
  const rows = await db.select().from(nodes).where(inArray(nodes.id, nodeIds));
  if (rows.length < 2) return { node: null, cost: 0 };

  const { data, cost } = await callJSON<ForecastShape>(
    synthesizeBranchesPrompt(rows.map((r) => ({ question: r.question, outcome: r.outcome }))),
    { question: "", outcome: "", indicators: [], falsifiers: [], domains: [] },
    { tier: "opus", agent: "synthesize", maxTokens: 2000 }
  );
  if (!data.question || !data.outcome) return { node: null, cost };

  const id = shortId("S");
  const emb = await embedExpr(`${data.question}\n${data.outcome}`);
  const [node] = await db
    .insert(nodes)
    .values({
      id,
      question: data.question,
      outcome: data.outcome,
      rationale: data.rationale ?? null,
      indicators: data.indicators ?? [],
      falsifiers: data.falsifiers ?? [],
      horizon: data.horizon ? new Date(data.horizon) : null,
      domains: data.domains ?? [],
      synthesizedFrom: nodeIds,
      embedding: emb,
    })
    .returning();
  await recordEvent({ nodeId: id, kind: "synthesized", causeType: "job", after: { synthesizedFrom: nodeIds } });
  return { node: node!, cost };
}

// Suggest directions to pursue from a node (on-demand, not stored).
export async function suggestDirections(nodeId: string): Promise<{ directions: string[]; cost: number }> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { directions: [], cost: 0 };
  const { data, cost } = await callJSON<{ directions: string[] }>(
    suggestDirectionsPrompt({ question: node.question, outcome: node.outcome }),
    { directions: [] },
    { tier: "sonnet", agent: "suggest-directions", targetNode: nodeId, maxTokens: 800 }
  );
  return { directions: data.directions ?? [], cost };
}

// Pursue a direction or the operator's own response: game-theoretic analysis ->
// a new child forecast. This is the interactive recursion driver.
export async function pursueDirection(
  nodeId: string,
  direction: string
): Promise<{ node: NodeRow | null; analysis: string; cost: number; blocked?: string }> {
  const depth = await depthOf(nodeId);
  if (depth + 1 > MAX_DEPTH) return { node: null, analysis: "", cost: 0, blocked: `max depth ${MAX_DEPTH}` };
  const [parent] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!parent) return { node: null, analysis: "", cost: 0, blocked: "node not found" };

  const fallback = {
    analysis: `[offline] Could not analyze: ${direction}`,
    question: direction.slice(0, 200),
    outcome: "[offline] forecast pending",
    rationale: "",
    indicators: [] as string[],
    falsifiers: [] as string[],
    horizon: null as string | null,
    domains: [] as string[],
  };
  const { data, cost } = await callJSON<typeof fallback>(
    pursuePrompt({ question: parent.question, outcome: parent.outcome }, direction),
    fallback,
    { tier: "opus", agent: "pursue", targetNode: nodeId, maxTokens: 2500 }
  );

  const existing = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
  const n = existing.length + 1;
  const childId = `${nodeId}.${n}`;
  const emb = await embedExpr(`${data.question}\n${data.outcome}`);
  const [node] = await db
    .insert(nodes)
    .values({
      id: childId,
      question: data.question || direction.slice(0, 200),
      outcome: data.outcome || "",
      rationale: data.rationale ?? null,
      indicators: data.indicators ?? [],
      falsifiers: data.falsifiers ?? [],
      horizon: data.horizon ? new Date(data.horizon) : null,
      domains: data.domains ?? parent.domains ?? [],
      parentId: nodeId,
      branchLabel: String.fromCharCode(64 + n),
      origin: "user",
      embedding: emb,
    })
    .onConflictDoNothing()
    .returning();
  if (node) {
    await recordEvent({
      nodeId: childId,
      kind: "created",
      causeType: "job",
      after: { pursued: direction, analysis: data.analysis },
      promptVersion: PROMPT_VERSION,
    });
  }
  return { node: node ?? null, analysis: data.analysis ?? "", cost };
}

export async function listNodes(): Promise<NodeRow[]> {
  return db.select().from(nodes);
}

export async function getSubtree(rootId: string): Promise<NodeRow[]> {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT * FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.* FROM nodes n JOIN sub ON n.parent_id = sub.id
     ) SELECT * FROM sub`,
    [rootId]
  );
  return res.rows as NodeRow[];
}

// Nest a flat node list into a tree by parent_id.
export function buildTree(flat: NodeRow[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  flat.forEach((n) => map.set(n.id, { ...n, children: [] }));
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    if (n.parentId && map.has(n.parentId)) map.get(n.parentId)!.children.push(n);
    else roots.push(n);
  }
  return roots;
}
