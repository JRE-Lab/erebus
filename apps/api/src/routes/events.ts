import { Hono } from "hono";
import { createHash } from "node:crypto";
import { query, embed, toVectorLiteral } from "@erebus/db";

const r = new Hono();

r.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const data = await query("SELECT * FROM events ORDER BY observed_at DESC LIMIT $1", [limit]);
  return c.json({ data });
});

// Manual event ingestion
r.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.title) return c.json({ error: "title required" }, 400);
  const hash = createHash("sha256").update(`${body.title}|${body.url ?? ""}`).digest("hex");
  const emb = await embed(`${body.title}\n${body.body ?? ""}`);
  const row = await query(
    `INSERT INTO events (source, source_type, url, title, body, dedup_hash, embedding)
     VALUES ($1,'manual',$2,$3,$4,$5,$6::vector)
     ON CONFLICT (dedup_hash) DO NOTHING RETURNING *`,
    [body.source ?? "manual", body.url ?? null, body.title, body.body ?? null, hash, toVectorLiteral(emb)]
  );
  return c.json({ data: row[0] ?? null }, 201);
});

export default r;
