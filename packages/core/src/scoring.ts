// Resolution + calibration — against EXTERNAL ground truth, not the node's own
// greening. A forecast resolves only when reality adjudicates it: a realized
// market move (market package) or the operator marking it happened/didn't. Brier
// is scored against the node's P(outcome) AT resolution, so calibration finally
// measures real-world accuracy instead of grading its own homework.
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db, nodes, recordEvent } from "@erebus/db";

// Due = horizon passed and not yet resolved. We surface the count (so the UI can
// prompt adjudication) but DO NOT auto-resolve on the internal confirmation —
// that was self-referential. Real resolution comes from adjudicate().
export async function resolveDueNodes(): Promise<{ resolved: number; due: number }> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(isNull(nodes.resolved), lte(nodes.horizon, new Date())));
  return { resolved: 0, due: Number(row?.n ?? 0) };
}

// The real resolver: reality says the forecast happened (or didn't). Scores Brier
// against the probability the node held at resolution.
// source = market (realized moves) | operator (human) | verifier (source-verified LLM judge).
export async function adjudicate(
  nodeId: string,
  happened: boolean,
  source: "market" | "operator" | "verifier" = "operator"
): Promise<{ resolved: true; outcome: boolean; brier: number } | null> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return null;
  if (node.resolved) return null; // fast path — already resolved
  const actual = happened ? 1 : 0;
  const p = node.probability ?? (node.confirmation + 1) / 2;
  const brier = Math.pow(p - actual, 2);
  // ATOMIC: the `resolved IS NULL` predicate closes the operator/market/verifier
  // race — the second concurrent resolver updates 0 rows and returns null
  // instead of overwriting the first resolution with a conflicting outcome.
  const updated = await db
    .update(nodes)
    .set({
      resolved: true,
      resolvedOutcome: happened,
      resolvedSource: source,
      brier,
      state: happened ? "resolved_true" : "resolved_false",
      updatedAt: new Date(),
    })
    .where(and(eq(nodes.id, nodeId), isNull(nodes.resolved)))
    .returning({ id: nodes.id });
  if (!updated.length) return null; // lost the race — someone else resolved it
  await recordEvent({
    nodeId,
    kind: "resolved",
    causeType: source === "market" ? "signal_match" : "job",
    before: { probability: p, state: node.state },
    after: { resolved: happened, brier: Number(brier.toFixed(3)), source },
  });
  return { resolved: true, outcome: happened, brier };
}

export async function calibrationScore(): Promise<number | null> {
  const [row] = await db
    .select({ avg: sql<number>`AVG(${nodes.brier})` })
    .from(nodes)
    .where(eq(nodes.resolved, true));
  return row?.avg ?? null;
}

// Richer calibration read for the UI: how many resolved, mean Brier (lower is
// better; 0.25 = a coin flip), the realized base rate, and what's awaiting
// adjudication. Brier here is meaningful because outcomes are external.
export async function calibrationStats(): Promise<{
  resolved: number;
  meanBrier: number | null;
  trueRate: number | null;
  dueUnresolved: number;
}> {
  const [agg] = await db
    .select({
      resolved: sql<number>`count(*) FILTER (WHERE ${nodes.resolved} = true)::int`,
      meanBrier: sql<number>`AVG(${nodes.brier})`,
      trueRate: sql<number>`AVG(CASE WHEN ${nodes.resolvedOutcome} THEN 1.0 ELSE 0.0 END) FILTER (WHERE ${nodes.resolved} = true)`,
      due: sql<number>`count(*) FILTER (WHERE ${nodes.resolved} IS NULL AND ${nodes.horizon} <= now())::int`,
    })
    .from(nodes);
  return {
    resolved: Number(agg?.resolved ?? 0),
    meanBrier: agg?.meanBrier ?? null,
    trueRate: agg?.trueRate ?? null,
    dueUnresolved: Number(agg?.due ?? 0),
  };
}
