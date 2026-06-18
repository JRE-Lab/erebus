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
import { db, nodes, worldviewSnapshots, recordEvent, getSetting } from "@erebus/db";
import { listNodes, calibrationScore } from "@erebus/core";
import { ingestAll } from "@erebus/ingest";
import { runGardener } from "@erebus/gardener";
import { llmLive, call, OPUS } from "@erebus/agents";
import { runCycle } from "./cycle.js";
import { whatChanged } from "./digest.js";

const MIN = 60_000;

function minutes(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Guard a tick so one failure never stops the loop, and skip if still running.
function guarded(name: string, fn: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.log(`[scheduler] ${name} still running — skipping this tick`);
      return;
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
  const cycleEvery = minutes("CYCLE_EVERY_MIN", 15);
  const gardenEvery = minutes("GARDEN_EVERY_MIN", 360);
  const worldviewEvery = minutes("WORLDVIEW_EVERY_MIN", 720);

  console.log(
    `[scheduler] starting — ingest/${ingestEvery}m, cycle/${cycleEvery}m, garden/${gardenEvery}m, worldview/${worldviewEvery}m; LLM ${llmLive() ? "live" : "offline"}`
  );

  const ingestTick = guarded("ingest", () => ingestAll());
  // Autonomous roaming respects the UI toggle (settings.autonomous, default on).
  const cycleTick = guarded("cycle", async () => {
    const a = await getSetting<{ enabled: boolean }>("autonomous", { enabled: true });
    if (!a.enabled) return { skipped: "autonomous paused" };
    return runCycle();
  });
  const gardenTick = guarded("garden", () => runGardener());
  const wvTick = guarded("worldview", () => worldviewTick());

  const timers: NodeJS.Timeout[] = [
    setInterval(ingestTick, ingestEvery * MIN),
    setInterval(cycleTick, cycleEvery * MIN),
    setInterval(gardenTick, gardenEvery * MIN),
    setInterval(wvTick, worldviewEvery * MIN),
  ];

  // Stagger an initial ingest ~20s after start so the first cycle has signals.
  const kickoff = setTimeout(() => {
    void ingestTick();
  }, 20_000);

  const stop = () => {
    for (const t of timers) clearInterval(t);
    clearTimeout(kickoff);
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
