// ============================================================================
// EREBUS API — Hono app mounted inside Next (App Router catch-all).
// basePath('/api'); GET/POST handlers exported via hono/vercel. Every route
// calls the LOCKED contracts from @erebus/{core,db,agents,ingest,shadowboard,
// content}. Handlers are wrapped in try/catch -> 500 JSON. Everything is
// offline-safe: callJSON returns fallbacks, so no route crashes without an
// LLM key.
// ============================================================================
import { Hono } from "hono";
import { handle } from "hono/vercel";
import type { Context } from "hono";

import {
  createForecast,
  expandForward,
  synthesizeBranches,
  suggestDirections,
  pursueDirection,
  roamOnce,
  listNodes,
  getSubtree,
} from "@erebus/core";
import {
  db,
  pool,
  signals,
  signalMatches,
  debates,
  shadowReads,
  events,
  relationships,
  contentItems,
  worldviewSnapshots,
  nodes,
  embed,
  nearest,
  getSetting,
  setSetting,
  isPaused,
  setPaused,
} from "@erebus/db";
import { llmLive, runDebate } from "@erebus/agents";
import { ingestAll, matchNode, rematchRecent } from "@erebus/ingest";
import { runShadowRead } from "@erebus/shadowboard";
import { nodeToContent } from "@erebus/content";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- helpers ----------------------------------------------------------------

// Uniform 500 wrapper. Each handler body is an async thunk; any throw becomes a
// JSON 500 with the message (never a raw stack to the client).
async function guard(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
}

// --- app --------------------------------------------------------------------

const app = new Hono().basePath("/api");

// GET /api/health -> liveness + LLM status + global pause state.
app.get("/health", (c) =>
  guard(c, async () => c.json({ status: "ok", llm: llmLive() ? "live" : "offline", paused: await isPaused() }))
);

// GET /api/paused -> global kill-switch state.
app.get("/paused", (c) => guard(c, async () => c.json({ paused: await isPaused() })));

// PUT /api/paused { paused } -> stop/resume ALL spend (LLM + embeddings + worker).
app.put("/paused", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const paused = Boolean(body?.paused);
    await setPaused(paused);
    return c.json({ paused });
  })
);

// GET /api/nodes -> all nodes (flat).
app.get("/nodes", (c) => guard(c, async () => c.json(await listNodes())));

// GET /api/nodes/:id -> node + full provenance bundle.
app.get("/nodes/:id", (c) =>
  guard(c, async () => {
    const id = c.req.param("id");
    const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return c.json({ error: "not found" }, 404);

    const [matches, nodeDebates, reads, prov, fromRels, toRels] = await Promise.all([
      // signal_matches joined to their signals for display context.
      db
        .select({
          id: signalMatches.id,
          signalId: signalMatches.signalId,
          nodeId: signalMatches.nodeId,
          effect: signalMatches.effect,
          weight: signalMatches.weight,
          rationale: signalMatches.rationale,
          createdAt: signalMatches.createdAt,
          signal: {
            id: signals.id,
            source: signals.source,
            url: signals.url,
            title: signals.title,
            summary: signals.summary,
            publishedAt: signals.publishedAt,
          },
        })
        .from(signalMatches)
        .leftJoin(signals, eq(signalMatches.signalId, signals.id))
        .where(eq(signalMatches.nodeId, id))
        .orderBy(desc(signalMatches.createdAt)),
      db.select().from(debates).where(eq(debates.nodeId, id)).orderBy(desc(debates.createdAt)),
      db.select().from(shadowReads).where(eq(shadowReads.nodeId, id)).orderBy(desc(shadowReads.createdAt)),
      db.select().from(events).where(eq(events.nodeId, id)).orderBy(desc(events.createdAt)),
      db.select().from(relationships).where(eq(relationships.fromNode, id)),
      db.select().from(relationships).where(eq(relationships.toNode, id)),
    ]);

    return c.json({
      node,
      signal_matches: matches,
      debates: nodeDebates,
      shadow_reads: reads,
      events: prov,
      relationships: { from: fromRels, to: toRels },
    });
  })
);

// GET /api/tree?root= -> subtree (flat) for a root, or all nodes if no root.
app.get("/tree", (c) =>
  guard(c, async () => {
    const root = c.req.query("root");
    const rows = root ? await getSubtree(root) : await listNodes();
    return c.json(rows);
  })
);

// POST /api/nodes { context } -> create a root/standalone forecast.
app.post("/nodes", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const context = typeof body?.context === "string" ? body.context : "";
    if (!context.trim()) return c.json({ error: "context required" }, 400);
    const r = await createForecast(context);
    if (r.node?.id) { try { await matchNode(r.node.id); } catch { /* greening best-effort */ } }
    return c.json(r);
  })
);

// POST /api/nodes/:id/expand -> forward-expand (the recursion).
app.post("/nodes/:id/expand", (c) =>
  guard(c, async () => c.json(await expandForward(c.req.param("id"))))
);

// GET /api/nodes/:id/directions -> suggested directions to pursue from here.
app.get("/nodes/:id/directions", (c) =>
  guard(c, async () => c.json(await suggestDirections(c.req.param("id"))))
);

// POST /api/nodes/:id/pursue { direction } -> game-theoretic analysis of the
// operator's direction/response -> a new child forecast. Interactive recursion.
app.post("/nodes/:id/pursue", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const direction = typeof body?.direction === "string" ? body.direction.trim() : "";
    if (!direction) return c.json({ error: "direction required" }, 400);
    const r = await pursueDirection(c.req.param("id"), direction);
    if (r.node?.id) { try { await matchNode(r.node.id); } catch { /* greening best-effort */ } }
    return c.json(r);
  })
);

// POST /api/rematch?limit= -> re-judge recent signals against current nodes.
app.post("/rematch", (c) =>
  guard(c, async () => c.json(await rematchRecent(Number(c.req.query("limit")) || 60)))
);

// POST /api/roam -> one autonomous step now (EREBUS picks a node + branches it).
app.post("/roam", (c) => guard(c, async () => c.json(await roamOnce())));

// GET /api/autonomous -> roam toggle + counts.
app.get("/autonomous", (c) =>
  guard(c, async () => {
    const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
    const [counts] = (
      await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE origin='erebus')::int AS erebus_nodes,
           COUNT(*) FILTER (WHERE is_launch_point)::int AS launch_points,
           COUNT(*) FILTER (WHERE state IN ('corroborated','resolved_true'))::int AS greens
         FROM nodes`
      )
    ).rows;
    return c.json({ enabled: a.enabled, ...counts });
  })
);

// PUT /api/autonomous { enabled } -> pause/resume EREBUS roaming.
app.put("/autonomous", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const enabled = Boolean(body?.enabled);
    await setSetting("autonomous", { enabled });
    return c.json({ enabled });
  })
);

// POST /api/nodes/:id/debate { rounds? } -> N-round cross-examination.
app.post("/nodes/:id/debate", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const rounds = Number.isFinite(Number(body?.rounds)) ? Number(body.rounds) : 1;
    const result = await runDebate(c.req.param("id"), rounds);
    if (!result) return c.json({ error: "node not found" }, 404);
    return c.json(result);
  })
);

// POST /api/nodes/:id/shadow -> Shadow Board deception pass.
app.post("/nodes/:id/shadow", (c) =>
  guard(c, async () => c.json(await runShadowRead(c.req.param("id"))))
);

// POST /api/synthesize { ids } -> combine N branches into a new node.
app.post("/synthesize", (c) =>
  guard(c, async () => {
    const body = await c.req.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === "string") : [];
    if (ids.length < 2) return c.json({ error: "need >= 2 node ids" }, 400);
    return c.json(await synthesizeBranches(ids));
  })
);

// GET /api/signals -> most recent ingested signals.
app.get("/signals", (c) =>
  guard(c, async () => {
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const rows = await db.select().from(signals).orderBy(desc(signals.ingestedAt)).limit(limit);
    return c.json(rows);
  })
);

// POST /api/ingest -> pull configured feeds + match (the green cycle).
app.post("/ingest", (c) => guard(c, async () => c.json(await ingestAll())));

// GET /api/search?q= -> semantic neighbours across nodes + signals, joined to rows.
app.get("/search", (c) =>
  guard(c, async () => {
    const q = c.req.query("q") || "";
    if (!q.trim()) return c.json({ query: q, nodes: [], signals: [] });

    const emb = await embed(q);
    const [nodeHits, signalHits] = await Promise.all([
      nearest("nodes", emb, 10),
      nearest("signals", emb, 10),
    ]);

    const nodeIds = nodeHits.map((h) => h.id);
    const signalIds = signalHits.map((h) => h.id);

    const [nodeRows, signalRows] = await Promise.all([
      nodeIds.length ? db.select().from(nodes).where(inArray(nodes.id, nodeIds)) : Promise.resolve([]),
      signalIds.length ? db.select().from(signals).where(inArray(signals.id, signalIds)) : Promise.resolve([]),
    ]);

    const nodeById = new Map(nodeRows.map((r) => [r.id, r]));
    const signalById = new Map(signalRows.map((r) => [r.id, r]));

    return c.json({
      query: q,
      nodes: nodeHits
        .map((h) => ({ distance: h.distance, node: nodeById.get(h.id) ?? null }))
        .filter((h) => h.node),
      signals: signalHits
        .map((h) => ({ distance: h.distance, signal: signalById.get(h.id) ?? null }))
        .filter((h) => h.signal),
    });
  })
);

// GET /api/worldview -> latest worldview snapshot (or null).
app.get("/worldview", (c) =>
  guard(c, async () => {
    const [snap] = await db
      .select()
      .from(worldviewSnapshots)
      .orderBy(desc(worldviewSnapshots.generatedAt))
      .limit(1);
    return c.json(snap ?? null);
  })
);

// GET /api/cost -> exploration_jobs spend rolled up for today + this month.
app.get("/cost", (c) =>
  guard(c, async () => {
    const res = await pool.query(
      `SELECT
         COALESCE(SUM(cost_usd) FILTER (WHERE finished_at >= date_trunc('day', now())), 0)   AS today,
         COALESCE(SUM(cost_usd) FILTER (WHERE finished_at >= date_trunc('month', now())), 0) AS month,
         COALESCE(SUM(cost_usd), 0)                                                           AS all_time,
         COUNT(*)                                                                             AS jobs
       FROM exploration_jobs`
    );
    const row = res.rows[0] ?? {};
    return c.json({
      today: Number(row.today ?? 0),
      month: Number(row.month ?? 0),
      allTime: Number(row.all_time ?? 0),
      jobs: Number(row.jobs ?? 0),
    });
  })
);

// POST /api/content/:id -> drive a node through the content pipeline.
app.post("/content/:id", (c) =>
  guard(c, async () => c.json(await nodeToContent(c.req.param("id"))))
);

// GET /api/content -> all content items (newest first).
app.get("/content", (c) =>
  guard(c, async () => {
    const rows = await db.select().from(contentItems).orderBy(desc(contentItems.createdAt));
    return c.json(rows);
  })
);

// GET /api/changed?since= -> light digest: new nodes + freshly greened since a
// timestamp. Optional convenience for the polling stub in lib/ws.ts.
app.get("/changed", (c) =>
  guard(c, async () => {
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 60_000);
    const ts = Number.isNaN(since.getTime()) ? new Date(Date.now() - 60_000) : since;

    const [created, greened, newSignals] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(nodes).where(gte(nodes.createdAt, ts)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(events)
        .where(
          and(
            eq(events.kind, "state_change"),
            gte(events.createdAt, ts),
            sql`(${events.after} ->> 'state') IN ('corroborating','corroborated')`
          )
        ),
      db.select({ n: sql<number>`count(*)::int` }).from(signals).where(gte(signals.ingestedAt, ts)),
    ]);

    return c.json({
      since: ts.toISOString(),
      newNodes: created[0]?.n ?? 0,
      greened: greened[0]?.n ?? 0,
      newSignals: newSignals[0]?.n ?? 0,
    });
  })
);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
