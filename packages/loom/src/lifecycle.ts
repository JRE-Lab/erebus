// ============================================================================
// LOOM M2 (Phase 1) — lifecycle state machine + hourly metrics (spec §M2).
//
//   seeding -> amplifying -> peak -> decaying -> dormant
//   (reignition: decaying/dormant -> amplifying; peak -> amplifying on new high)
//
// Transitions are driven by trailing-24h article velocity with HYSTERESIS so
// cards do not flap: amplifying needs the full AMP threshold, peak requires
// falling to <= PEAK_FRAC of the high-water mark, decaying to <= DECAY_FRAC.
// Every measurement writes a metrics row; every transition writes a log row
// (Phase 1 acceptance: "lifecycle transitions logged and sane").
// All free — pure SQL + arithmetic, no LLM, no embeddings.
// ============================================================================
import { sql } from "drizzle-orm";
import { db } from "@erebus/db";

const AMP_MIN = Number(process.env.LOOM_AMP_MIN || 6); // articles/24h to count as amplifying
const PEAK_FRAC = Number(process.env.LOOM_PEAK_FRAC || 0.8); // crest detection band
const DECAY_FRAC = Number(process.env.LOOM_DECAY_FRAC || 0.5); // decay band
const DORMANT_HOURS = Number(process.env.LOOM_DORMANT_HOURS || 48); // silence -> dormant

export type LoomState = "seeding" | "amplifying" | "peak" | "decaying" | "dormant";

export interface LoomLifecycleResult {
  measured: number;
  transitions: number;
}

interface Snapshot {
  id: string;
  state: LoomState;
  maxVel24: number;
  vel24: number;
  vel6: number;
  prevVel24: number | null;
  reachOutlets: number;
  reachLangs: number;
  articleCount: number;
  hoursSinceSeen: number;
}

// One measurement + transition pass over promoted narratives. Dormant rows
// with no recent activity are skipped (nothing can change until an article
// lands, which bumps last_seen_at via the cluster step).
export async function runLoomLifecycle(): Promise<LoomLifecycleResult> {
  const res = await db.execute(sql`
    SELECT n.id,
           n.state,
           n.max_vel24,
           n.article_count,
           EXTRACT(EPOCH FROM (now() - n.last_seen_at)) / 3600.0                       AS hours_since_seen,
           (SELECT count(*)::int FROM loom_articles a
             WHERE a.narrative_id = n.id AND a.first_seen_at >= now() - interval '24 hours') AS vel24,
           (SELECT count(*)::int FROM loom_articles a
             WHERE a.narrative_id = n.id AND a.first_seen_at >= now() - interval '6 hours')  AS vel6,
           (SELECT count(DISTINCT a.outlet_id)::int FROM loom_articles a
             WHERE a.narrative_id = n.id AND a.first_seen_at >= now() - interval '24 hours') AS reach_outlets,
           (SELECT count(DISTINCT a.lang)::int FROM loom_articles a
             WHERE a.narrative_id = n.id AND a.first_seen_at >= now() - interval '24 hours') AS reach_langs,
           (SELECT m.vel24 FROM loom_narrative_metrics m
             WHERE m.narrative_id = n.id ORDER BY m.ts DESC LIMIT 1)                    AS prev_vel24
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL
       AND (n.state <> 'dormant' OR n.last_seen_at >= now() - make_interval(hours => ${DORMANT_HOURS}))
  `);

  let measured = 0;
  let transitions = 0;

  for (const row of (res as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const s: Snapshot = {
      id: row.id as string,
      state: (row.state as LoomState) || "seeding",
      maxVel24: Number(row.max_vel24) || 0,
      vel24: Number(row.vel24) || 0,
      vel6: Number(row.vel6) || 0,
      prevVel24: row.prev_vel24 == null ? null : Number(row.prev_vel24),
      reachOutlets: Number(row.reach_outlets) || 0,
      reachLangs: Number(row.reach_langs) || 0,
      articleCount: Number(row.article_count) || 0,
      hoursSinceSeen: Number(row.hours_since_seen) || 0,
    };
    const accel = s.prevVel24 == null ? 0 : s.vel24 - s.prevVel24;
    const next = nextState(s, accel);
    // Reignition starts a NEW attention cycle: reset the high-water mark to the
    // current velocity, otherwise the old peak's bands instantly re-crest the
    // reborn story (amplifying -> peak -> decaying flapping every hour).
    const reignited = next === "amplifying" && (s.state === "decaying" || s.state === "dormant");
    const newMax = reignited ? s.vel24 : Math.max(s.maxVel24, s.vel24);

    if (next !== s.state) {
      await db.execute(sql`
        INSERT INTO loom_narrative_transitions (narrative_id, from_state, to_state, metrics)
        VALUES (${s.id}::uuid, ${s.state}, ${next},
                ${JSON.stringify({ vel24: s.vel24, vel6: s.vel6, accel, maxVel24: newMax })}::jsonb)
      `);
      await db.execute(sql`
        UPDATE loom_narratives
           SET state = ${next},
               max_vel24 = ${newMax},
               last_state_change_at = now(),
               peak_at = CASE WHEN ${next} = 'peak' AND peak_at IS NULL THEN now() ELSE peak_at END
         WHERE id = ${s.id}::uuid
      `);
      transitions++;
    } else if (newMax !== s.maxVel24) {
      await db.execute(sql`UPDATE loom_narratives SET max_vel24 = ${newMax} WHERE id = ${s.id}::uuid`);
    }

    await db.execute(sql`
      INSERT INTO loom_narrative_metrics
        (narrative_id, vel24, vel6, accel, reach_outlets, reach_langs, article_count, state)
      VALUES (${s.id}::uuid, ${s.vel24}, ${s.vel6}, ${accel},
              ${s.reachOutlets}, ${s.reachLangs}, ${s.articleCount}, ${next})
    `);
    measured++;
  }

  return { measured, transitions };
}

// The machine. `max` hysteresis anchor uses the PRE-update high-water mark for
// the "new high" reignition check, the post-update mark for the crest bands.
function nextState(s: Snapshot, accel: number): LoomState {
  const newMax = Math.max(s.maxVel24, s.vel24);
  switch (s.state) {
    case "seeding":
      if (s.vel24 >= AMP_MIN) return "amplifying";
      // A slow-drip promotion whose story ended must not be measured hourly
      // forever — it sleeps like everything else and can reignite from dormant.
      if (s.vel24 === 0 && s.hoursSinceSeen >= DORMANT_HOURS) return "dormant";
      return "seeding";
    case "amplifying":
      // A total collapse goes straight to decaying — passing through "peak"
      // at near-zero velocity would stamp peak_at on a dead story.
      if (newMax >= AMP_MIN && s.vel24 <= newMax * DECAY_FRAC) return "decaying";
      // Crested: fell into the peak band off a real (>= AMP) high-water mark.
      if (newMax >= AMP_MIN && s.vel24 <= newMax * PEAK_FRAC) return "peak";
      return "amplifying";
    case "peak":
      if (s.vel24 <= newMax * DECAY_FRAC) return "decaying";
      if (s.vel24 > s.maxVel24) return "amplifying"; // new high — the story reignited
      return "peak";
    case "decaying":
      if (s.vel24 >= AMP_MIN && accel > 0) return "amplifying"; // reignition
      if (s.vel24 === 0 && s.hoursSinceSeen >= DORMANT_HOURS) return "dormant";
      return "decaying";
    case "dormant":
      return s.vel24 >= AMP_MIN ? "amplifying" : "dormant";
    default:
      return "seeding";
  }
}
