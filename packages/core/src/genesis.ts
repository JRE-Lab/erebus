// Genesis — EREBUS births NEW root theories from the signal stream instead of
// only expanding existing ones. Two modes: strategic (forward theses) and DARK
// (the shadow layer: hidden agendas, cui bono, cover narratives — disciplined,
// falsifiable). Dedup is prompt-side (existing roots are shown as off-limits)
// plus an exact/near-title guard here. Callers green the new roots via
// matchNode (ingest depends on core, so core cannot call it directly).
import { desc, eq, isNull, sql } from "drizzle-orm";
import { db, nodes, signals } from "@erebus/db";
import { callJSON, genesisPrompt } from "@erebus/agents";
import { createForecast } from "./tree.js";

interface GenesisShape {
  theories: Array<{ title: string; context: string }>;
}

export interface GenesisResult {
  created: Array<{ id: string; question: string; dark: boolean }>;
  cost: number;
  offline: boolean;
}

// crude near-dup guard: significant token overlap with an existing root question
function tooSimilar(a: string, b: string): boolean {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size) > 0.6;
}

export async function generateRootTheories(
  opts: { dark?: boolean; count?: number } = {}
): Promise<GenesisResult> {
  const dark = Boolean(opts.dark);
  const count = Math.max(1, Math.min(4, opts.count ?? 2));

  // Reality feed: most recent signal titles.
  const sigRows = await db
    .select({ title: signals.title, source: signals.source })
    .from(signals)
    .orderBy(desc(signals.ingestedAt))
    .limit(40);
  const sigTitles = sigRows.filter((s) => s.title).map((s) => `${s.title} (${s.source ?? "?"})`);

  // ALL existing roots feed the local dedup guard (roots stay a small set);
  // only the 40 most recent go into the prompt to keep it bounded.
  const rootRows = await db
    .select({ question: nodes.question })
    .from(nodes)
    .where(isNull(nodes.parentId))
    .orderBy(sql`${nodes.createdAt} DESC`);
  const existing = rootRows.map((r) => r.question);
  const promptExisting = existing.slice(0, 40);

  const { data, cost, offline } = await callJSON<GenesisShape>(
    genesisPrompt({ signals: sigTitles, existing: promptExisting, count, dark }),
    { theories: [] },
    { tier: "opus", agent: dark ? "genesis-dark" : "genesis", maxTokens: 2500 }
  );
  if (offline || !Array.isArray(data.theories) || !data.theories.length) {
    return { created: [], cost, offline };
  }

  const created: GenesisResult["created"] = [];
  let totalCost = cost;
  for (const t of data.theories.slice(0, count)) {
    const context = (t?.context ?? "").trim();
    const title = (t?.title ?? "").trim();
    if (!context) continue;
    if (existing.some((q) => tooSimilar(title || context, q))) continue; // near-dup guard

    try {
      const r = await createForecast(context, {
        origin: dark ? "shadow" : "erebus",
        eventAfter: { genesis: true, dark }, // single creation event (alerts key off after.genesis)
      });
      totalCost += r.cost;
      if (r.offline) {
        // The LLM fell back mid-batch (pause / provider outage): createForecast
        // already inserted an "[offline] forecast pending" stub — remove it so
        // junk roots never appear in the Explorer as autonomous theories.
        try {
          await db.delete(nodes).where(eq(nodes.id, r.node.id));
        } catch {
          /* best-effort cleanup */
        }
        continue;
      }
      created.push({ id: r.node.id, question: r.node.question, dark });
      existing.push(r.node.question); // guard within this batch too
    } catch {
      /* one bad theory never kills the batch */
    }
  }
  return { created, cost: totalCost, offline: false };
}
