import { Hono } from "hono";
import { query, queryOne } from "@erebus/db";
import { pollAllSources } from "../ingestion/index.js";

const r = new Hono();

r.get("/sources", async (c) => {
  const data = await query("SELECT * FROM sources ORDER BY tier, name");
  return c.json({ data });
});

r.post("/sources", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || !body.url) return c.json({ error: "name and url required" }, 400);
  const row = await queryOne(
    `INSERT INTO sources (name, url, tier, type, enabled) VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (url) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [body.name, body.url, body.tier ?? 2, body.type ?? "rss"]
  );
  return c.json({ data: row }, 201);
});

r.patch("/sources/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const row = await queryOne("UPDATE sources SET enabled = $1 WHERE id = $2 RETURNING *", [
    Boolean(body.enabled),
    c.req.param("id"),
  ]);
  return c.json({ data: row });
});

// Trigger an ingestion poll now
r.post("/poll", async (c) => {
  const summary = await pollAllSources();
  return c.json({ data: summary });
});

export default r;
