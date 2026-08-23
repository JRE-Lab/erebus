// ============================================================================
// LOOM M9 (Phase 4 pilot) — playbook inversion. For a chosen EREBUS theory
// branch, a deep-tier red-team pass designs what the supporting narrative
// campaign WOULD look like; the patterns become watch expressions matched
// against real promoted narratives. A match is a pre-registered prediction
// hit (logged as a playbook_match forecast row and scored by M11).
// MVP cut (documented): matching is token-overlap over themes/actors; the
// embedding matcher and confidence decay land with Phase 5 automation.
// ============================================================================
import { eq, sql } from "drizzle-orm";
import { db, nodes, loomPlaybooks, loomPlaybookMatches, loomForecasts } from "@erebus/db";
import { callJSON, loomPlaybookPrompt } from "@erebus/agents";

const MATCH_THRESHOLD = Number(process.env.LOOM_PLAYBOOK_MATCH || 0.35);

export interface PlaybookGenResult { created: number; cost: number; skipped?: string }

const PLAYBOOKS_PER_THEORY = Number(process.env.LOOM_PLAYBOOKS_PER_THEORY || 3);

// Generate playbooks for one EREBUS theory node (deep tier — Fable).
// Idempotent by design: the endpoint is a DEEP-TIER call, and repeat presses
// would otherwise mint duplicate playbooks that each mint their own
// append-only forecast rows on the same narratives (R3 makes that permanent).
export async function generatePlaybooks(theoryRef: string): Promise<PlaybookGenResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, theoryRef)).limit(1);
  if (!node) return { created: 0, cost: 0, skipped: "unknown theory" };

  const existing = await db
    .select({ id: loomPlaybooks.id })
    .from(loomPlaybooks)
    .where(eq(loomPlaybooks.theoryRef, theoryRef));
  if (existing.length >= PLAYBOOKS_PER_THEORY) {
    return { created: 0, cost: 0, skipped: `theory already has ${existing.length} playbooks` };
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
  for (const p of (res.data.playbooks ?? []).slice(0, room)) {
    if (!p.outcomeDesc?.trim() || !p.pattern?.themes?.length) continue;
    await db.insert(loomPlaybooks).values({
      theoryRef,
      outcomeDesc: p.outcomeDesc.trim().slice(0, 400),
      pattern: {
        themes: (p.pattern.themes ?? []).slice(0, 8).map((t) => String(t).toLowerCase()),
        actors: (p.pattern.actors ?? []).slice(0, 8).map((a) => String(a).toLowerCase()),
        framingSignature: String(p.pattern.framingSignature ?? "").slice(0, 300),
        sequencing: String(p.pattern.sequencing ?? "").slice(0, 300),
      },
      model: "fable-deep-tier",
    });
    created++;
  }
  return { created, cost: res.cost };
}

// Token-overlap match of playbook patterns vs promoted narratives.
export interface PlaybookMatchResult { checked: number; matched: number }

export async function matchPlaybooks(): Promise<PlaybookMatchResult> {
  const r: PlaybookMatchResult = { checked: 0, matched: 0 };
  const playbooks = await db.select().from(loomPlaybooks);
  if (!playbooks.length) return r;

  const narrs = await db.execute(sql`
    SELECT n.id, lower(coalesce(n.label,'') || ' ' || coalesce(n.summary,'') || ' ' ||
           coalesce((SELECT string_agg(a.title, ' ') FROM loom_articles a
                      WHERE a.narrative_id = n.id LIMIT 1), '')) AS text
      FROM loom_narratives n
     WHERE n.promoted_at IS NOT NULL AND n.last_seen_at > now() - interval '14 days'
  `);

  for (const pb of playbooks) {
    const pattern = pb.pattern as { themes?: string[]; actors?: string[] };
    const terms = [...(pattern.themes ?? []), ...(pattern.actors ?? [])].filter(Boolean);
    if (!terms.length) continue;

    for (const n of (narrs as unknown as { rows: Array<{ id: string; text: string }> }).rows) {
      r.checked++;
      const hits = terms.filter((t) => n.text.includes(t)).length;
      const score = hits / terms.length;
      if (score < MATCH_THRESHOLD) continue;

      const [ins] = await db
        .insert(loomPlaybookMatches)
        .values({ playbookId: pb.id, narrativeId: n.id, matchScore: score })
        .onConflictDoNothing()
        .returning({ id: loomPlaybookMatches.id });
      if (!ins) continue; // already matched earlier
      r.matched++;

      // Pre-register the hit as a forecast row so M11 scores playbook heads too.
      // Every forecast row stamps its regime (module contract in forecasts.ts).
      const reg = await db.execute(sql`SELECT state FROM loom_regimes ORDER BY date DESC LIMIT 1`);
      const regime = ((reg as unknown as { rows: Array<{ state: string }> }).rows[0]?.state) ?? "neutral";
      await db.insert(loomForecasts).values({
        narrativeId: n.id,
        claimType: "playbook_match",
        targetRef: { playbookId: pb.id, theoryRef: pb.theoryRef, score },
        windowStart: new Date(),
        windowEnd: new Date(Date.now() + 30 * 86_400_000),
        prob: Math.min(0.9, 0.4 + score / 2),
        regimeAtIssue: regime,
        modelVer: "loom-phase4-mvp-1",
      });
    }
  }
  return r;
}
