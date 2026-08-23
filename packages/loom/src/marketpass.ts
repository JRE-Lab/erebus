// ============================================================================
// LOOM market pass (Phases 2-3 heavy work, its own cadence + advisory lock):
//   prices -> detectors -> insider proxy -> regimes -> event studies ->
//   placebo (daily-gated) -> pre-positioning flags -> forecast resolution
// Everything here is FREE (stored prices, SEC atom feeds, arithmetic) — no
// LLM, no embeddings — so the tick runs ungated like ingest.
// ============================================================================
import { sql } from "drizzle-orm";
import { pool, db } from "@erebus/db";
import { refreshLoomPrices } from "./pricing.js";
import { computePositioning, computeInsiderProxy, computeRegimes, runPlacebo, flagPrepositions } from "./positioning.js";
import { runEventStudies } from "./events.js";
import { resolveLoomForecasts } from "./forecasts.js";

const LOCK_KEY = 427002;

export interface LoomMarketPassResult {
  prices: number;
  positioningRows: number;
  insiderScored: number;
  regimeDays: number;
  eventStudies: number;
  placeboRegimes: number;
  placeboThin: string[]; // regimes with too little history to build a null yet
  flags: number;
  forecastsResolved: number;
  errors: string[];
  skipped?: string;
}

export async function runLoomMarketPass(): Promise<LoomMarketPassResult> {
  const r: LoomMarketPassResult = {
    prices: 0, positioningRows: 0, insiderScored: 0, regimeDays: 0,
    eventStudies: 0, placeboRegimes: 0, placeboThin: [], flags: 0, forecastsResolved: 0, errors: [],
  };
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS ok`);
    if (!lock.rows[0]?.ok) return { ...r, skipped: "market pass already in progress" };
    try {
      const px = await refreshLoomPrices();
      r.prices = px.instruments;
      r.errors.push(...px.errors.slice(0, 3));

      const pos = await computePositioning();
      r.positioningRows = pos.rowsUpserted;

      const ins = await computeInsiderProxy();
      r.insiderScored = ins.scored;

      r.regimeDays = (await computeRegimes()).days;

      const ev = await runEventStudies();
      r.eventStudies = ev.computed + ev.pending;

      // Placebo is the expensive block (N window aggregations per regime) —
      // refresh at most daily; flags read the latest stored run.
      const last = await db.execute(sql`SELECT max(created_at) AS at FROM loom_placebo_runs`);
      const lastAt = (last as unknown as { rows: Array<{ at: string | null }> }).rows[0]?.at;
      if (!lastAt || Date.now() - Date.parse(lastAt) > 24 * 3600_000) {
        const pb = await runPlacebo();
        r.placeboRegimes = pb.regimes;
        r.placeboThin = pb.thin;
      }

      r.flags = (await flagPrepositions()).flagged;
      r.forecastsResolved = (await resolveLoomForecasts()).resolved;
      return r;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}
