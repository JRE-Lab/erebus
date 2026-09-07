// ============================================================================
// LOOM M9 (Phase 4 pilot) — playbook inversion. For a chosen EREBUS theory
// branch, a deep-tier red-team pass designs what the supporting narrative
// campaign WOULD look like; the patterns become watch expressions matched
// against real promoted narratives. A match is a pre-registered prediction
// hit (logged as a playbook_match forecast row and scored by M11).
// MVP cut (documented): matching is token-overlap over themes/actors; the
// embedding matcher and confidence decay land with Phase 5 automation.
// ============================================================================
import { eq, and, gte, isNull, sql } from "drizzle-orm";
import {
  db,
  nodes,
  loomPlaybooks,
  loomPlaybookMatches,
  loomForecasts,
  embedStrict,
  embeddingsLive,
  toVector,
} from "@erebus/db";
import { callJSON, loomPlaybookPrompt } from "@erebus/agents";

const MATCH_THRESHOLD = Number(process.env.LOOM_PLAYBOOK_MATCH || 0.35);
// Embedding matcher: the pilot showed LLM patterns are abstract ("alliance
// strengthening", "government spokespeople"), so exact-token hits on real
// headlines are vanishingly rare. Cosine between the pattern embedding and a
// narrative's centroid is the matcher that can actually fire; the token path
// stays as a second, independent route. Tune on live pair scores.
const EMBED_MATCH_THRESHOLD = Number(process.env.LOOM_PLAYBOOK_EMBED_MATCH || 0.5);

function patternText(p: { outcomeDesc: string; pattern: { themes?: string[]; actors?: string[]; framingSignature?: string } }): string {
  return [
    p.outcomeDesc,
    `Themes: ${(p.pattern.themes ?? []).join(", ")}`,
    `Actors: ${(p.pattern.actors ?? []).join(", ")}`,
    `Frame: ${p.pattern.framingSignature ?? ""}`,
  ].join("\n");
}
const MIN_TERM_LEN = Number(process.env.LOOM_PLAYBOOK_MIN_TERM_LEN || 4);
const MIN_TERMS = Number(process.env.LOOM_PLAYBOOK_MIN_TERMS || 3);
const MIN_ABS_HITS = Number(process.env.LOOM_PLAYBOOK_MIN_HITS || 2);

// Whole-word (or whole-phrase) containment. Escapes the term so a pattern from
// an LLM cannot inject regex metacharacters.
function wordHit(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(haystack);
}

export interface PlaybookGenResult { created: number; cost: number; skipped?: string }

const PLAYBOOKS_PER_THEORY = Number(process.env.LOOM_PLAYBOOKS_PER_THEORY || 3);

// Generate playbooks for one EREBUS theory node (deep tier — Fable).
// Idempotent by design: the endpoint is a DEEP-TIER call, and repeat presses
// would otherwise mint duplicate playbooks that each mint their own
// append-only forecast rows on the same narratives (R3 makes that permanent).
export async function generatePlaybooks(theoryRef: string): Promise<PlaybookGenResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, theoryRef)).limit(1);
  if (!node) return { created: 0, cost: 0, skipped: "unknown theory" };

  // Only LIVE playbooks count against the cap. A retired one is a record of a
  // prediction that did not pan out; letting it hold a slot would leave the
  // theory permanently uncovered.
  const existing = await db
    .select({ id: loomPlaybooks.id })
    .from(loomPlaybooks)
    .where(and(eq(loomPlaybooks.theoryRef, theoryRef), gte(loomPlaybooks.confidence, RETIRE_BELOW)));
  if (existing.length >= PLAYBOOKS_PER_THEORY) {
    return { created: 0, cost: 0, skipped: `theory already has ${existing.length} live playbooks` };
  }

  const res = await callJSON<{
    playbooks: Array<{ outcomeDesc: string; pattern: { themes: string[]; actors: string[]; framingSignature: string; sequencing: string } }>;
  }>(
    loomPlaybookPrompt({ id: node.id, question: node.question, outcome: node.outcome }),
    { playbooks: [] },
    { tier: "opus", agent: "loom-playbook", targetNode: theoryRef, maxTokens: 2500 }
  );
  if (res.offline || !res.parsed) return { created: 0, cost: res.cost };

  let created = 0;
  const room = Math.max(0, PLAYBOOKS_PER_THEORY - existing.length);
  const live = await embeddingsLive();
  for (const p of (res.data.playbooks ?? []).slice(0, room)) {
    if (!p.outcomeDesc?.trim() || !p.pattern?.themes?.length) continue;
    const pattern = {
      themes: (p.pattern.themes ?? []).slice(0, 8).map((t) => String(t).toLowerCase()),
      actors: (p.pattern.actors ?? []).slice(0, 8).map((a) => String(a).toLowerCase()),
      framingSignature: String(p.pattern.framingSignature ?? "").slice(0, 300),
      sequencing: String(p.pattern.sequencing ?? "").slice(0, 300),
    };
    // Pattern embedding: strict (never a hash-space fallback); if embeddings
    // are not live the column stays NULL and the matcher fills it later.
    let patternEmbedding: number[] | null = null;
    if (live) {
      try {
        patternEmbedding = await embedStrict(patternText({ outcomeDesc: p.outcomeDesc, pattern }));
      } catch {
        patternEmbedding = null;
      }
    }
    await db.insert(loomPlaybooks).values({
      theoryRef,
      outcomeDesc: p.outcomeDesc.trim().slice(0, 400),
      pattern,
      model: res.model, // what actually answered — the configured tier is not a fact
      patternEmbedding,
    });
    created++;
  }
  return { created, cost: res.cost };
}

// M9 automation: playbooks that keep failing to match lose confidence, and a
// playbook that decays below the floor is retired from matching. A prediction
// that never comes true has to cost something, or the library only grows.
const DECAY_PER_DAY = Number(process.env.LOOM_PLAYBOOK_DECAY || 0.02);
const RETIRE_BELOW = Number(process.env.LOOM_PLAYBOOK_RETIRE || 0.15);
const MAX_DECAY_DAYS = Number(process.env.LOOM_PLAYBOOK_MAX_DECAY_DAYS || 7);

// Confidence falls while a playbook goes unmatched, and is settled by OUTCOME
// rather than by match volume: a matched narrative that never became a real
// story is a miss, and paying out on raw match count would select for the
// spammiest patterns and retire the discriminating ones.
export async function decayPlaybooks(): Promise<{ decayed: number; retired: number; scored: number }> {
  // 1) settle resolved playbook_match claims (M11 feeds M9)
  const settled = await db.execute(sql`
    WITH scored AS (
      SELECT (f.target_ref->>'playbookId')::uuid AS playbook_id,
             bool_or(res.outcome) AS any_hit,
             count(*) FILTER (WHERE res.outcome) AS hits,
             count(*) AS n
        FROM loom_forecasts f
        JOIN loom_resolutions res ON res.forecast_id = f.id
       WHERE f.claim_type = 'playbook_match'
         AND res.resolved_at > now() - interval '14 days'
         AND f.target_ref->>'playbookId' IS NOT NULL
       GROUP BY 1
    )
    UPDATE loom_playbooks p
       SET confidence = LEAST(0.95, GREATEST(0.0,
             p.confidence + 0.15 * (s.hits::float8 / s.n) - 0.10 * (1 - s.hits::float8 / s.n)))
      FROM scored s
     WHERE p.id = s.playbook_id
     RETURNING p.id
  `);

  // 2) time decay for the unmatched, bounded so a long gap (or a first pass
  // after the column was added) cannot wipe the library in one step.
  const res = await db.execute(sql`
    UPDATE loom_playbooks
       SET confidence = GREATEST(0,
             confidence - ${DECAY_PER_DAY} * LEAST(${MAX_DECAY_DAYS},
               EXTRACT(EPOCH FROM (now() - COALESCE(decayed_at, last_matched_at, created_at))) / 86400.0)),
           decayed_at = now()
     WHERE COALESCE(decayed_at, last_matched_at, created_at) < now() - interval '1 day'
     RETURNING confidence
  `);
  const rows = (res as unknown as { rows: Array<{ confidence: number }> }).rows;
  return {
    decayed: rows.length,
    retired: rows.filter((x) => Number(x.confidence) < RETIRE_BELOW).length,
    scored: (settled as unknown as { rows: unknown[] }).rows.length,
  };
}

// Token-overlap match of playbook patterns vs promoted narratives.
export interface PlaybookMatchResult { checked: number; matched: number }

export async function matchPlaybooks(): Promise<PlaybookMatchResult> {
  const r: PlaybookMatchResult = { checked: 0, matched: 0 };

  // Backfill pattern embeddings written while embeddings were offline.
  if (await embeddingsLive()) {
    const missing = await db
      .select({ id: loomPlaybooks.id, outcomeDesc: loomPlaybooks.outcomeDesc, pattern: loomPlaybooks.pattern })
      .from(loomPlaybooks)
      .where(isNull(loomPlaybooks.patternEmbedding))
      .limit(20);
    for (const m of missing) {
      try {
        const v = await embedStrict(
          patternText({ outcomeDesc: m.outcomeDesc, pattern: (m.pattern ?? {}) as { themes?: string[]; actors?: string[]; framingSignature?: string } })
        );
        await db.update(loomPlaybooks).set({ patternEmbedding: v }).where(eq(loomPlaybooks.id, m.id));
      } catch {
        break; // paused mid-batch or provider down
      }
    }
  }

  // Retired playbooks (decayed below the floor) stop matching — they stay in
  // the table as a record of a prediction that did not pan out.
  const playbooks = (await db.select().from(loomPlaybooks)).filter(
    (p) => Number(p.confidence) >= RETIRE_BELOW
  );
  if (!playbooks.length) return r;

  // Embedding route: pattern vs narrative centroid over recent promoted
  // narratives, one SQL scan per playbook (free).
  const embedHits = new Map<string, number>(); // `${playbookId}:${narrativeId}` -> cosine
  for (const pb of playbooks) {
    if (!pb.patternEmbedding) continue;
    const res = await db.execute(sql`
      SELECT n.id, 1 - (n.centroid <=> ${toVector(pb.patternEmbedding as number[])}::vector) AS sim
        FROM loom_narratives n
       WHERE n.promoted_at IS NOT NULL AND n.last_seen_at > now() - interval '14 days'
         AND 1 - (n.centroid <=> ${toVector(pb.patternEmbedding as number[])}::vector) >= ${EMBED_MATCH_THRESHOLD}
       ORDER BY n.centroid <=> ${toVector(pb.patternEmbedding as number[])}::vector
       LIMIT 5
    `);
    for (const row of (res as unknown as { rows: Array<{ id: string; sim: number }> }).rows) {
      embedHits.set(`${pb.id}:${row.id}`, Number(row.sim));
    }
  }

  // The label/summary carry the narrative's identity; article titles are
  // capped so a large narrative does not simply out-collide a small one.
  const narrs = await db.execute(sql`
    SELECT n.id, lower(coalesce(n.label,'') || ' ' || coalesce(n.summary,'') || ' ' ||
           coalesce((SELECT string_agg(t.title, ' ') FROM (
                      SELECT a.title FROM loom_articles a
                       WHERE a.narrative_id = n.id AND a.title IS NOT NULL
                       ORDER BY a.first_seen_at ASC LIMIT 10) t), '')) AS text
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL AND n.last_seen_at > now() - interval '14 days'
  `);

  for (const pb of playbooks) {
    const pattern = pb.pattern as { themes?: string[]; actors?: string[] };
    // Short tokens ("us", "oil", "eu") match nearly any world-news text as raw
    // substrings, and every spurious match mints a PERMANENT append-only
    // forecast row. Require real terms and whole-word hits.
    const terms = [...(pattern.themes ?? []), ...(pattern.actors ?? [])]
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= MIN_TERM_LEN);
    // The token route needs enough terms; the embedding route does not.
    if (terms.length < MIN_TERMS && !pb.patternEmbedding) continue;

    for (const n of (narrs as unknown as { rows: Array<{ id: string; text: string }> }).rows) {
      r.checked++;
      const hits = terms.filter((t) => wordHit(n.text, t)).length;
      const tokenScore = hits / terms.length;
      const tokenHit = hits >= MIN_ABS_HITS && tokenScore >= MATCH_THRESHOLD;
      const embedScore = embedHits.get(`${pb.id}:${n.id}`);
      if (!tokenHit && embedScore == null) continue;
      // Store the route that fired (embedding cosine preferred: it is the
      // calibrated one); the forecast prob derives from it below.
      const score = embedScore ?? tokenScore;

      const reg = await db.execute(sql`SELECT state FROM loom_regimes ORDER BY date DESC LIMIT 1`);
      const regime = ((reg as unknown as { rows: Array<{ state: string }> }).rows[0]?.state) ?? "neutral";

      // One transaction: the match row, its pre-registered forecast, and the
      // decay-clock reset must land together. A crash between them would lose
      // a pre-registered prediction (R3 forbids writing it later).
      let inserted = false;
      await db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(loomPlaybookMatches)
          .values({ playbookId: pb.id, narrativeId: n.id, matchScore: score })
          .onConflictDoNothing()
          .returning({ id: loomPlaybookMatches.id });
        if (!ins) return; // already matched earlier
        inserted = true;
        await tx.insert(loomForecasts).values({
          narrativeId: n.id,
          claimType: "playbook_match",
          targetRef: { playbookId: pb.id, theoryRef: pb.theoryRef, score },
          windowStart: new Date(),
          windowEnd: new Date(Date.now() + 30 * 86_400_000),
          prob: Math.min(0.9, 0.4 + score / 2),
          regimeAtIssue: regime,
          modelVer: "loom-phase4-mvp-1",
        });
        // A match only resets the decay clock. Confidence is settled by the
        // RESOLVED outcome in decayPlaybooks(), never by match volume.
        await tx
          .update(loomPlaybooks)
          .set({ lastMatchedAt: sql`now()`, decayedAt: sql`now()` })
          .where(eq(loomPlaybooks.id, pb.id));
      });
      if (!inserted) continue;
      r.matched++;
    }
  }
  return r;
}
