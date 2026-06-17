// Autonomous scheduler. Started in-process by the API when WORKERS_ENABLED=true,
// or standalone via `pnpm --filter @erebus/api workers`.
import { pollAllSources } from "../ingestion/index.js";
import { runAutonomousExplorer } from "./autonomousExplorer.js";
import { runEvidenceSweeper } from "./evidenceSweeper.js";
import { runTheoryRefiner } from "./theoryRefiner.js";

const MIN = 60_000;
const timers: NodeJS.Timeout[] = [];

function every(minutes: number, label: string, fn: () => Promise<unknown>) {
  if (minutes <= 0) return;
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[scheduler:${label}]`, (err as Error).message);
    }
  };
  timers.push(setInterval(tick, minutes * MIN));
  console.log(`[scheduler] ${label} every ${minutes}m`);
}

export function startScheduler() {
  const ingest = Number(process.env.INGEST_POLL_MINUTES ?? 30);
  const explore = Number(process.env.AUTONOMOUS_EXPLORE_MINUTES ?? 60);
  const evidence = Number(process.env.EVIDENCE_SWEEP_MINUTES ?? 120);
  const refine = Number(process.env.THEORY_REFINE_MINUTES ?? 180);

  // Stagger an initial ingest shortly after boot so the feed isn't empty.
  setTimeout(() => pollAllSources().catch(() => {}), 20_000);

  every(ingest, "ingest", pollAllSources);
  every(explore, "explore", runAutonomousExplorer);
  every(evidence, "evidence", runEvidenceSweeper);
  every(refine, "refine", runTheoryRefiner);
}

export function stopScheduler() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

// Allow standalone execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  startScheduler();
  console.log("[scheduler] running standalone; Ctrl+C to stop");
}
