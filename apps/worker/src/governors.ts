// ============================================================================
// Economic governors. The DAILY governor now lives in @erebus/db/budget and is
// enforced inside agents.call() itself, so every paid path — worker ticks, web
// endpoints, matching, market, content — hits ONE fail-closed gate (the old
// worker-local, fail-open copy was the deep review's "budget cap is fiction"
// finding). This module re-exports it for existing call sites and keeps the
// per-cycle in-memory tally, which is a cycle-shaping knob rather than a cap.
// ============================================================================
export { spentToday, withinDailyBudget, DAILY_BUDGET_USD } from "@erebus/db";

// Per-cycle budget — how much one autonomous cycle may spend before it stops.
export const CYCLE_BUDGET_USD = Number(process.env.CYCLE_BUDGET_USD || 2.0);

// True while the current cycle's running spend is under the per-cycle budget.
export function withinCycleBudget(spentThisCycle: number): boolean {
  const spent = Number.isFinite(spentThisCycle) ? spentThisCycle : 0;
  return spent < CYCLE_BUDGET_USD;
}
