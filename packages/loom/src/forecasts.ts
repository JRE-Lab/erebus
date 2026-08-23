// ============================================================================
// LOOM M11 (Phase 4) — pre-registered forecasts + scoring.
// R3: loom_forecasts is append-only — issuance is the only write; resolution
// writes to loom_resolutions. Every row stamps regime_at_issue and model_ver.
// Heads (MVP, hand-set priors per spec M6/M7 until the analog matcher lands):
//   lifecycle    — "reaches peak within 72h", issued when a narrative enters
//                  amplifying; resolved from the transition log.
//   market_move  — direction/magnitude on the top exposed instrument over 7
//                  calendar days; resolved on adjusted closes.
// preposition claims + contract_odds (Kalshi) are v2 (documented).
// R6: the scoreboard compares each head's rolling Brier to the climatological
// base rate; a losing head is marked advisory.
// ============================================================================
import { sql } from "drizzle-orm";
import { db, loomForecasts, loomResolutions } from "@erebus/db";
import { narrativeInstruments } from "./entities.js";
import { priceSeries } from "./pricing.js";

const LIFECYCLE_PRIOR = Number(process.env.LOOM_LIFECYCLE_PRIOR || 0.45);
const MARKET_PRIOR = Number(process.env.LOOM_MARKET_PRIOR || 0.55);
const MODEL_VER = "loom-phase4-mvp-1";

// Postgres timestamptz columns arrive as JS Date objects through node-postgres
// unless selected ::text. Normalize either shape to an ISO calendar day.
function isoDay(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
}

async function currentRegime(): Promise<string> {
  const res = await db.execute(sql`SELECT state FROM loom_regimes ORDER BY date DESC LIMIT 1`);
  return ((res as unknown as { rows: Array<{ state: string }> }).rows[0]?.state) ?? "neutral";
}

export interface LoomForecastResult { lifecycle: number; market: number }

export async function issueForecasts(): Promise<LoomForecastResult> {
  const r: LoomForecastResult = { lifecycle: 0, market: 0 };
  const regime = await currentRegime();

  // Lifecycle head: amplifying transitions with no claim covering THAT
  // transition. The lookback is generous (a missed pass must not silently drop
  // the claim — R3 forbids backfilling one later), and the anti-join keys on
  // the transition id rather than "any open window", so each transition gets
  // exactly one claim.
  const lookbackHours = Number(process.env.LOOM_ISSUE_LOOKBACK_HOURS || 24);
  const amps = await db.execute(sql`
    SELECT t.id AS transition_id, t.narrative_id, t.at
      FROM loom_narrative_transitions t
     WHERE t.to_state = 'amplifying'
       AND t.at > now() - make_interval(hours => ${lookbackHours})
       AND NOT EXISTS (
         SELECT 1 FROM loom_forecasts f
          WHERE f.narrative_id = t.narrative_id AND f.claim_type = 'lifecycle'
            AND (f.target_ref->>'transitionId') = t.id::text
       )
     ORDER BY t.at ASC
  `);
  for (const row of (amps as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    // R1: the 72h window runs from the OBSERVED transition, not from issuance —
    // a delayed pass would otherwise shift the window and could resolve a claim
    // false for a peak that happened inside the real window.
    const at = new Date(row.at as string);
    await db.insert(loomForecasts).values({
      narrativeId: row.narrative_id as string,
      claimType: "lifecycle",
      targetRef: { toState: "peak", withinHours: 72, transitionId: row.transition_id as string },
      windowStart: at,
      windowEnd: new Date(at.getTime() + 72 * 3600_000),
      prob: LIFECYCLE_PRIOR,
      regimeAtIssue: regime,
      modelVer: MODEL_VER,
    });
    r.lifecycle++;

  }

  // Market head: issued for any recently-amplifying narrative that has market
  // exposure and no open claim. Kept in its OWN loop because entity resolution
  // lags promotion by a pass or two — tying it to the lifecycle-insert
  // iteration meant a narrative whose tickers arrived later never got one.
  const marketTargets = await db.execute(sql`
    SELECT DISTINCT t.narrative_id
      FROM loom_narrative_transitions t
     WHERE t.to_state = 'amplifying'
       AND t.at > now() - make_interval(hours => ${Number(process.env.LOOM_MARKET_ISSUE_HOURS || 72)})
  `);
  for (const row of (marketTargets as unknown as { rows: Array<{ narrative_id: string }> }).rows) {
    const inst = (await narrativeInstruments(row.narrative_id))[0];
    if (inst) {
      const open = await db.execute(sql`
        SELECT 1 FROM loom_forecasts
         WHERE narrative_id = ${row.narrative_id}::uuid AND claim_type = 'market_move'
           AND (target_ref->>'instrument') = ${inst.symbol} AND window_end > now()
         LIMIT 1
      `);
      if (!(open as unknown as { rows: unknown[] }).rows.length) {
        // direction from the event-window abnormal return when available,
        // else the pre-window residual drift; both are observables.
        const dir = await db.execute(sql`
          SELECT COALESCE(s.car_event, s.car_pre) AS sig FROM loom_event_studies s
           JOIN loom_instruments i ON i.id = s.instrument_id
          WHERE s.narrative_id = ${row.narrative_id}::uuid AND i.symbol = ${inst.symbol}
          LIMIT 1
        `);
        const sig = Number((dir as unknown as { rows: Array<{ sig: unknown }> }).rows[0]?.sig ?? 0);
        const direction = sig >= 0 ? "up" : "down";
        await db.insert(loomForecasts).values({
          narrativeId: row.narrative_id,
          claimType: "market_move",
          targetRef: { instrument: inst.symbol, instrumentId: inst.instrumentId },
          direction,
          magnitudeBand: "1-3%",
          windowStart: new Date(),
          windowEnd: new Date(Date.now() + 7 * 86_400_000),
          prob: regime === "risk_off" ? Math.max(0.5, MARKET_PRIOR - 0.05) : MARKET_PRIOR,
          regimeAtIssue: regime,
          modelVer: MODEL_VER,
        });
        r.market++;
      }
    }
  }
  return r;
}

// --- resolution (daily) -------------------------------------------------------
export interface LoomResolveResult { resolved: number; pending: number }

export async function resolveLoomForecasts(): Promise<LoomResolveResult> {
  const r: LoomResolveResult = { resolved: 0, pending: 0 };
  // Only claim types this resolver understands, oldest first. Without both,
  // permanently-unresolvable rows (playbook_match had no branch at all) filled
  // the LIMIT and starved every newer claim of resolution forever.
  const due = await db.execute(sql`
    SELECT f.id, f.narrative_id, f.claim_type, f.target_ref, f.direction, f.magnitude_band,
           f.window_start::text AS window_start, f.window_end::text AS window_end, f.prob
      FROM loom_forecasts f
     WHERE f.window_end <= now()
       AND f.claim_type IN ('lifecycle', 'market_move', 'playbook_match')
       AND NOT EXISTS (SELECT 1 FROM loom_resolutions res WHERE res.forecast_id = f.id)
     ORDER BY f.window_end ASC
     LIMIT 40
  `);

  for (const f of (due as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const prob = Number(f.prob);
    let outcome: boolean | null = null;

    if (f.claim_type === "lifecycle") {
      const target = (f.target_ref as { toState?: string }).toState ?? "peak";
      const hit = await db.execute(sql`
        SELECT 1 FROM loom_narrative_transitions t
         WHERE t.narrative_id = ${f.narrative_id as string}::uuid
           AND t.to_state = ${target}
           AND t.at >= ${f.window_start as string} AND t.at <= ${f.window_end as string}
         LIMIT 1
      `);
      outcome = !!(hit as unknown as { rows: unknown[] }).rows.length;
    } else if (f.claim_type === "market_move") {
      const symbol = (f.target_ref as { instrument?: string }).instrument;
      if (symbol) {
        const series = await priceSeries(symbol);
        // window_start/end come back as ::text (ISO) from the query above.
        // Formatting a JS Date with String() yields "Mon Aug 24 2026 ..." and
        // every string comparison against ISO price dates failed, leaving all
        // market claims permanently pending.
        const startDate = isoDay(f.window_start);
        const endDate = isoDay(f.window_end);
        const startBar = series.filter((p) => p.date <= startDate).at(-1);
        const endBar = series.filter((p) => p.date <= endDate).at(-1);
        if (startBar && endBar && endBar.date > startBar.date) {
          const move = endBar.close / startBar.close - 1;
          const minMag = Number(String(f.magnitude_band ?? "1-3%").match(/([\d.]+)/)?.[1] ?? 1) / 100;
          outcome = (f.direction === "up" ? move : -move) >= minMag;
        }
        // else: prices not caught up yet — leave pending, retried tomorrow
      }
    } else if (f.claim_type === "playbook_match") {
      // A playbook match predicts that the matched narrative actually becomes a
      // real, sustained story rather than a one-off token collision. It
      // resolves TRUE if the narrative reached amplifying-or-later inside the
      // window (spec M9: matches are scored, non-matches decay confidence).
      const hit = await db.execute(sql`
        SELECT 1 FROM loom_narrative_transitions t
         WHERE t.narrative_id = ${f.narrative_id as string}::uuid
           AND t.to_state IN ('amplifying', 'peak')
           AND t.at >= ${f.window_start as string}::timestamptz
           AND t.at <= ${f.window_end as string}::timestamptz
         LIMIT 1
      `);
      outcome = !!(hit as unknown as { rows: unknown[] }).rows.length;
    }

    if (outcome == null) { r.pending++; continue; }
    await db.insert(loomResolutions).values({
      forecastId: f.id as string,
      outcome,
      brier: (prob - (outcome ? 1 : 0)) ** 2,
    });
    r.resolved++;
  }
  return r;
}

// --- scoreboard (R6) ----------------------------------------------------------
export interface LoomHeadScore {
  claimType: string; n: number; meanBrier: number; baseRate: number;
  climatologyBrier: number; status: "live" | "advisory";
}

export async function loomScoreboard(): Promise<LoomHeadScore[]> {
  const res = await db.execute(sql`
    SELECT f.claim_type,
           count(*)::int AS n,
           avg(res.brier) AS mean_brier,
           avg(CASE WHEN res.outcome THEN 1.0 ELSE 0.0 END) AS base_rate
      FROM loom_resolutions res JOIN loom_forecasts f ON f.id = res.forecast_id
     WHERE res.resolved_at > now() - interval '90 days'
     GROUP BY f.claim_type
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => {
    const n = Number(row.n);
    const meanBrier = Number(row.mean_brier);
    const baseRate = Number(row.base_rate);
    // Brier of always forecasting the climatological base rate p: p(1-p).
    const climatologyBrier = baseRate * (1 - baseRate);
    return {
      claimType: row.claim_type as string,
      n,
      meanBrier,
      baseRate,
      climatologyBrier,
      status: n >= 10 && meanBrier > climatologyBrier ? ("advisory" as const) : ("live" as const),
    };
  });
}
