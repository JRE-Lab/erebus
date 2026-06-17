import { Hono } from "hono";
import { query, queryOne } from "@erebus/db";

const r = new Hono();

r.get("/", async (c) => {
  const rows = await query<{ key: string; value: unknown }>("SELECT key, value FROM settings");
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  return c.json({ data: out });
});

r.put("/:key", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const row = await queryOne(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING *`,
    [c.req.param("key"), JSON.stringify(body.value ?? body)]
  );
  return c.json({ data: row });
});

// Cost summary (today + month)
r.get("/cost", async (c) => {
  const [today] = await query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_usd),0)::text AS total FROM cost_entries WHERE created_at >= date_trunc('day', now())"
  );
  const [month] = await query<{ total: string }>(
    "SELECT COALESCE(SUM(cost_usd),0)::text AS total FROM cost_entries WHERE created_at >= date_trunc('month', now())"
  );
  const byAgent = await query(
    `SELECT agent, COALESCE(SUM(cost_usd),0)::float AS cost, COUNT(*)::int AS calls
       FROM cost_entries WHERE created_at >= date_trunc('month', now())
      GROUP BY agent ORDER BY cost DESC`
  );
  return c.json({
    data: {
      today: Number(today?.total ?? 0),
      month: Number(month?.total ?? 0),
      budget: Number(process.env.DAILY_LLM_BUDGET_USD ?? 10),
      byAgent,
    },
  });
});

export default r;
