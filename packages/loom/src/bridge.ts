// ============================================================================
// LOOM -> EREBUS bridge (spec §1: LOOM "feeds the theory tree").
//
// A PROMOTED narrative is aggregated, cross-outlet evidence, so it enters the
// tree through the EXISTING signal pipeline rather than a parallel one: one
// row in `signals` (source "loom", embedding = the narrative centroid, so no
// new embedding spend), judged by the same fast-tier judge, greened by the
// same Bayesian applyMatch, deduped by the same (signal, node) unique index,
// and shown in the same NodeDetail evidence list.
//
// Review lessons baked in (do not relax):
//  * ONE signal per narrative, at promotion. LOOM's feeds overlap EREBUS's own
//    ingest, so the member articles have usually ALREADY greened the tree one
//    by one; emitting promoted+amplifying+peak as three signals sharing one
//    centroid hit the same candidate nodes three more times at full weight and
//    could manufacture a launch point from a single story cluster.
//  * The judge's weight is SCALED DOWN (BRIDGE_WEIGHT_SCALE). The narrative's
//    marginal information over its members is breadth — multi-outlet
//    convergence — which is real but correlated with evidence already applied.
//  * Emit ONLY when the judge can actually run (llm live, not paused, within
//    budget). The signal row is the emission marker; inserting it while the
//    judge is offline consumed the event forever with no matches made.
//  * Fresh-first with an age window: a cold start must not drain months of
//    history oldest-first ahead of today's decision-relevant promotion, and
//    applyMatch has no recency discount to make stale evidence cheaper.
//  * Coverage stats lead the summary and sit in the title: the judge prompt
//    windows the summary to 500 chars, and trailing stats fell outside it.
// ============================================================================
import { sql } from "drizzle-orm";
import { db, signals, isPaused, withinDailyBudget } from "@erebus/db";
import { llmLive } from "@erebus/agents";
import { matchSignal } from "@erebus/ingest";

const BRIDGE_BATCH = Number(process.env.LOOM_BRIDGE_BATCH || 6); // narratives per pass
const MAX_AGE_HOURS = Number(process.env.LOOM_BRIDGE_MAX_AGE_H || 72); // promotions older than this are not bridged
const WEIGHT_SCALE = Number(process.env.LOOM_BRIDGE_WEIGHT_SCALE || 0.5);

type Rows = { rows: Array<Record<string, unknown>> };

export interface LoomBridgeResult {
  signalsEmitted: number;
  matchesMade: number;
  skipped?: string;
}

async function judgeAvailable(): Promise<boolean> {
  if (!llmLive()) return false;
  if (await isPaused()) return false;
  return withinDailyBudget();
}

// Emit pending promotions as tree signals and green the tree against them.
export async function bridgeNarrativesToTree(): Promise<LoomBridgeResult> {
  const r: LoomBridgeResult = { signalsEmitted: 0, matchesMade: 0 };
  if (!(await judgeAvailable())) return { ...r, skipped: "judge unavailable (offline/paused/budget)" };

  const pending = await db.execute(sql`
    SELECT n.id AS narrative_id, n.promoted_at::text AS at,
           n.label, n.summary, n.centroid::text AS centroid,
           n.article_count, n.outlet_count, n.first_mover_outlet,
           COALESCE((SELECT m.vel24 FROM loom_narrative_metrics m
                      WHERE m.narrative_id = n.id ORDER BY m.ts DESC LIMIT 1), 0) AS vel24
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
       AND n.promoted_at >= now() - make_interval(hours => ${MAX_AGE_HOURS})
       AND n.label IS NOT NULL AND btrim(n.label) <> ''
       AND n.centroid IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM signals s WHERE s.dedup_hash = 'loom:promoted:' || n.id::text
       )
     ORDER BY n.promoted_at DESC
     LIMIT ${BRIDGE_BATCH}
  `);

  for (const row of (pending as Rows).rows) {
    // Re-check per event: pause/budget can flip mid-pass, and an inserted row
    // whose judge never ran is an event consumed for nothing.
    if (!(await judgeAvailable())) {
      r.skipped = "judge became unavailable mid-pass";
      break;
    }
    const narrativeId = row.narrative_id as string;
    const label = String(row.label ?? "").trim();
    const articles = Number(row.article_count) || 0;
    const outlets = Number(row.outlet_count) || 0;
    const vel24 = Number(row.vel24) || 0;
    const firstMover = (row.first_mover_outlet as string) ?? null;

    const title = `[Narrative · ${articles} articles / ${outlets} outlets] ${label}`.slice(0, 490);
    const summary = [
      `Coverage: ${articles} articles across ${outlets} outlets, ${vel24}/24h` +
        (firstMover ? `; first mover ${firstMover}` : "") +
        ". Aggregated cross-outlet news narrative (its member articles may already appear as individual signals).",
      String(row.summary ?? label),
    ]
      .join(" ")
      .slice(0, 1500);

    const centroid = JSON.parse(row.centroid as string) as number[];

    const [inserted] = await db
      .insert(signals)
      .values({
        source: "loom",
        url: `/narratives?open=${narrativeId}`,
        title,
        summary,
        dedupHash: `loom:promoted:${narrativeId}`,
        publishedAt: new Date(row.at as string), // observed promotion time (R1)
        embedding: centroid,
      })
      .onConflictDoNothing()
      .returning({ id: signals.id });
    if (!inserted) continue; // raced another pass — the event is covered

    r.signalsEmitted++;
    const matches = await matchSignal(inserted.id, { weightScale: WEIGHT_SCALE });
    r.matchesMade += matches.length;
  }

  return r;
}
