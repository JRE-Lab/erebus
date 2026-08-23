// Map a forecast (theory) onto the instruments whose price should move if it
// comes true. LLM-driven (cheap Sonnet), idempotent, and cost-bounded: nodes it
// has already considered (even when nothing fit) are remembered so the periodic
// worker tick never re-pays to map the same theory.
import { eq } from "drizzle-orm";
import { db, nodes, nodeInstruments, getSetting, setSetting } from "@erebus/db";
import { callJSON } from "@erebus/agents";
import { findInstrument, catalogVocabulary } from "./catalog.js";

interface MapShape {
  instruments: Array<{ symbol: string; expectation: "up" | "down"; rationale: string }>;
}

function prompt(node: { question: string; outcome: string; domains: string[] }): string {
  return `You link a geopolitical/macro FORECAST to tradable instruments.

FORECAST QUESTION: ${node.question}
FORECAST OUTCOME (what is predicted): ${node.outcome}
DOMAINS: ${(node.domains ?? []).join(", ") || "—"}

AVAILABLE INSTRUMENTS (use ONLY these symbols):
${catalogVocabulary()}

Pick the 1-3 instruments whose price would move most DIRECTLY and CAUSALLY if this forecast comes TRUE. For each, say whether it goes "up" or "down" if the forecast is true, and one terse clause of why. Be strict: only include an instrument with a clear, first-order causal link. If NONE fit, return an empty list.

Return JSON: {"instruments":[{"symbol":"CL","expectation":"up","rationale":"..."}]}`;
}

export async function mapTheory(nodeId: string): Promise<{ created: number; cost: number }> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { created: 0, cost: 0 };

  const { data, cost, offline, parsed } = await callJSON<MapShape>(
    prompt({ question: node.question, outcome: node.outcome, domains: node.domains ?? [] }),
    { instruments: [] },
    { tier: "sonnet", agent: "market-map", targetNode: nodeId, maxTokens: 600 }
  );
  // A fallback must not be destructive: the old code deleted the node's real
  // instrument links and re-inserted the empty fallback set on every outage.
  if (offline || !parsed) return { created: 0, cost };

  // Idempotent remap: clear this node's links, re-insert the chosen set.
  await db.delete(nodeInstruments).where(eq(nodeInstruments.nodeId, nodeId));
  let created = 0;
  const seen = new Set<string>();
  for (const m of (data.instruments ?? []).slice(0, 3)) {
    const inst = findInstrument(m?.symbol ?? "");
    if (!inst || seen.has(inst.symbol)) continue;
    seen.add(inst.symbol);
    await db.insert(nodeInstruments).values({
      nodeId,
      symbol: inst.symbol,
      name: inst.name,
      kind: inst.kind,
      expectation: m.expectation === "down" ? "down" : "up",
      rationale: (m.rationale ?? "").slice(0, 400),
    });
    created++;
  }
  await rememberSeen([nodeId]);
  return { created, cost };
}

async function rememberSeen(ids: string[]): Promise<void> {
  const cur = await getSetting<string[]>("market_seen", []);
  const next = Array.from(new Set([...(Array.isArray(cur) ? cur : []), ...ids])).slice(-2000);
  await setSetting("market_seen", next);
}

// Map every live theory that hasn't been considered yet (bounded per call).
export async function mapUnmappedTheories(limit = 12): Promise<{ mapped: number; created: number; cost: number }> {
  const seen = new Set(await getSetting<string[]>("market_seen", []));
  const rows = await db
    .select({ id: nodes.id, state: nodes.state, merged: nodes.mergedInto })
    .from(nodes);
  const targets = rows
    .filter((r) => r.id && !seen.has(r.id) && !r.merged && r.state !== "dormant")
    .map((r) => r.id)
    .slice(0, limit);

  let mapped = 0;
  let created = 0;
  let cost = 0;
  for (const id of targets) {
    try {
      const r = await mapTheory(id);
      created += r.created;
      cost += r.cost;
      mapped++;
    } catch {
      /* skip and continue */
    }
  }
  return { mapped, created, cost };
}
