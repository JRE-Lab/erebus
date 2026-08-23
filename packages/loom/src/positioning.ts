// ============================================================================
// LOOM M5 (Phase 3) — positioning detectors, regime conditioner, placebo
// engine, pre-positioning flags.
//
// Detectors (MVP, documented cuts in schema.ts):
//   vol_z     — volume z-score vs trailing 60d           (full)
//   resid_ret — residual daily return vs market model    (full)
//   insider   — EDGAR Form-4 filing-count z proxy        (weaker proxy, free)
//   si_delta / options detectors                          (v2, always NULL)
//
// R4 discipline: a pre-positioning flag CANNOT be written without its placebo
// percentile (NOT NULL column) — the composite is reported as lift vs the
// same composite on random instrument-date draws, stratified by regime.
// Everything here is free (stored prices + SEC atom feeds + arithmetic).
// ============================================================================
import { sql } from "drizzle-orm";
import { db, loomPositioning, loomRegimes, loomPlaceboRuns, loomPrepositionFlags } from "@erebus/db";
import { priceSeries } from "./pricing.js";

const VOL_LOOKBACK = 60;
const MODEL_DAYS = 120;
// A year of scored days: the placebo engine (R4) needs a deep pool of
// instrument-date draws per regime, and a 30-day window could never fill one.
const DETECTOR_DAYS = Number(process.env.LOOM_DETECTOR_DAYS || 250);
// Each day is scored by a model fitted on the 120 trading days ENDING 11 days
// before it — the same out-of-sample convention as the event study. One shared
// model for the whole window made recent residuals in-sample (shrunk toward 0)
// and stale for the older ones.
const MODEL_GAP = 11;
const THRESH_VOLZ = Number(process.env.LOOM_THRESH_VOLZ || 2.0);
const THRESH_RESID = Number(process.env.LOOM_THRESH_RESID || 0.05); // |cum abnormal| over the window
const THRESH_INSIDER = Number(process.env.LOOM_THRESH_INSIDER || 2.0);
const PLACEBO_SAMPLES = Number(process.env.LOOM_PLACEBO_SAMPLES || 1000);
const INSIDER_BATCH = Number(process.env.LOOM_INSIDER_BATCH || 15); // companies per pass (SEC politeness)

// --- shared math -------------------------------------------------------------
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
function olsAB(y: number[], x: number[]): { alpha: number; beta: number } {
  const n = Math.min(y.length, x.length);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]!; sy += y[i]!; sxx += x[i]! * x[i]!; sxy += x[i]! * y[i]!; }
  const denom = n * sxx - sx * sx;
  const beta = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  return { alpha: (sy - beta * sx) / n, beta };
}
function phi(z: number): number {
  // standard normal CDF (Abramowitz-Stegun) — placebo percentile fallback
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// --- 1) daily detectors ------------------------------------------------------
export interface LoomPositioningResult { instruments: number; rowsUpserted: number }

export async function computePositioning(): Promise<LoomPositioningResult> {
  const r: LoomPositioningResult = { instruments: 0, rowsUpserted: 0 };
  const spy = await priceSeries("SPY");
  if (spy.length < VOL_LOOKBACK) return r;
  const spyByDate = new Map(spy.map((p) => [p.date, p.close]));

  const instruments = await db.execute(sql`
    SELECT id, symbol FROM loom_instruments WHERE symbol NOT IN ('^VIX')
  `);
  for (const inst of (instruments as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const series = await priceSeries(inst.symbol as string);
    if (series.length < VOL_LOOKBACK + 5) continue;
    const aligned = series.filter((p) => spyByDate.has(p.date));
    const dates = aligned.map((p) => p.date);
    const closes = aligned.map((p) => p.close);
    const vols = aligned.map((p) => p.volume ?? 0);
    const mCloses = dates.map((d) => spyByDate.get(d)!);

    const ret = (xs: number[], k: number) => xs[k]! / xs[k - 1]! - 1;

    // Score the trailing DETECTOR_DAYS trading days, each with its OWN model
    // fitted on [k-11-120, k-11) — strictly out of sample for day k.
    const from = Math.max(VOL_LOOKBACK, MODEL_GAP + 31, dates.length - DETECTOR_DAYS);
    const pending: Array<{ instrumentId: string; date: string; volZ: number | null; residRet: number | null }> = [];
    for (let k = from; k < dates.length; k++) {
      const volWin = vols.slice(k - VOL_LOOKBACK, k).filter((v) => v > 0);
      const volZ = volWin.length >= 20 && sd(volWin) > 0 ? ((vols[k] ?? 0) - mean(volWin)) / sd(volWin) : null;

      const estEnd = k - MODEL_GAP;
      const estStart = Math.max(1, estEnd - MODEL_DAYS);
      let residRet: number | null = null;
      if (estEnd - estStart >= 30) {
        const yEst: number[] = [], xEst: number[] = [];
        for (let j = estStart; j < estEnd; j++) { yEst.push(ret(closes, j)); xEst.push(ret(mCloses, j)); }
        const { alpha, beta } = olsAB(yEst, xEst);
        residRet = ret(closes, k) - (alpha + beta * ret(mCloses, k));
      }
      pending.push({ instrumentId: inst.id as string, date: dates[k]!, volZ, residRet });
    }

    // Chunked upsert — a year of days per instrument is far too many round-trips.
    for (let i = 0; i < pending.length; i += 400) {
      const chunk = pending.slice(i, i + 400);
      await db
        .insert(loomPositioning)
        .values(chunk)
        .onConflictDoUpdate({
          target: [loomPositioning.instrumentId, loomPositioning.date],
          set: { volZ: sql`excluded.vol_z`, residRet: sql`excluded.resid_ret` },
        });
      r.rowsUpserted += chunk.length;
    }
    r.instruments++;
  }
  return r;
}

// --- 1b) insider proxy (EDGAR Form-4 filing counts; companies with CIK) -----
export interface LoomInsiderResult { companies: number; scored: number; errors: number }

export async function computeInsiderProxy(): Promise<LoomInsiderResult> {
  const r: LoomInsiderResult = { companies: 0, scored: 0, errors: 0 };
  // Rotate by staleness so every company eventually gets scored — a bare LIMIT
  // with no ORDER BY froze the same arbitrary 15 rows forever.
  const targets = await db.execute(sql`
    SELECT e.cik, i.id AS instrument_id,
           (SELECT max(p.date) FROM loom_positioning p
             WHERE p.instrument_id = i.id AND p.insider_score IS NOT NULL) AS scored_at
      FROM loom_entities e
      JOIN loom_exposures x ON x.entity_id = e.id AND x.kind = 'direct'
      JOIN loom_instruments i ON i.id = x.instrument_id
     WHERE e.kind = 'company' AND e.cik IS NOT NULL
     ORDER BY scored_at ASC NULLS FIRST
     LIMIT ${INSIDER_BATCH}
  `);
  for (const t of (targets as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    try {
      const cik = String(t.cik).padStart(10, "0");
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=100&output=atom`;
      const res = await fetch(url, {
        headers: { "user-agent": "EREBUS-LOOM research jrelliott093@gmail.com" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const xml = await res.text();
      // Only <entry> blocks are filings. The feed carries a document-level
      // <updated> stamp too, and counting it made a company with ZERO filings
      // look like it had one in the last 10 days — firing the detector on
      // silence (review-confirmed).
      const entries = xml.split(/<entry[\s>]/).slice(1);
      const stamps = entries
        .map((e) => /<filing-date>([\d-]+)<\/filing-date>/.exec(e)?.[1] ?? /<updated>([\d-]+)T/.exec(e)?.[1])
        .filter((d): d is string => !!d);
      const now = Date.now();
      const in10d = stamps.filter((s) => now - Date.parse(s) <= 10 * 86_400_000).length;
      const in90d = stamps.filter((s) => now - Date.parse(s) <= 90 * 86_400_000).length;
      // Poisson-style burst score on a COMMON 10-day basis: observed filings in
      // the last 10 days vs the expected count from the 90-day rate. The feed is
      // capped at 100 entries, so a company that hit the cap has a truncated
      // (under-stated) base rate — those are skipped rather than over-scored.
      if (entries.length >= 100 && in90d >= 100) { r.companies++; continue; }
      const expected10 = Math.max(0.2, (in90d * 10) / 90);
      const score = (in10d - expected10) / Math.sqrt(expected10);
      const today = new Date().toISOString().slice(0, 10);
      await db
        .insert(loomPositioning)
        .values({ instrumentId: t.instrument_id as string, date: today, insiderScore: score })
        .onConflictDoUpdate({
          target: [loomPositioning.instrumentId, loomPositioning.date],
          set: { insiderScore: score },
        });
      r.scored++;
      await new Promise((res2) => setTimeout(res2, 400)); // SEC politeness
    } catch {
      r.errors++;
    }
    r.companies++;
  }
  return r;
}

// --- 2) regime conditioner (threshold MVP, spec M6) --------------------------
export interface LoomRegimeResult { days: number }

export async function computeRegimes(): Promise<LoomRegimeResult> {
  const vix = await priceSeries("^VIX");
  let days = 0;
  // Regimes must cover every day the detectors score, or the placebo pool
  // (which joins positioning to regimes by date) can never reach usable depth.
  const span = Number(process.env.LOOM_REGIME_DAYS || DETECTOR_DAYS + 60);
  for (let k = Math.max(5, vix.length - span); k < vix.length; k++) {
    const v = vix[k]!.close;
    const trend = v - vix[k - 5]!.close;
    // documented MVP thresholds: HY OAS / breadth join later
    const state = v >= 25 || (v >= 20 && trend > 0) ? "risk_off" : v <= 15 || (v < 18 && trend < 0) ? "risk_on" : "neutral";
    // No bare catch here: a silently failing regime write disables placebo
    // stratification and every downstream flag while the pass still reports
    // success. Let it throw — the tick wrapper logs and the next pass retries.
    await db
      .insert(loomRegimes)
      .values({ date: vix[k]!.date, state, vix: v, vixTrend: trend })
      .onConflictDoUpdate({ target: [loomRegimes.date], set: { state, vix: v, vixTrend: trend } });
    days++;
  }
  return { days };
}

// --- 3) composite over a window ---------------------------------------------
interface WindowDetectors { volZMax: number | null; residCum: number | null; insiderMax: number | null; rows: number }
const MIN_WINDOW_ROWS = Number(process.env.LOOM_MIN_WINDOW_ROWS || 5); // trading days needed for a usable window

async function windowDetectors(instrumentId: string, start: string, end: string): Promise<WindowDetectors> {
  const res = await db.execute(sql`
    SELECT max(vol_z) AS vol_z_max, sum(resid_ret) AS resid_cum, max(insider_score) AS insider_max,
           count(*) AS n
      FROM loom_positioning
     WHERE instrument_id = ${instrumentId}::uuid AND date >= ${start} AND date <= ${end}
  `);
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
  if (!row || Number(row.n) === 0) return { volZMax: null, residCum: null, insiderMax: null, rows: 0 };
  return {
    volZMax: row.vol_z_max == null ? null : Number(row.vol_z_max),
    residCum: row.resid_cum == null ? null : Number(row.resid_cum),
    insiderMax: row.insider_max == null ? null : Number(row.insider_max),
    rows: Number(row.n) || 0,
  };
}

// Composite = sum of threshold-normalized detector strengths; `fired` counts
// detectors clearing their thresholds (>=2 required for a flag, spec M5).
function composite(d: WindowDetectors): { score: number; fired: number } {
  let score = 0, fired = 0;
  if (d.volZMax != null) { score += Math.max(0, d.volZMax) / THRESH_VOLZ; if (d.volZMax >= THRESH_VOLZ) fired++; }
  if (d.residCum != null) { score += Math.abs(d.residCum) / THRESH_RESID; if (Math.abs(d.residCum) >= THRESH_RESID) fired++; }
  if (d.insiderMax != null) { score += Math.max(0, d.insiderMax) / THRESH_INSIDER; if (d.insiderMax >= THRESH_INSIDER) fired++; }
  return { score, fired };
}

// --- 4) placebo engine (R4) --------------------------------------------------
export interface LoomPlaceboResult { regimes: number; samplesPerRegime: number; thin: string[] }

export async function runPlacebo(): Promise<LoomPlaceboResult> {
  const states = ["risk_on", "neutral", "risk_off"];
  const thin: string[] = [];
  let regimes = 0;
  for (const state of states) {
    // candidate (instrument, date) pool: positioning rows whose date carries this regime
    const pool = await db.execute(sql`
      SELECT p.instrument_id, p.date::text AS date
        FROM loom_positioning p JOIN loom_regimes r ON r.date = p.date
       WHERE r.state = ${state}
    `);
    const rows = (pool as unknown as { rows: Array<Record<string, unknown>> }).rows;
    if (rows.length < 50) {
      // Not enough instrument-date history in this regime yet. Reported rather
      // than silent: with no placebo run, R4 blocks every flag in this regime.
      thin.push(`${state}:${rows.length}`);
      continue;
    }

    const scores: number[] = [];
    let attempts = 0;
    while (scores.length < PLACEBO_SAMPLES && attempts < PLACEBO_SAMPLES * 4) {
      attempts++;
      const pick = rows[Math.floor(Math.random() * rows.length)]!;
      const end = pick.date as string;
      const start = new Date(Date.parse(end) - 9 * 86_400_000).toISOString().slice(0, 10);
      const d = await windowDetectors(pick.instrument_id as string, start, end);
      // A window truncated by the instrument's history start has fewer rows and
      // a mechanically smaller composite; including those biases the null low
      // and inflates every real flag's percentile (R4 integrity).
      if (d.rows < MIN_WINDOW_ROWS) continue;
      scores.push(composite(d).score);
    }
    if (scores.length < 100) { thin.push(`${state}:${scores.length}/usable`); continue; }
    scores.sort((a, b) => a - b);
    const q = (p: number) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))]!;
    await db.insert(loomPlaceboRuns).values({
      regimeState: state,
      samples: scores.length,
      mean: mean(scores),
      sd: sd(scores),
      quantiles: { p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99) },
    });
    regimes++;
  }
  return { regimes, samplesPerRegime: PLACEBO_SAMPLES, thin };
}

// Percentile of a composite against the latest placebo run for a regime.
// Empirical quantiles first; normal approximation between grid points.
async function placeboPercentile(score: number, regime: string): Promise<number | null> {
  const res = await db.execute(sql`
    SELECT mean, sd, quantiles FROM loom_placebo_runs
     WHERE regime_state = ${regime}
     ORDER BY created_at DESC LIMIT 1
  `);
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
  if (!row) return null; // no placebo yet -> NO flag can be written (R4)
  // Piecewise-linear over the stored empirical grid, anchored at 0 so the curve
  // is CONTINUOUS end to end (the old form fell through to a normal
  // approximation below p90, which could jump ~20 points across that boundary).
  const qs = row.quantiles as Record<string, number>;
  const grid: Array<[number, number]> = [[0, 0]];
  for (const [pct, key] of [[50, "p50"], [75, "p75"], [90, "p90"], [95, "p95"], [99, "p99"]] as const) {
    const v = qs[key];
    if (typeof v === "number" && Number.isFinite(v)) grid.push([v, pct]);
  }
  grid.sort((a, b) => a[0] - b[0]);
  if (grid.length < 2) return 50;
  const top = grid[grid.length - 1]!;
  if (score >= top[0]) {
    // Above the top knot: extrapolate with the normal tail, never below it.
    const m = Number(row.mean), sd2 = Number(row.sd);
    const z = Number.isFinite(m) && Number.isFinite(sd2) && sd2 > 0 ? 100 * phi((score - m) / sd2) : top[1];
    return Math.max(top[1], Math.min(99.9, z));
  }
  for (let i = 1; i < grid.length; i++) {
    const [x0, y0] = grid[i - 1]!;
    const [x1, y1] = grid[i]!;
    if (score < x1) {
      const t = x1 === x0 ? 0 : (score - x0) / (x1 - x0);
      return Math.max(0, Math.min(99.9, y0 + t * (y1 - y0)));
    }
  }
  return 50;
}

// --- 5) pre-positioning flags ------------------------------------------------
export interface LoomFlagResult { evaluated: number; flagged: number; noPlacebo: number }

export async function flagPrepositions(): Promise<LoomFlagResult> {
  const r: LoomFlagResult = { evaluated: 0, flagged: 0, noPlacebo: 0 };
  const targets = await db.execute(sql`
    SELECT n.id AS narrative_id, n.seeded_at::date::text AS t,
           i.id AS instrument_id, i.symbol
      FROM loom_narratives n
      JOIN loom_narrative_entities ne ON ne.narrative_id = n.id
      JOIN loom_exposures x ON x.entity_id = ne.entity_id
      JOIN loom_instruments i ON i.id = x.instrument_id
     WHERE n.promoted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM loom_preposition_flags f
                        WHERE f.narrative_id = n.id AND f.instrument_id = i.id)
     GROUP BY n.id, n.seeded_at, i.id, i.symbol
     ORDER BY n.seeded_at DESC
     LIMIT 30
  `);

  for (const t of (targets as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const eventDate = t.t as string;
    const end = new Date(Date.parse(eventDate) - 1 * 86_400_000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(eventDate) - 10 * 86_400_000).toISOString().slice(0, 10);
    const d = await windowDetectors(t.instrument_id as string, start, end);
    const { score, fired } = composite(d);
    r.evaluated++;
    if (d.rows < MIN_WINDOW_ROWS) continue; // window not covered by stored detectors
    if (fired < 2) continue; // spec: >=2 independent detectors must clear

    const regRes = await db.execute(sql`SELECT state FROM loom_regimes WHERE date <= ${eventDate} ORDER BY date DESC LIMIT 1`);
    const regime = ((regRes as unknown as { rows: Array<{ state: string }> }).rows[0]?.state) ?? "neutral";
    const pctl = await placeboPercentile(score, regime);
    if (pctl == null) { r.noPlacebo++; continue; } // R4: no placebo, no flag

    await db
      .insert(loomPrepositionFlags)
      .values({
        narrativeId: t.narrative_id as string,
        instrumentId: t.instrument_id as string,
        windowStart: start,
        windowEnd: end,
        composite: score,
        detectors: { ...d, fired, regime, symbol: t.symbol },
        placeboPctl: pctl,
      })
      .onConflictDoNothing();
    r.flagged++;
  }
  return r;
}
