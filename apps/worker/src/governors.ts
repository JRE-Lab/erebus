// ============================================================================
// Economic governors (CLAUDE.md §8). A circuit breaker on spend, never a leash
// on curiosity. Every LLM call logs its cost to exploration_jobs.cost_usd (see
// @erebus/agents client.logSpend); the governors read that ledger.
//
//   spentToday()         — total $ spent across today's jobs (UTC day).
//   withinCycleBudget()  — is the running spend of THIS cycle under CYCLE_BUDGET_USD?
//   withinDailyBudget()  — is today's total spend under DAILY_BUDGET_USD?
//
// All reads are guarded: a DB error reports $0 spent (fail-open on the read) but
// the cycle still self-limits via the in-memory cycle budget, so a transient DB
// blip can never silently uncork unbounded spend within a cycle.
// ============================================================================
import { pool } from "@erebus/db";

// Per-cycle budget — how much one autonomous cycle may spend before it stops.
export const CYCLE_BUDGET_USD = Number(process.env.CYCLE_BUDGET_USD || 2.0);

// Daily ceiling across ALL cycles. Defaults generously to 10x the cycle budget
// so a freshly-configured system isn't throttled before it is tuned.
export const DAILY_BUDGET_USD = Number(
  process.env.DAILY_BUDGET_USD || CYCLE_BUDGET_USD * 10
);

// Sum cost_usd over every job that started OR finished today (UTC day-truncated).
// A job that spans midnight still counts the day it touched. Returns 0 on error.
export async function spentToday(): Promise<number> {
  try {
    const res = await pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
         FROM exploration_jobs
        WHERE date_trunc('day', COALESCE(finished_at, started_at, now())) = date_trunc('day', now())`
    );
    return Number(res.rows[0]?.total ?? 0);
  } catch {
    return 0; // fail-open on the read; in-cycle budget still self-limits.
  }
}

// True while the current cycle's running spend is under the per-cycle budget.
export function withinCycleBudget(spentThisCycle: number): boolean {
  const spent = Number.isFinite(spentThisCycle) ? spentThisCycle : 0;
  return spent < CYCLE_BUDGET_USD;
}

// True while today's total spend is under the daily ceiling. When this is false
// the cycle skips all LLM work (ingestion, which is free, may still proceed).
export async function withinDailyBudget(): Promise<boolean> {
  const spent = await spentToday();
  return spent < DAILY_BUDGET_USD;
}
