import { Hono } from "hono";
import { embed, similaritySearch, query } from "@erebus/db";

const r = new Hono();

// Semantic search across events + theories via pgvector.
r.get("/", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const emb = await embed(q);

  const [eventHits, theoryHits] = await Promise.all([
    similaritySearch("events", emb, 8),
    similaritySearch("theories", emb, 8),
  ]);

  const eventIds = eventHits.map((h) => h.id);
  const theoryIds = theoryHits.map((h) => h.id);

  const events = eventIds.length
    ? await query("SELECT id, title, url, observed_at FROM events WHERE id = ANY($1)", [eventIds])
    : [];
  const theories = theoryIds.length
    ? await query("SELECT id, title, summary, confidence FROM theories WHERE id = ANY($1)", [theoryIds])
    : [];

  return c.json({ data: { events, theories } });
});

export default r;
