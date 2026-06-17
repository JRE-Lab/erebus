import { Hono } from "hono";
import { query, queryOne } from "@erebus/db";
import { checkNodeEvidence, checkAllEvidence } from "../evidence/checker.js";

const r = new Hono();

// AI evidence check for one node
r.post("/node/:nodeId/check", async (c) => {
  const res = await checkNodeEvidence(c.req.param("nodeId"));
  if (!res) return c.json({ error: "Node not found" }, 404);
  return c.json({ data: res });
});

// AI evidence check for every node in a theory
r.post("/:theoryId/check-all", async (c) => {
  const res = await checkAllEvidence(c.req.param("theoryId"));
  return c.json({ data: res });
});

// Manual evidence mark (no LLM)
r.post("/node/:nodeId/mark", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const valid = ["confirmed", "partial", "disconfirmed", "pending"];
  if (!valid.includes(body.status)) return c.json({ error: "invalid status" }, 400);
  const evidence = {
    summary: body.summary ?? "Manually marked",
    supporting: body.supporting ?? [],
    contradicting: body.contradicting ?? [],
    manual: true,
    checked_at: new Date().toISOString(),
  };
  const updated = await queryOne(
    "UPDATE theory_nodes SET evidence_status = $1, evidence = $2, evidence_checked_at = now() WHERE id = $3 RETURNING id, evidence_status",
    [body.status, JSON.stringify(evidence), c.req.param("nodeId")]
  );
  if (!updated) return c.json({ error: "Node not found" }, 404);
  return c.json({ data: { ...updated, evidence } });
});

export default r;
