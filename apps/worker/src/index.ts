// ============================================================================
// @erebus/worker — the autonomous loop + governors (CLAUDE.md Phase 7).
// Public surface: governors, selector, digest, the bounded cycle, and the
// scheduler heartbeat. Everything here is offline-safe and budget-governed.
// ============================================================================
export {
  spentToday,
  withinCycleBudget,
  withinDailyBudget,
  CYCLE_BUDGET_USD,
  DAILY_BUDGET_USD,
} from "./governors.js";

export { pickNext } from "./selector.js";
export type { Pick, WorkerAction } from "./selector.js";

export { whatChanged } from "./digest.js";
export type { ChangeDigest } from "./digest.js";

export { runCycle } from "./cycle.js";
export type { CycleSummary, RunCycleOpts } from "./cycle.js";

export { startScheduler } from "./scheduler.js";
export type { SchedulerHandle } from "./scheduler.js";
