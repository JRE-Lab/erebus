// ============================================================================
// LOOM M8 + M2-back-half (Phase 4) — framing extraction, coordination score,
// and the ACH intent engine.
//
// Discipline (spec §1): the observable layers (framing, coordination,
// provenance) are measured; intent is INFERRED and gets ACH treatment with
// ICD 203 estimative bands and mandatory falsifiers.
// R2 is enforced at the single write path: persistJudgment() THROWS if the
// runner-up or falsifiers are missing — no judgment row can exist without
// them. R5: wire share is computed and labeled separately so syndication is
// never silently read as coordination.
// ============================================================================
import { eq, sql, and, isNull, isNotNull, desc } from "drizzle-orm";
import {
  db,
  loomNarratives,
  loomArticles,
  loomFraming,
  loomHypotheses,
  loomEvidence,
  loomJudgments,
  loomBeneficiaries,
} from "@erebus/db";
import { callJSON, loomFramingPrompt, loomAchPrompt, LOOM_HYPOTHESES, SONNET } from "@erebus/agents";
import { narrativeInstruments } from "./entities.js";

const FRAMING_BATCH = Number(process.env.LOOM_FRAMING_BATCH || 20); // articles per pass (sampling cap)
const ACH_BATCH = Number(process.env.LOOM_ACH_BATCH || 3);
const ACH_MAX_ATTEMPTS = Number(process.env.LOOM_ACH_MAX_ATTEMPTS || 4);
// Coordination text_sim is measured RELATIVE to cluster membership: members are
// admitted at >= LOOM_SIM_THRESHOLD, so that is the honest zero-point.
const SIM_FLOOR = Number(process.env.LOOM_SIM_THRESHOLD || 0.7);
const SIM_TOP = Number(process.env.LOOM_SIM_VERBATIM || 0.95); // near-verbatim wire copy
const FRAME_MIN_ROWS = Number(process.env.LOOM_FRAME_MIN_ROWS || 4); // framed articles before frame_homog counts

// --- ICD 203 estimative bands (spec M8) --------------------------------------
export function icdBand(p: number): string {
  if (p < 0.05) return "almost no chance";
  if (p < 0.2) return "very unlikely";
  if (p < 0.45) return "unlikely";
  if (p < 0.55) return "roughly even chance";
  if (p < 0.8) return "likely";
  if (p < 0.95) return "very likely";
  return "almost certain";
}

// --- framing extraction (fast tier, sampled) ---------------------------------
export interface LoomFramingResult { framed: number; cost: number }

export async function extractFraming(): Promise<LoomFramingResult> {
  const r: LoomFramingResult = { framed: 0, cost: 0 };
  // Only articles inside promoted narratives earn a framing call (sampling cap).
  const pending = await db.execute(sql`
    SELECT a.id, a.title, a.lede
      FROM loom_articles a
      JOIN loom_narratives n ON n.id = a.narrative_id AND n.promoted_at IS NOT NULL
     WHERE NOT EXISTS (SELECT 1 FROM loom_framing f WHERE f.article_id = a.id)
     ORDER BY a.first_seen_at DESC
     LIMIT ${FRAMING_BATCH}
  `);
  for (const a of (pending as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const res = await callJSON<{
      protagonist: string; antagonist: string; threat: string; remedy: string;
      urgency: string; implied_action: string;
    }>(
      loomFramingPrompt((a.title as string) || "", (a.lede as string) || ""),
      { protagonist: "", antagonist: "", threat: "", remedy: "", urgency: "", implied_action: "" },
      { tier: "sonnet", agent: "loom-framing" }
    );
    r.cost += res.cost;
    if (res.offline) break; // paused/over budget — stop the whole batch (free retry)
    if (!res.parsed) {
      // A parse failure already cost money. Write a sentinel row (all slots
      // NULL, model tagged) so this article leaves the queue instead of
      // burning a call every pass forever; modal-frame math ignores NULLs.
      await db
        .insert(loomFraming)
        .values({ articleId: a.id as string, model: "unparsed" })
        .onConflictDoNothing();
      continue;
    }
    await db
      .insert(loomFraming)
      .values({
        articleId: a.id as string,
        protagonist: res.data.protagonist?.slice(0, 200) || null,
        antagonist: res.data.antagonist?.slice(0, 200) || null,
        threat: res.data.threat?.slice(0, 200) || null,
        remedy: res.data.remedy?.slice(0, 200) || null,
        urgency: ["low", "medium", "high"].includes(res.data.urgency) ? res.data.urgency : null,
        impliedAction: res.data.implied_action?.slice(0, 200) || null,
        model: SONNET,
      })
      .onConflictDoNothing();
    r.framed++;
  }
  return r;
}

// --- coordination score (free math; spec M2 composite) ------------------------
interface CoordResult {
  score: number; ciLow: number; ciHigh: number;
  components: { timingSync: number; textSim: number; provenance: number; frameHomog: number };
  wireSharePct: number; firstMover: string | null; frame: Record<string, string> | null;
}

function modal(values: string[]): { value: string | null; share: number } {
  const counts = new Map<string, number>();
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: string | null = null, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return { value: best, share: values.length ? n / values.length : 0 };
}

export async function computeCoordination(narrativeId: string): Promise<CoordResult | null> {
  const arts = await db.execute(sql`
    SELECT a.id, a.first_seen_at, a.text_hash, a.title, a.embedding::text AS emb,
           o.domain AS outlet
      FROM loom_articles a LEFT JOIN loom_outlets o ON o.id = a.outlet_id
     WHERE a.narrative_id = ${narrativeId}::uuid
     ORDER BY a.first_seen_at ASC
  `);
  const rows = (arts as unknown as { rows: Array<Record<string, unknown>> }).rows;
  if (rows.length < 2) return null;

  const seen = rows.map((a) => Date.parse(a.first_seen_at as string));
  const t0 = seen[0]!;

  // timing_sync: share of first-48h coverage inside the densest 6h window,
  // vs the uniform base rate 6/48. (Syndication-base-rate calibration is a
  // later refinement per R5 — the wire share below is the honest label.)
  const in48 = seen.filter((t) => t - t0 <= 48 * 3600_000);
  let densest = 0;
  for (const t of in48) {
    const c = in48.filter((u) => u >= t && u - t <= 6 * 3600_000).length;
    if (c > densest) densest = c;
  }
  const share6h = in48.length ? densest / in48.length : 0;
  const timingSync = Math.max(0, Math.min(1, (share6h - 0.125) / 0.875));

  // text_sim: mean pairwise cosine over up to 12 member embeddings
  const embs = rows
    .map((a) => (a.emb ? (JSON.parse(a.emb as string) as number[]) : null))
    .filter((e): e is number[] => !!e)
    .slice(0, 12);
  const cos = (x: number[], y: number[]) => {
    let d = 0, nx = 0, ny = 0;
    for (let i = 0; i < x.length; i++) { d += x[i]! * y[i]!; nx += x[i]! * x[i]!; ny += y[i]! * y[i]!; }
    return d / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
  };
  const pairSims: number[] = [];
  for (let i = 0; i < embs.length; i++)
    for (let j = i + 1; j < embs.length; j++) pairSims.push(cos(embs[i]!, embs[j]!));
  const meanSim = pairSims.length ? pairSims.reduce((a, b) => a + b, 0) / pairSims.length : SIM_FLOOR;
  // Rebased on the CLUSTER ADMISSION FLOOR: every member is >= LOOM_SIM_THRESHOLD
  // similar by construction, so a 0.5 zero-point handed even a perfectly organic
  // story a large permanent head start (review: ~+12-17 points on every
  // narrative). Zero now sits at "as similar as membership requires"; 1.0 at
  // near-verbatim copy, which is what R5 actually wants this component to mean.
  const textSim = Math.max(0, Math.min(1, (meanSim - SIM_FLOOR) / Math.max(0.05, SIM_TOP - SIM_FLOOR)));

  // provenance: share of member articles whose text hash or title matches a
  // wire release (verbatim wire copy) — this IS the syndication label (R5).
  // Wire matching is split into two INDEXED probes instead of one OR-join:
  // Postgres cannot use an index on either side of an OR, so the single query
  // degraded to a full scan of loom_wire_releases (which grows every 15 min)
  // for every narrative. The title probe is bounded to the wire window that
  // could plausibly have seeded this narrative.
  const wireWindowDays = Number(process.env.LOOM_WIRE_MATCH_DAYS || 21);
  const wire = await db.execute(sql`
    SELECT DISTINCT a.id
      FROM loom_articles a
      JOIN loom_wire_releases w ON a.text_hash = w.text_hash
     WHERE a.narrative_id = ${narrativeId}::uuid AND a.text_hash IS NOT NULL
    UNION
    SELECT DISTINCT a.id
      FROM loom_articles a
      JOIN loom_wire_releases w ON lower(w.title) = lower(a.title)
     WHERE a.narrative_id = ${narrativeId}::uuid
       AND a.title IS NOT NULL
       AND w.first_seen_at >= now() - make_interval(days => ${wireWindowDays})
  `);
  const wireMatchedIds = new Set(
    (wire as unknown as { rows: Array<{ id: string }> }).rows.map((w) => w.id)
  );
  const provenance = rows.length ? wireMatchedIds.size / rows.length : 0;

  // frame_homog: modal-share of the framing slots across framed members
  const framed = await db.execute(sql`
    SELECT f.protagonist, f.antagonist, f.threat
      FROM loom_framing f JOIN loom_articles a ON a.id = f.article_id
     WHERE a.narrative_id = ${narrativeId}::uuid
  `);
  const fr = (framed as unknown as { rows: Array<Record<string, string | null>> }).rows;
  let frameHomog = 0;
  let frame: Record<string, string> | null = null;
  // Modal share over 2 sampled articles is 0.5 or 1.0 — pure noise. Require a
  // real sample before the component contributes (it stays 0 otherwise, and
  // the frame chips simply don't render yet).
  if (fr.length >= FRAME_MIN_ROWS) {
    const slots = ["protagonist", "antagonist", "threat"] as const;
    const shares: number[] = [];
    frame = {};
    for (const s of slots) {
      const m = modal(fr.map((x) => x[s] || ""));
      shares.push(m.share);
      if (m.value) frame[s] = m.value;
    }
    frameHomog = shares.reduce((a, b) => a + b, 0) / shares.length;
  }

  const scoreOf = (t: number, ts: number, p: number, f: number) =>
    100 * (0.3 * t + 0.3 * ts + 0.25 * p + 0.15 * f);
  const score = scoreOf(timingSync, textSim, provenance, frameHomog);

  // Bootstrap CI over article resampling. Every ARTICLE-LEVEL component is
  // recomputed per draw (timing, text similarity, wire provenance) so the band
  // reflects the score's real sampling variability — resampling only the timing
  // leg published a CI far narrower than the number it labels.
  const wireFlags = rows.map((a) => wireMatchedIds.has(a.id as string));
  const boots: number[] = [];
  for (let b = 0; b < 200; b++) {
    const idx = Array.from({ length: seen.length }, () => Math.floor(Math.random() * seen.length));
    const bSeen = idx.map((i) => seen[i]!).sort((a, c) => a - c);
    const bt0 = bSeen[0]!;
    const bIn48 = bSeen.filter((t) => t - bt0 <= 48 * 3600_000);
    let bDense = 0;
    for (const t of bIn48) {
      const c = bIn48.filter((u) => u >= t && u - t <= 6 * 3600_000).length;
      if (c > bDense) bDense = c;
    }
    const bTiming = Math.max(0, Math.min(1, ((bIn48.length ? bDense / bIn48.length : 0) - 0.125) / 0.875));
    const bProv = idx.length ? idx.filter((i) => wireFlags[i]).length / idx.length : provenance;
    // resample the embedding pairs too (indices into the embs slice)
    const bPairs: number[] = [];
    if (embs.length >= 2) {
      for (let k = 0; k < pairSims.length; k++) bPairs.push(pairSims[Math.floor(Math.random() * pairSims.length)]!);
    }
    const bMean = bPairs.length ? bPairs.reduce((a, c) => a + c, 0) / bPairs.length : meanSim;
    const bText = Math.max(0, Math.min(1, (bMean - SIM_FLOOR) / Math.max(0.05, SIM_TOP - SIM_FLOOR)));
    boots.push(scoreOf(bTiming, bText, bProv, frameHomog));
  }
  boots.sort((a, b) => a - b);
  const ciLow = boots[Math.floor(0.05 * boots.length)] ?? score;
  const ciHigh = boots[Math.floor(0.95 * boots.length)] ?? score;

  return {
    score, ciLow, ciHigh,
    components: { timingSync, textSim, provenance, frameHomog },
    wireSharePct: 100 * provenance,
    firstMover: (rows[0]?.outlet as string) ?? null,
    frame,
  };
}

// --- R2 validator: the ONLY judgment write path -------------------------------
interface JudgmentInput {
  narrativeId: string; topH: string; topBand: string; runnerH: string;
  runnerBand: string; confidence: string; falsifiers: string[];
}

async function persistJudgment(j: JudgmentInput): Promise<void> {
  // R2: runner-up + >=1 falsifier or the judgment does not exist. Enforced
  // here, not in the UI.
  if (!j.topH || !j.runnerH || j.topH === j.runnerH) throw new Error("R2: judgment requires a distinct runner-up");
  if (!Array.isArray(j.falsifiers) || j.falsifiers.filter((f) => f?.trim()).length < 1)
    throw new Error("R2: judgment requires at least one falsifier");
  await db.insert(loomJudgments).values({
    narrativeId: j.narrativeId,
    topH: j.topH,
    topBand: j.topBand,
    runnerH: j.runnerH,
    runnerBand: j.runnerBand,
    confidence: j.confidence,
    falsifiers: j.falsifiers.filter((f) => f?.trim()).slice(0, 6),
  });
}

// --- the ACH pass -------------------------------------------------------------
export interface LoomIntentResult { scored: number; judgments: number; cost: number }

type Mark = Record<string, string> & { evidence?: number; rationale?: string };

export async function runIntent(): Promise<LoomIntentResult> {
  const r: LoomIntentResult = { scored: 0, judgments: 0, cost: 0 };

  // Score new promotions; re-score when the lifecycle moved after last scoring
  // (spec: ACH re-scoring on narrative state transitions).
  // Re-score on state transitions, but never more often than the cooldown and
  // never past the attempt cap — an unparseable narrative used to burn a paid
  // call every pass forever, and a flapping one could re-score hourly.
  const cooldownMin = Number(process.env.LOOM_ACH_COOLDOWN_MIN || 360);
  const targets = await db
    .select({
      id: loomNarratives.id,
      label: loomNarratives.label,
      summary: loomNarratives.summary,
      attempts: loomNarratives.achAttempts,
    })
    .from(loomNarratives)
    .where(
      and(
        isNotNull(loomNarratives.promotedAt),
        sql`${loomNarratives.achAttempts} < ${ACH_MAX_ATTEMPTS}`,
        sql`(${loomNarratives.achScoredAt} IS NULL
             OR (${loomNarratives.lastStateChangeAt} IS NOT NULL
                 AND ${loomNarratives.lastStateChangeAt} > ${loomNarratives.achScoredAt}
                 AND ${loomNarratives.achScoredAt} < now() - make_interval(mins => ${cooldownMin})))`
      )
    )
    .orderBy(desc(loomNarratives.lastSeenAt))
    .limit(ACH_BATCH);

  for (const n of targets) {
    const coord = await computeCoordination(n.id);
    if (!coord) continue;

    // persist coordination + frame onto the narrative (observable layer)
    await db
      .update(loomNarratives)
      .set({
        coordinationScore: coord.score,
        coordCiLow: coord.ciLow,
        coordCiHigh: coord.ciHigh,
        wireSharePct: coord.wireSharePct,
        firstMoverOutlet: coord.firstMover,
        frame: coord.frame ?? undefined,
      })
      .where(eq(loomNarratives.id, n.id));

    // assemble the evidence matrix (observables only)
    const instruments = await narrativeInstruments(n.id);
    const flags = await db.execute(sql`
      SELECT f.composite, f.placebo_pctl, i.symbol FROM loom_preposition_flags f
      JOIN loom_instruments i ON i.id = f.instrument_id WHERE f.narrative_id = ${n.id}::uuid
    `);
    const flagRows = (flags as unknown as { rows: Array<Record<string, unknown>> }).rows;
    const stats = await db.execute(sql`
      SELECT article_count, outlet_count, state FROM loom_narratives WHERE id = ${n.id}::uuid
    `);
    const st = (stats as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;

    const evidence: Array<{ kind: string; text: string }> = [
      {
        kind: "coordination",
        text: `Coordination ${coord.score.toFixed(0)}/100 (CI ${coord.ciLow.toFixed(0)}-${coord.ciHigh.toFixed(0)}): timing_sync ${coord.components.timingSync.toFixed(2)}, text_sim ${coord.components.textSim.toFixed(2)}, provenance ${coord.components.provenance.toFixed(2)}, frame_homog ${coord.components.frameHomog.toFixed(2)}`,
      },
      {
        kind: "provenance",
        text: `${coord.wireSharePct.toFixed(0)}% of coverage matches wire/PR copy verbatim; first mover: ${coord.firstMover ?? "unknown"}`,
      },
      {
        kind: "reach",
        text: `${st.article_count} articles across ${st.outlet_count} outlets; lifecycle state: ${st.state}`,
      },
    ];
    if (instruments.length)
      evidence.push({
        kind: "beneficiary",
        text: `Market-exposed instruments: ${instruments.slice(0, 4).map((i) => `${i.symbol} (${i.entity}, w=${i.weight.toFixed(2)})`).join(", ")}`,
      });
    for (const f of flagRows.slice(0, 2))
      evidence.push({
        kind: "preposition",
        text: `Pre-positioning flag on ${f.symbol}: composite ${Number(f.composite).toFixed(2)} at the ${Number(f.placebo_pctl).toFixed(0)}th percentile vs regime-matched placebo`,
      });

    const res = await callJSON<{
      marks: Mark[];
      falsifiers: string[];
      beneficiaries: Array<{ name: string; rationale: string; falsifier: string }>;
    }>(
      loomAchPrompt(
        { label: n.label || "(unlabeled)", summary: n.summary || "", frame: JSON.stringify(coord.frame ?? {}) },
        evidence
      ),
      { marks: [], falsifiers: [], beneficiaries: [] },
      { tier: "sonnet", agent: "loom-ach", maxTokens: 2000 }
    );
    r.cost += res.cost;
    if (res.offline) continue; // free (paused/over-budget) — retry next pass
    if (!res.parsed || !res.data.marks?.length) {
      // Paid but unusable (parse failure / truncation): count it against the cap.
      await db
        .update(loomNarratives)
        .set({ achAttempts: sql`ach_attempts + 1` })
        .where(eq(loomNarratives.id, n.id));
      continue;
    }

    // ACH scoring: LEAST-INCONSISTENT wins (spec M8). Inconsistency is the only
    // thing that eliminates a hypothesis; consistency is nearly free evidence
    // (many hypotheses predict the same observable), so it must not be able to
    // outweigh an I mark — it acts as a tiebreak among equally-uneliminated
    // hypotheses only.
    const codes = Object.keys(LOOM_HYPOTHESES);
    const inconsistency = new Map<string, number>(codes.map((c) => [c, 0]));
    const consistency = new Map<string, number>(codes.map((c) => [c, 0]));
    for (const m of res.data.marks) {
      for (const c of codes) {
        const v = String(m[c] ?? "N").toUpperCase();
        if (v === "I") inconsistency.set(c, inconsistency.get(c)! + 1);
        else if (v === "C") consistency.set(c, consistency.get(c)! + 1);
      }
    }
    // score = -(I count) with a small consistency tiebreak strictly inside one I unit
    const scores = new Map<string, number>(
      codes.map((c) => [c, -inconsistency.get(c)! + Math.min(0.9, 0.1 * consistency.get(c)!)])
    );
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

    // Estimative probability: softmax with a temperature, so the LEADING
    // hypothesis is never published below "roughly even chance" when it is
    // genuinely leading (raw-score softmax routinely emitted "unlikely" for the
    // winner because 7 hypotheses split the mass).
    const temp = Number(process.env.LOOM_ACH_TEMP || 0.6);
    const exps = ranked.map(([, sc]) => Math.exp((sc - ranked[0]![1]) / temp));
    const z = exps.reduce((a, b) => a + b, 0) || 1;
    const pTop = Math.max(0.5, exps[0]! / z); // the winner is at least even odds
    const pRunner = Math.min(1 - pTop, exps[1]! / z);
    const gap = ranked[0]![1] - ranked[1]![1];
    const confidence = res.data.marks.length >= 5 && gap >= 2 ? "high" : res.data.marks.length >= 3 && gap >= 1 ? "moderate" : "low";

    // persist observables + inference
    for (let i = 0; i < ranked.length; i++) {
      await db
        .insert(loomHypotheses)
        .values({ narrativeId: n.id, code: ranked[i]![0], score: ranked[i]![1], rank: i + 1 })
        .onConflictDoUpdate({
          target: [loomHypotheses.narrativeId, loomHypotheses.code],
          set: { score: ranked[i]![1], rank: i + 1 },
        });
    }
    // Marks carry their OWN 1-based evidence index — zipping by array position
    // silently attached each mark to the wrong evidence item whenever the model
    // reordered, skipped, or merged rows. Fall back to position only when the
    // index is absent.
    await db.delete(loomEvidence).where(eq(loomEvidence.narrativeId, n.id)); // re-score replaces the matrix
    for (let i = 0; i < res.data.marks.length; i++) {
      const mark = res.data.marks[i]!;
      const idx = Number(mark.evidence);
      const ev = Number.isFinite(idx) && idx >= 1 && idx <= evidence.length ? evidence[idx - 1]! : evidence[i];
      if (!ev) continue;
      await db.insert(loomEvidence).values({
        narrativeId: n.id,
        kind: ev.kind,
        payload: { text: ev.text, evidenceIndex: Number.isFinite(idx) ? idx : i + 1 },
        consistency: mark,
      });
    }
    let judged = false;
    try {
      await persistJudgment({
        narrativeId: n.id,
        topH: ranked[0]![0],
        topBand: icdBand(pTop),
        runnerH: ranked[1]![0],
        runnerBand: icdBand(pRunner),
        confidence,
        falsifiers: res.data.falsifiers ?? [],
      });
      r.judgments++;
      judged = true;
    } catch (e) {
      // R2 rejected it (missing falsifiers) or the write failed. Either way the
      // narrative must stay eligible for another attempt rather than being
      // buried by the achScoredAt stamp below — a terminal lifecycle state
      // would otherwise mean it is never reconsidered. Log the reason.
      console.error(`[loom-ach] judgment not persisted for ${n.id}:`, (e as Error).message);
    }

    await db.delete(loomBeneficiaries).where(eq(loomBeneficiaries.narrativeId, n.id));
    let rank = 1;
    for (const b of (res.data.beneficiaries ?? []).slice(0, 3)) {
      if (!b.name?.trim() || !b.falsifier?.trim()) continue; // each row needs its falsifier (R7)
      await db.insert(loomBeneficiaries).values({
        narrativeId: n.id,
        name: b.name.trim().slice(0, 140),
        rationale: (b.rationale || "").slice(0, 400) || null,
        falsifier: b.falsifier.trim().slice(0, 300),
        rank: rank++,
      });
    }

    // Stamp the scoring time either way (observables were persisted), but count
    // an unjudged pass against the attempt cap so a narrative that can never
    // produce an R2-complete judgment stops consuming the batch.
    await db
      .update(loomNarratives)
      .set({ achScoredAt: sql`now()`, achAttempts: judged ? 0 : sql`ach_attempts + 1` })
      .where(eq(loomNarratives.id, n.id));
    r.scored++;
  }

  return r;
}
