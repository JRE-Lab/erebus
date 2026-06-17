import { Hono } from "hono";
import { query } from "@erebus/db";
import { LENSES } from "@erebus/core";
import { runShadowBoard } from "../shadowboard/board.js";

const r = new Hono();

r.get("/lenses", (c) => c.json({ data: LENSES }));

r.get("/:theoryId", async (c) => {
  const data = await query(
    "SELECT * FROM lens_verdicts WHERE theory_id = $1 AND node_id IS NULL ORDER BY created_at DESC LIMIT 7",
    [c.req.param("theoryId")]
  );
  return c.json({ data });
});

r.post("/:theoryId/run", async (c) => {
  const result = await runShadowBoard(c.req.param("theoryId"));
  if (!result) return c.json({ error: "Theory not found" }, 404);
  return c.json({ data: result });
});

export default r;
