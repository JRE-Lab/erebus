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
const MAX_CHILDREN = Number(process.env.MAX_CHILDREN || 12); // per-node fan-out cap

function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

// LLM-supplied horizon strings are untrusted: an unparseable date must become
// null, not an Invalid Date that throws during insert AFTER the tokens are paid.
function safeDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Mark a node permanently un-expandable (max depth / max children) so the
// selectors stop re-picking it — the deep review's roam-deadlock fix.
async function markExpandBlocked(nodeId: string): Promise<void> {
  try {
    await db.update(nodes).set({ expandBlocked: true, updatedAt: new Date() }).where(eq(nodes.id, nodeId));
  } catch {
    /* best-effort */
  }
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
  opts: { id?: string; origin?: "user" | "erebus" | "shadow"; eventAfter?: Record<string, unknown> } = {}
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
      horizon: safeDate(data.horizon),
      domains: data.domains ?? [],
      confidence: data.confidence ?? 0.5,
      origin: opts.origin ?? "user",
      embedding: emb,
    })
    .returning();
  await recordEvent({
    nodeId: id,
    kind: "created",
    causeType: "job",
    after: opts.eventAfter,
    promptVersion: PROMPT_VERSION,
  });
  return { node: node!, cost, offline };
}

export async function expandForward(
  nodeId: string,
  origin: "user" | "erebus" = "user"
): Promise<{ children: NodeRow[]; cost: number; blocked?: string }> {
  const depth = await depthOf(nodeId);
  if (depth + 1 > MAX_DEPTH) {
    await markExpandBlocked(nodeId); // selectors must never pick this node again
    return { children: [], cost: 0, blocked: `max depth ${MAX_DEPTH}` };
  }

  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { children: [], cost: 0, blocked: "node not found" };

  // Per-node fan-out cap: without it a sticky selector can pile unbounded
  // children onto one node (deep-review finding).
  const preExisting = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
  if (preExisting.length >= MAX_CHILDREN) {
    await markExpandBlocked(nodeId);
    return { children: [], cost: 0, blocked: `max children ${MAX_CHILDREN}` };
  }

  const fallback = { children: [] as ForecastShape[] };
  const { data, cost, offline, parsed } = await callJSON<{ children: ForecastShape[] }>(
    expandForwardPrompt({ question: node.question, outcome: node.outcome, depth }),
    fallback,
    { tier: "opus", agent: "expand-forward", targetNode: nodeId, maxTokens: 3000 }
  );
  // Offline/paused/budget/parse-fallback: report blocked so roam loops back off
  // instead of counting an empty expansion as "productive". No rotation stamp —
  // the node stays at the front of the queue for a real retry.
  if (offline) return { children: [], cost, blocked: "llm unavailable" };
  if (!parsed) return { children: [], cost, blocked: "llm parse failure" };

  // Re-query children AFTER the (multi-second) LLM call: a concurrent expand or
  // pursue on the same node during the call would otherwise collide on the
  // count-derived child id and its paid child would be silently dropped.
  const existing = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
  let n = existing.length;
  const inserted: NodeRow[] = [];
  let embedFailure: string | undefined;

  // Cap the batch so the fan-out limit can't be overshot by batch-size-1.
  const room = Math.max(0, MAX_CHILDREN - n);
  for (const child of (data.children ?? []).slice(0, room)) {
    if (!child.question || !child.outcome) continue;
    n++;
    const childId = `${nodeId}.${n}`;
    try {
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
          horizon: safeDate(child.horizon),
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
    } catch (e) {
      // An embeddings-provider outage must not discard the whole paid batch or
      // spin the selector (review: paid-then-throw burn loop). Keep what we
      // inserted, stop, and report — the stamp below still rotates the node.
      embedFailure = (e as Error).message.slice(0, 80);
      break;
    }
  }
  // Rotation stamp: selectors order by last_expanded_at so an expanded node
  // yields to the rest of the frontier instead of being re-picked immediately.
  try {
    await db.update(nodes).set({ lastExpandedAt: new Date() }).where(eq(nodes.id, nodeId));
  } catch {
    /* best-effort */
  }
  return embedFailure
    ? { children: inserted, cost, blocked: `embeddings unavailable: ${embedFailure}` }
    : { children: inserted, cost };
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
      horizon: safeDate(data.horizon),
      domains: data.domains ?? [],
      synthesizedFrom: nodeIds,
      embedding: emb,
    })
    .returning();
  await recordEvent({ nodeId: id, kind: "synthesized", causeType: "job", after: { synthesizedFrom: nodeIds } });
  return { node: node!, cost };
}

export interface Direction {
  label: string;
  angle: "consequence" | "actor" | "failure" | "wildcard" | string;
  text: string;
}

// Suggest exactly four tailored directions to pursue from a node (on-demand).
export async function suggestDirections(nodeId: string): Promise<{ directions: Direction[]; cost: number }> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { directions: [], cost: 0 };
  const { data, cost } = await callJSON<{ directions: Direction[] }>(
    suggestDirectionsPrompt({
      question: node.question,
      outcome: node.outcome,
      rationale: node.rationale,
      domains: node.domains,
    }),
    { directions: [] },
    { tier: "sonnet", agent: "suggest-directions", targetNode: nodeId, maxTokens: 900 }
  );
  return { directions: (data.directions ?? []).slice(0, 4), cost };
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
  const { data, cost, offline } = await callJSON<typeof fallback>(
    pursuePrompt({ question: parent.question, outcome: parent.outcome }, direction),
    fallback,
    { tier: "opus", agent: "pursue", targetNode: nodeId, maxTokens: 2500 }
  );
  // Never persist a fallback stub as a real branch (deep-review finding: paused/
  // offline pursues were inserting "[offline] forecast pending" children).
  if (offline || !data.outcome || data.outcome.startsWith("[offline]")) {
    return { node: null, analysis: "", cost, blocked: "llm unavailable" };
  }

  const existing = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.parentId, nodeId));
  // Same fan-out cap as expandForward — user/shadow-driven pursues must not
  // grow a node arbitrarily past the limit either.
  if (existing.length >= MAX_CHILDREN) {
    await markExpandBlocked(nodeId);
    return { node: null, analysis: data.analysis ?? "", cost, blocked: `max children ${MAX_CHILDREN}` };
  }
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
      horizon: safeDate(data.horizon),
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
