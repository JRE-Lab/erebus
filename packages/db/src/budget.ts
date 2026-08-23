// ============================================================================
// Shared daily spend governor — THE choke point for every paid call. Lives in
// @erebus/db so that @erebus/agents can enforce it inside call() itself, which
// covers the worker ticks, the web API, matching, market, content — everything —
// in one place (deep-review finding: governors scattered across worker ticks
// cannot govern a multi-process system).
//
// Semantics:
//  - withinDailyBudget() is cached ~5s (it runs on every LLM call).
//  - The ledger read is sargable (finished_at >= day start; index jobs_finished_idx).
//  - FAIL CLOSED: after 3 consecutive read failures the governor reports
//    over-budget until a read succeeds — a broken ledger must never uncork
//    unbounded spend (the old fail-open behavior did exactly that).
// ============================================================================
import { pool } from "./client.js";

// Default preserves the old worker governor's coupling (CYCLE_BUDGET_USD * 10)
// so a deployment tuned via CYCLE_BUDGET_USD alone doesn't silently jump caps.
export const DAILY_BUDGET_USD = Number(
  process.env.DAILY_BUDGET_USD || Number(process.env.CYCLE_BUDGET_USD || 1.5) * 10
);

let _cache = { ok: true, t: 0 };
let _failures = 0;

// Total $ spent across today's jobs (UTC day). Throws on DB error — callers
// that need the raw number handle it; withinDailyBudget() wraps it fail-closed.
export async function spentToday(): Promise<number> {
  const res = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
       FROM exploration_jobs
      WHERE finished_at >= date_trunc('day', now())`
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function withinDailyBudget(): Promise<boolean> {
  const now = Date.now();
  if (now - _cache.t < 5000) return _cache.ok;
  try {
    const ok = (await spentToday()) < DAILY_BUDGET_USD;
    _failures = 0;
    _cache = { ok, t: now };
    return ok;
  } catch {
    _failures++;
    // Fail closed once the ledger is clearly unhealthy; tolerate blips.
    const ok = _failures < 3 ? _cache.ok : false;
    _cache = { ok, t: now };
    return ok;
  }
}
