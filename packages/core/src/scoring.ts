// Resolution + calibration. When a node's horizon passes it resolves true/false
// and writes its Brier score; calibration is the mean Brier over resolved nodes.
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db, nodes, recordEvent } from "@erebus/db";
import { THRESH } from "./greening.js";

export async function resolveDueNodes(): Promise<{ resolved: number }> {
  const due = await db
    .select()
    .from(nodes)
    .where(and(isNull(nodes.resolved), lte(nodes.horizon, new Date())));

  let resolved = 0;
  for (const node of due) {
    const isTrue = node.confirmation >= THRESH.corroborated || (node.confirmation > 0 && node.confirmation > Math.abs(THRESH.contradicted));
    const actual = isTrue ? 1 : 0;
    const brier = Math.pow(node.confidence - actual, 2);
    await db
      .update(nodes)
      .set({
        resolved: true,
        brier,
        state: isTrue ? "resolved_true" : "resolved_false",
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, node.id));
    await recordEvent({
      nodeId: node.id,
      kind: "resolved",
      causeType: "job",
      after: { resolved: isTrue, brier },
    });
    resolved++;
  }
  return { resolved };
}

export async function calibrationScore(): Promise<number | null> {
  const [row] = await db
    .select({ avg: sql<number>`AVG(${nodes.brier})` })
    .from(nodes)
    .where(eq(nodes.resolved, true));
  return row?.avg ?? null;
}
