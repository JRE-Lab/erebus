import { Hono } from "hono";
import { query } from "@erebus/db";

const r = new Hono();

r.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 200);
  const data = await query("SELECT * FROM feed_items ORDER BY created_at DESC LIMIT $1", [limit]);
  return c.json({ data });
});

r.post("/:id/read", async (c) => {
  await query("UPDATE feed_items SET read = true WHERE id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

export default r;
