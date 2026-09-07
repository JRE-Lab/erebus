// ============================================================================
// LOOM M2 (Phase 1) — incremental narrative clustering (spec §M2).
//
//   embed -> assign -> recount -> promote -> label -> lifecycle
//
// An article joins the nearest narrative within a trailing window when cosine
// similarity clears LOOM_SIM_THRESHOLD (default 0.70, tuned); otherwise it seeds a
// CANDIDATE cluster. A candidate promotes to a narrative at
// >= LOOM_PROMOTE_MIN_ARTICLES from >= LOOM_PROMOTE_MIN_OUTLETS distinct
// outlets; the fast-tier LLM labels it at promotion.
//
// Safety contracts (hardening + review lessons, do not relax):
//  - vectors are stored via embedStrict(), which THROWS instead of degrading
//    to the hash-space fallback — a stored fallback vector poisons the cosine
//    space forever, and the pause flag can flip mid-batch (cache TTL race).
//  - the embed query carries the SAME trailing-window filter as assignment —
//    otherwise a long pause builds a backlog we pay to embed but never use.
//  - the running-mean divisor tracks same-batch joins in memory (and the join
//    UPDATE increments article_count) — reading the row's count alone made the
//    centroid exponentially recency-weighted during bursts.
//  - the LLM label persists ONLY when parsed && !offline; real failures are
//    counted and capped (LABEL_MAX_ATTEMPTS), after which the seed title
//    becomes the label — an unlabelable narrative must not burn a paid call
//    every tick forever.
//  - ONE advisory lock covers cluster AND lifecycle (runLoomPass) — a manual
//    POST landing between a tick's cluster and lifecycle phases would
//    otherwise double-write metrics/transition rows.
// ============================================================================
import { eq, sql, and, isNull, isNotNull, desc, lt } from "drizzle-orm";
import {
  db,
  pool,
  loomArticles,
  loomNarratives,
  embedStrict,
  embeddingsLive,
  toVector,
} from "@erebus/db";
import { callJSON, loomLabelPrompt, SONNET } from "@erebus/agents";
import { runLoomLifecycle, type LoomLifecycleResult } from "./lifecycle.js";
import { resolveNarrativeEntities } from "./entities.js";
import { extractFraming, runIntent } from "./intent.js";
import { issueForecasts } from "./forecasts.js";
import { matchPlaybooks } from "./playbooks.js";
import { bridgeNarrativesToTree } from "./bridge.js";

// Spec starts at 0.82 and says "tune on eval set" — measured on live data,
// text-embedding-3-small puts same-story cross-outlet pairs at ~0.70-0.80
// (nothing reaches 0.82), so 0.70 is the tuned default for this model.
const SIM_THRESHOLD = Number(process.env.LOOM_SIM_THRESHOLD || 0.7);
const WINDOW_DAYS = Number(process.env.LOOM_CLUSTER_WINDOW_DAYS || 14);
const PROMOTE_MIN_ARTICLES = Number(process.env.LOOM_PROMOTE_MIN_ARTICLES || 5);
const PROMOTE_MIN_OUTLETS = Number(process.env.LOOM_PROMOTE_MIN_OUTLETS || 3);
const EMBED_BATCH = 200;
const ASSIGN_BATCH = 300;
const LABEL_BATCH = 3;
const LABEL_MAX_ATTEMPTS = Number(process.env.LOOM_LABEL_MAX_ATTEMPTS || 5);
const LOCK_KEY = 427001; // pg advisory lock id for the whole loom pass

export interface LoomClusterResult {
  embedded: number;
  assigned: number;
  seeded: number;
  promoted: number;
  labeled: number;
  cost: number;
  skipped?: string;
}

export type LoomPassResult = LoomClusterResult &
  Partial<LoomLifecycleResult> & {
    entitiesLinked?: number;
    framed?: number;
    achScored?: number;
    judgments?: number;
    forecastsIssued?: number;
    playbookMatches?: number;
    bridgeSignals?: number;
    bridgeMatches?: number;
  };

const ZERO: LoomClusterResult = { embedded: 0, assigned: 0, seeded: 0, promoted: 0, labeled: 0, cost: 0 };

// The single entry point (worker tick + manual POST): cluster -> lifecycle ->
// entities -> framing -> intent -> forecasts -> playbooks, all under one
// cross-process advisory lock. Every paid step inside is pause- and
// budget-gated on its own (embedStrict / callJSON), so the pass degrades to
// the free work when paused or over budget instead of failing.
export async function runLoomPass(): Promise<LoomPassResult> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`);
    if (!lock.rows[0]?.ok) return { ...ZERO, skipped: "loom pass already in progress" };
    try {
      const cluster = await clusterInner();
      const lifecycle = await runLoomLifecycle();
      const entities = await resolveNarrativeEntities();
      const framing = await extractFraming();
      const intent = await runIntent();
      const forecasts = await issueForecasts();
      const playbooks = await matchPlaybooks();
      const bridge = await bridgeNarrativesToTree();
      return {
        ...cluster,
        ...lifecycle,
        cost: cluster.cost + entities.cost + framing.cost + intent.cost,
        entitiesLinked: entities.entitiesLinked,
        framed: framing.framed,
        achScored: intent.scored,
        judgments: intent.judgments,
        forecastsIssued: forecasts.lifecycle + forecasts.market,
        playbookMatches: playbooks.matched,
        bridgeSignals: bridge.signalsEmitted,
        bridgeMatches: bridge.matchesMade,
      };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

async function clusterInner(): Promise<LoomClusterResult> {
  const r: LoomClusterResult = { ...ZERO };
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  // --- 1) embed unembedded articles (paid, tiny; strict — never a fallback) --
  // Window-filtered to match assignment: an article that aged past the window
  // (long pause, dead worker) can never be assigned, so never pay to embed it.
  if (await embeddingsLive()) {
    const pending = await db
      .select({ id: loomArticles.id, title: loomArticles.title, lede: loomArticles.lede })
      .from(loomArticles)
      .where(
        and(
          isNull(loomArticles.embedding),
          isNotNull(loomArticles.title),
          sql`${loomArticles.firstSeenAt} >= ${windowStart}`
        )
      )
      .orderBy(desc(loomArticles.firstSeenAt))
      .limit(EMBED_BATCH);
    for (const a of pending) {
      try {
        const v = await embedStrict(`${a.title}\n${(a.lede || "").slice(0, 500)}`);
        await db.update(loomArticles).set({ embedding: v }).where(eq(loomArticles.id, a.id));
        r.embedded++;
      } catch {
        break; // paused mid-batch or provider down — the rest waits for next tick
      }
    }
  }

  // --- 2) assign embedded, unassigned articles (free; pure math) -------------
  // Oldest-first so same-story articles arriving in one batch chain onto the
  // first one's cluster instead of each seeding its own.
  const unassigned = await db.execute(sql`
    SELECT id, embedding::text AS emb, first_seen_at
      FROM loom_articles
     WHERE narrative_id IS NULL
       AND embedding IS NOT NULL
       AND first_seen_at >= now() - make_interval(days => ${WINDOW_DAYS})
     ORDER BY first_seen_at ASC
     LIMIT ${ASSIGN_BATCH}
  `);
  const touched = new Set<string>();
  // Same-batch join counts: the row's article_count is only recounted after
  // the loop, so the true running-mean divisor is row count + in-batch joins.
  const batchJoins = new Map<string, number>();
  for (const row of (unassigned as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const emb = JSON.parse(row.emb as string) as number[];
    const firstSeen = new Date(row.first_seen_at as string);
    // Nearest active narrative by centroid (small table — seq scan is fine).
    const near = await db.execute(sql`
      SELECT id, article_count, centroid::text AS c,
             1 - (centroid <=> ${toVector(emb)}::vector) AS sim
        FROM loom_narratives
       WHERE last_seen_at >= now() - make_interval(days => ${WINDOW_DAYS})
       ORDER BY centroid <=> ${toVector(emb)}::vector
       LIMIT 1
    `);
    const best = (near as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    if (best && Number(best.sim) >= SIM_THRESHOLD) {
      const nid = best.id as string;
      const n = (Number(best.article_count) || 1) + (batchJoins.get(nid) ?? 0);
      const centroid = JSON.parse(best.c as string) as number[];
      // Running mean keeps the centroid cheap to maintain; cosine ignores the
      // magnitude drift, so no renormalization needed.
      const merged = centroid.map((v, i) => (v * n + (emb[i] ?? 0)) / (n + 1));
      await db.update(loomArticles).set({ narrativeId: nid }).where(eq(loomArticles.id, row.id as string));
      await db
        .update(loomNarratives)
        .set({
          centroid: merged,
          articleCount: sql`article_count + 1`,
          lastSeenAt: sql`GREATEST(last_seen_at, ${firstSeen})`,
        })
        .where(eq(loomNarratives.id, nid));
      batchJoins.set(nid, (batchJoins.get(nid) ?? 0) + 1);
      touched.add(nid);
      r.assigned++;
    } else {
      const [created] = await db
        .insert(loomNarratives)
        .values({ centroid: emb, state: "seeding", articleCount: 1, seededAt: firstSeen, lastSeenAt: firstSeen })
        .returning({ id: loomNarratives.id });
      if (created) {
        await db.update(loomArticles).set({ narrativeId: created.id }).where(eq(loomArticles.id, row.id as string));
        touched.add(created.id);
        r.seeded++;
      }
    }
  }

  // --- 3) recount touched narratives (authoritative aggregates) --------------
  if (touched.size) {
    const ids = [...touched];
    await db.execute(sql`
      UPDATE loom_narratives n
         SET article_count = a.c,
             outlet_count  = a.o,
             lang_count    = a.l,
             last_seen_at  = GREATEST(n.last_seen_at, a.ls)
        FROM (SELECT narrative_id,
                     count(*)::int                   AS c,
                     count(DISTINCT outlet_id)::int  AS o,
                     count(DISTINCT lang)::int       AS l,
                     max(first_seen_at)              AS ls
                FROM loom_articles
               WHERE narrative_id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(",")}]`)})
               GROUP BY narrative_id) a
       WHERE n.id = a.narrative_id
    `);
  }

  // --- 4) promote candidates that cleared the bar ----------------------------
  const promoted = await db.execute(sql`
    UPDATE loom_narratives
       SET promoted_at = now()
     WHERE promoted_at IS NULL
       AND article_count >= ${PROMOTE_MIN_ARTICLES}
       AND outlet_count  >= ${PROMOTE_MIN_OUTLETS}
     RETURNING id
  `);
  r.promoted = (promoted as unknown as { rows: unknown[] }).rows.length;

  // --- 5) label promoted-but-unlabeled narratives (fast tier, offline-safe) --
  const unlabeled = await db
    .select({ id: loomNarratives.id, attempts: loomNarratives.labelAttempts })
    .from(loomNarratives)
    .where(
      and(
        isNotNull(loomNarratives.promotedAt),
        isNull(loomNarratives.label),
        lt(loomNarratives.labelAttempts, LABEL_MAX_ATTEMPTS)
      )
    )
    .orderBy(desc(loomNarratives.lastSeenAt))
    .limit(LABEL_BATCH);
  for (const n of unlabeled) {
    const samples = await db
      .select({ title: loomArticles.title, lede: loomArticles.lede })
      .from(loomArticles)
      .where(eq(loomArticles.narrativeId, n.id))
      .orderBy(desc(loomArticles.firstSeenAt))
      .limit(8);
    const res = await callJSON<{ label: string; summary: string }>(
      loomLabelPrompt(samples.map((s) => ({ title: s.title || "", lede: s.lede || "" }))),
      { label: "", summary: "" },
      { tier: "sonnet", agent: "loom-label" }
    );
    r.cost += res.cost;
    // Offline (paused/over-budget) costs nothing and isn't the narrative's
    // fault — retry freely. A REAL failed attempt (parse failure, empty label)
    // burned money: count it, and at the cap fall back to the seed title so
    // the slot frees up and the paid retry loop ends.
    if (res.offline) continue;
    if (!res.parsed || !res.data.label?.trim()) {
      const attempts = (n.attempts ?? 0) + 1;
      if (attempts >= LABEL_MAX_ATTEMPTS) {
        await db.execute(sql`
          UPDATE loom_narratives n2
             SET label_attempts = ${attempts},
                 model_ver = 'fallback:seed-title',
                 label = COALESCE((SELECT a.title FROM loom_articles a
                                    WHERE a.narrative_id = n2.id
                                    ORDER BY a.first_seen_at ASC LIMIT 1), 'untitled narrative')
           WHERE n2.id = ${n.id}::uuid
        `);
      } else {
        await db.update(loomNarratives).set({ labelAttempts: attempts }).where(eq(loomNarratives.id, n.id));
      }
      continue;
    }
    await db
      .update(loomNarratives)
      .set({
        label: res.data.label.trim().slice(0, 140),
        summary: (res.data.summary || "").trim().slice(0, 600) || null,
        modelVer: res.model, // served, not configured

      })
      .where(eq(loomNarratives.id, n.id));
    r.labeled++;
  }

  return r;
}
