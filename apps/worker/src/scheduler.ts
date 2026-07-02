// ============================================================================
// startScheduler — the autonomous heartbeat (CLAUDE.md §10, Phase 7).
//
// Four independent setInterval loops, each on its own env-tuned cadence:
//   INGEST_EVERY_MIN     — pull + match reality (free).
//   CYCLE_EVERY_MIN      — one bounded exploration cycle (budget-governed).
//   GARDEN_EVERY_MIN     — prune/merge/decay dead wood only.
//   WORLDVIEW_EVERY_MIN  — snapshot the tree into worldview_snapshots.
//
// Ticks are non-overlapping per-loop (a running tick is skipped, not queued) and
// every tick is wrapped so one failure never kills the heartbeat. An initial
// ingest is staggered ~20s after start so the first cycle has reality to chew on.
// ============================================================================
import { sql, desc } from "drizzle-orm";
import { db, nodes, worldviewSnapshots, recordEvent, getSetting, isPaused } from "@erebus/db";
import { listNodes, calibrationScore, roamOnce, generateRootTheories, verifyResolutions } from "@erebus/core";
import { ingestAll, rematchRecent, matchNode } from "@erebus/ingest";
import { runAlerts } from "./alerts.js";
import { runGardener } from "@erebus/gardener";
import { mapUnmappedTheories, refreshMarket, resolveByMarket } from "@erebus/market";
import { llmLive, call, OPUS } from "@erebus/agents";
import { runCycle } from "./cycle.js";
import { withinDailyBudget } from "./governors.js";
import { whatChanged } from "./digest.js";

const MIN = 60_000;

function minutes(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Operating hours: an optional worker-side window (settings.operating_hours =
// { on, startHour, endHour } in UTC). Outside the window all autonomous work is
// skipped — orthogonal to the manual pause switch, which it never touches.
async function withinOperatingHours(): Promise<boolean> {
  try {
    const h = await getSetting<{ on: boolean; startHour: number; endHour: number }>("operating_hours", {
      on: false,
      startHour: 0,
      endHour: 24,
    });
    if (!h.on) return true;
    const hour = new Date().getUTCHours();
    const s = Number(h.startHour) || 0;
    const e = Number(h.endHour) || 24;
    if (s === e) return true; // degenerate window -> treat as always-open, never lock out
    return s < e ? hour >= s && hour < e : hour >= s || hour < e; // wraps midnight
  } catch {
    return true; // fail-open: a settings blip never halts the engine
  }
}

// Guard a tick so one failure never stops the loop, and skip if still running.
// gates: 'all' (pause + hours, the default for paid work) | 'none' (free DB-only
// work like alert derivation — runs even paused/off-hours so the operator still
// hears about manual-action events).
function guarded(name: string, fn: () => Promise<unknown>, gates: "all" | "none" = "all"): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.log(`[scheduler] ${name} still running — skipping this tick`);
      return;
    }
    if (gates === "all") {
      // Global pause kill-switch — skip all autonomous work while paused.
      if (await isPaused()) {
        console.log(`[scheduler] ${name} skipped — paused`);
        return;
      }
      if (!(await withinOperatingHours())) {
        console.log(`[scheduler] ${name} skipped — outside operating hours`);
        return;
      }
    }
    running = true;
    const t0 = Date.now();
    try {
      const result = await fn();
      console.log(`[scheduler] ${name} ok (${Date.now() - t0}ms)`, summarize(result));
    } catch (e) {
      console.error(`[scheduler] ${name} failed:`, (e as Error).message);
    } finally {
      running = false;
    }
  };
}

function summarize(r: unknown): string {
  try {
    return typeof r === "object" && r !== null ? JSON.stringify(r) : String(r ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Worldview tick — emergent-perspective snapshot over the tree (CLAUDE.md §9).
// Counts nodes + green nodes, pulls the calibration score, and writes a
// worldview_snapshots row. A one-shot LLM summary is layered on when live;
// offline it falls back to a deterministic count-based summary.
// ---------------------------------------------------------------------------
async function worldviewTick(): Promise<{ nodeCount: number; greenCount: number; calibration: number | null }> {
  const all = await listNodes();
  const nodeCount = all.length;
  const GREEN = new Set(["corroborated", "resolved_true"]);
  const greenCount = all.filter((n) => GREEN.has(n.state)).length;
  const calibration = await calibrationScore();

  // A digest of the last day's movement, folded into the summary for context.
  const since = new Date(Date.now() - 24 * 60 * MIN).toISOString();
  const changed = await whatChanged(since);

  let summary = `Worldview snapshot: ${nodeCount} nodes, ${greenCount} green (corroborated/resolved-true), calibration ${calibration == null ? "n/a" : calibration.toFixed(4)}. ${changed.text}`;

  // Optional richer narrative when the LLM is live — best-effort, never blocks.
  if (llmLive() && nodeCount > 0) {
    try {
      const launchPoints = all
        .filter((n) => n.isLaunchPoint || n.state === "corroborated")
        .slice(0, 12)
        .map((n) => `- [${n.state}] ${n.question} => ${n.outcome}`)
        .join("\n");
      const prompt = `You are EREBUS, summarizing your own emergent worldview from the confirmed (green) parts of your forecast tree. ${greenCount} of ${nodeCount} nodes are corroborated. Recent movement: ${changed.text}\n\nGreen / launch-point forecasts:\n${launchPoints || "(none yet)"}\n\nIn 3-4 unflinching sentences, state the worldview that emerges: what is now solid ground, and what comes next.`;
      const r = await call(prompt, { tier: "opus", agent: "worldview", maxTokens: 600 });
      if (r.content && !r.offline) summary = r.content.trim();
    } catch {
      /* keep the deterministic summary */
    }
  }

  try {
    const [row] = await db
      .insert(worldviewSnapshots)
      .values({
        summary,
        nodeCount,
        greenCount,
        calibrationScore: calibration,
      })
      .returning();
    await recordEvent({
      kind: "created",
      causeType: "job",
      after: { worldviewSnapshot: row?.id ?? null, nodeCount, greenCount },
      model: llmLive() ? OPUS : undefined,
    });
  } catch (e) {
    console.error("[scheduler] worldview snapshot insert failed:", (e as Error).message);
  }

  return { nodeCount, greenCount, calibration };
}

export interface SchedulerHandle {
  stop: () => void;
  timers: NodeJS.Timeout[];
}

export function startScheduler(): SchedulerHandle {
  const ingestEvery = minutes("INGEST_EVERY_MIN", 30);
  const rematchEvery = minutes("REMATCH_EVERY_MIN", 45);
  const cycleEvery = minutes("CYCLE_EVERY_MIN", 15);
  const gardenEvery = minutes("GARDEN_EVERY_MIN", 360);
  const worldviewEvery = minutes("WORLDVIEW_EVERY_MIN", 720);
  const marketEvery = minutes("MARKET_EVERY_MIN", 360);

  console.log(
    `[scheduler] starting — ingest/${ingestEvery}m, rematch/${rematchEvery}m, cycle/${cycleEvery}m, garden/${gardenEvery}m, worldview/${worldviewEvery}m, market/${marketEvery}m; LLM ${llmLive() ? "live" : "offline"}`
  );

  const ingestTick = guarded("ingest", () => ingestAll());
  // Re-judge recent signals against the current tree (greens new branches).
  const rematchTick = guarded("rematch", () => rematchRecent(60));
  // Autonomous roaming respects the UI toggle (settings.autonomous, default on).
  const cycleTick = guarded("cycle", async () => {
    const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
    if (!a.enabled) return { skipped: "autonomous paused" };
    return runCycle();
  });
  const gardenTick = guarded("garden", () => runGardener());
  const wvTick = guarded("worldview", () => worldviewTick());
  // Market correlation: map any unmapped theories, then turn significant moves
  // into greening/contradicting evidence. Pause-aware via guarded().
  const marketTick = guarded("market", async () => {
    const m = await mapUnmappedTheories(12);
    const r = await refreshMarket();
    // External-truth calibration: let realized moves resolve due instrument-linked forecasts.
    const res = await resolveByMarket();
    return { mapped: m.mapped, newLinks: m.created, ...r, resolvedByMarket: res.resolved };
  });

  // Genesis: birth NEW root theories from the signal stream — one strategic +
  // one dark batch per tick. Gated by the autonomous toggle + daily budget.
  const genesisEvery = minutes("GENESIS_EVERY_MIN", 240);
  const genesisTick = guarded("genesis", async () => {
    const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
    if (!a.enabled) return { skipped: "autonomous paused" };
    if (!(await withinDailyBudget())) return { skipped: "daily budget" };
    const light = await generateRootTheories({ dark: false, count: 2 });
    // Re-check the ceiling between batches so one tick can't blow through it.
    const dark = (await withinDailyBudget())
      ? await generateRootTheories({ dark: true, count: 2 })
      : { created: [], cost: 0, offline: false };
    // Green the newborn roots against existing reality immediately.
    for (const t of [...light.created, ...dark.created]) {
      try {
        await matchNode(t.id);
      } catch {
        /* greening best-effort */
      }
    }
    return {
      theories: light.created.length,
      darkTheories: dark.created.length,
      cost: Number((light.cost + dark.cost).toFixed(3)),
    };
  });

  // Alerts: derive operator alerts from provenance events (free, no LLM —
  // ungated so manual-action events still alert while paused/off-hours).
  const alertsEvery = minutes("ALERTS_EVERY_MIN", 10);
  const alertsTick = guarded("alerts", () => runAlerts(), "none");

  // Resolution verification: source-verified judge sweeps due theories and
  // audits recent resolutions (twice daily; Sonnet-cheap, budget-gated).
  const verifyEvery = minutes("VERIFY_EVERY_MIN", 720);
  const verifyTick = guarded("verify", async () => {
    const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
    if (!a.enabled) return { skipped: "autonomous paused" };
    if (!(await withinDailyBudget())) return { skipped: "daily budget" };
    return verifyResolutions({ limit: 20 });
  });

  const timers: NodeJS.Timeout[] = [
    setInterval(ingestTick, ingestEvery * MIN),
    setInterval(rematchTick, rematchEvery * MIN),
    setInterval(cycleTick, cycleEvery * MIN),
    setInterval(gardenTick, gardenEvery * MIN),
    setInterval(wvTick, worldviewEvery * MIN),
    setInterval(marketTick, marketEvery * MIN),
    setInterval(genesisTick, genesisEvery * MIN),
    setInterval(alertsTick, alertsEvery * MIN),
    setInterval(verifyTick, verifyEvery * MIN),
  ];

  // --- continuous roam: branch back-to-back while enabled --------------------
  // Self-rescheduling loop (not a fixed interval) so EREBUS keeps roaming as
  // fast as the budget allows when settings.roam_continuous.on is set. Fully
  // governed: pause stops it, the autonomous toggle gates it, the daily budget
  // caps it (then it backs off until the UTC day rolls), and every new branch
  // is greened against existing signals.
  let stopped = false;
  let roamTimer: NodeJS.Timeout | null = null;
  const scheduleRoam = (ms: number) => {
    if (!stopped) roamTimer = setTimeout(roamLoop, ms);
  };
  const roamLoop = async () => {
    try {
      if (await isPaused()) return scheduleRoam(15_000);
      if (!(await withinOperatingHours())) return scheduleRoam(60_000); // sleep till the window reopens
      const cont = await getSetting<{ on: boolean }>("roam_continuous", { on: false });
      if (!cont.on) return scheduleRoam(8_000);
      const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
      if (!a.enabled) return scheduleRoam(8_000);
      if (!(await withinDailyBudget())) return scheduleRoam(120_000); // budget hit — back off
      const r = await roamOnce();
      for (const id of r.childIds) {
        try {
          await matchNode(id);
        } catch {
          /* greening best-effort */
        }
      }
      console.log(`[scheduler] roam ${r.status}${r.nodeId ? ` ${r.nodeId}` : ""} -> ${r.expanded} children`);
      // fast cadence when productive, slower when idle/blocked
      scheduleRoam(r.status === "expanded" ? 2_000 : 12_000);
    } catch (e) {
      console.warn("[scheduler] continuous roam error:", (e as Error).message);
      scheduleRoam(12_000);
    }
  };

  // Stagger an initial ingest ~20s after start so the first cycle has signals.
  const kickoff = setTimeout(() => {
    void ingestTick();
  }, 20_000);
  const marketKickoff = setTimeout(() => void marketTick(), 45_000);
  scheduleRoam(25_000);

  const stop = () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
    clearTimeout(kickoff);
    clearTimeout(marketKickoff);
    if (roamTimer) clearTimeout(roamTimer);
    console.log("[scheduler] stopped");
  };

  return { stop, timers };
}

// --- standalone-run guard: `tsx src/scheduler.ts` runs the heartbeat forever ---
const isMain = (() => {
  try {
    return (
      import.meta.url === `file://${process.argv[1]}` ||
      process.argv[1]?.endsWith("scheduler.ts") === true
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  const handle = startScheduler();
  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive (the intervals already do, but be explicit).
  setInterval(() => {}, 1 << 30);
}
