import { Hono } from "hono";
import { query, queryOne } from "@erebus/db";
import { createTheory, expandNode, getTree } from "../engine/theoryTree.js";
import { rescoreTheory } from "../engine/scoring.js";

const r = new Hono();

// List theories (optional ?status= & ?limit=)
r.get("/", async (c) => {
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 200);
  const rows = status
    ? await query("SELECT * FROM theories WHERE status = $1 ORDER BY updated_at DESC LIMIT $2", [status, limit])
    : await query("SELECT * FROM theories ORDER BY updated_at DESC LIMIT $1", [limit]);
  return c.json({ data: rows, total: rows.length });
});

// Constellation graph
r.get("/graph", async (c) => {
  const nodes = await query(
    "SELECT id, title, summary, confidence, score, status, domains, is_shadow FROM theories WHERE status <> 'ARCHIVED'"
  );
  const edges = await query(
    "SELECT a_id AS source, b_id AS target, relationship AS type, strength FROM theory_connections"
  );
  return c.json({ nodes, edges });
});

// Single theory with related data
r.get("/:id", async (c) => {
  const id = c.req.param("id");
  const theory = await queryOne("SELECT * FROM theories WHERE id = $1", [id]);
  if (!theory) return c.json({ error: "Not found" }, 404);
  const [connections, predictions, history] = await Promise.all([
    query(
      `SELECT tc.*, t.title AS connected_title FROM theory_connections tc
         JOIN theories t ON t.id = tc.b_id WHERE tc.a_id = $1
       UNION ALL
       SELECT tc.*, t.title AS connected_title FROM theory_connections tc
         JOIN theories t ON t.id = tc.a_id WHERE tc.b_id = $1`,
      [id]
    ),
    query("SELECT * FROM predictions WHERE theory_id = $1 ORDER BY created_at DESC", [id]),
    query("SELECT * FROM confidence_history WHERE theory_id = $1 ORDER BY created_at DESC LIMIT 50", [id]),
  ]);
  return c.json({ data: { ...theory, connections, predictions, confidenceHistory: history } });
});

// Tree for a theory
r.get("/:id/tree", async (c) => {
  const data = await getTree(c.req.param("id"));
  return c.json({ data });
});

// Create theory
r.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.context && !body.title) return c.json({ error: "title or context required" }, 400);
  const theory = await createTheory({
    title: body.title,
    context: body.context || body.title,
    slug: body.slug,
    isShadow: body.isShadow,
  });
  return c.json({ data: theory }, 201);
});

// Expand a tree node
r.post("/node/:nodeId/expand", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const child = await expandNode(c.req.param("nodeId"), body.question);
  if (!child) return c.json({ error: "Expansion blocked (budget) or node not found" }, 409);
  return c.json({ data: child });
});

// Rescore
r.post("/:id/rescore", async (c) => {
  const res = await rescoreTheory(c.req.param("id"), "manual rescore");
  return c.json({ data: res });
});

// Update + delete
r.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const allowed = ["title", "summary", "full_analysis", "confidence", "status", "change_everything"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = $${i++}`);
      vals.push(body[k]);
    }
  }
  if (!sets.length) return c.json({ error: "no fields" }, 400);
  vals.push(id);
  const updated = await queryOne(
    `UPDATE theories SET ${sets.join(", ")}, updated_at = now() WHERE id = $${i} RETURNING *`,
    vals
  );
  return c.json({ data: updated });
});

r.delete("/:id", async (c) => {
  await query("DELETE FROM theories WHERE id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

export default r;
