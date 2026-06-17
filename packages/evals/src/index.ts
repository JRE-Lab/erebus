// EREBUS evals — golden sets + quality/calibration baseline (CLAUDE.md §8).
// Reports over the live tree:
//   forecastQuality  — % of nodes that are well-formed (>=2 indicators,
//                       >=1 falsifier, and a horizon).
//   indicatorQuality — average indicators per node.
//   calibration      — mean Brier over resolved nodes (or null if none).
//   counts           — total nodes + breakdown by state.
// Everything reads through @erebus/core / @erebus/db; nothing calls the LLM, so
// it is safe to run regardless of llmLive().
import { listNodes, calibrationScore } from "@erebus/core";
import type { NodeRow, NodeState } from "@erebus/core";
import { GOLDEN } from "./golden.js";

export interface EvalReport {
  forecastQuality: number; // [0,1] fraction of well-formed nodes
  indicatorQuality: number; // avg indicators per node
  calibration: number | null; // mean Brier over resolved nodes
  counts: {
    total: number;
    byState: Record<string, number>;
  };
  goldenCount: number; // size of the smoke-test golden set
}

// A node is a well-formed forecast when it carries >=2 confirming indicators,
// at least one falsifier, and a horizon to resolve against.
export function isWellFormed(n: NodeRow): boolean {
  return (n.indicators?.length ?? 0) >= 2 && (n.falsifiers?.length ?? 0) >= 1 && n.horizon != null;
}

export async function runEvals(): Promise<EvalReport> {
  const nodes = await listNodes();
  const total = nodes.length;

  let wellFormed = 0;
  let indicatorTotal = 0;
  const byState: Record<string, number> = {};

  for (const n of nodes) {
    if (isWellFormed(n)) wellFormed++;
    indicatorTotal += n.indicators?.length ?? 0;
    const state = (n.state as NodeState) ?? "speculative";
    byState[state] = (byState[state] ?? 0) + 1;
  }

  const forecastQuality = total > 0 ? wellFormed / total : 0;
  const indicatorQuality = total > 0 ? indicatorTotal / total : 0;
  const calibration = await calibrationScore();

  const report: EvalReport = {
    forecastQuality,
    indicatorQuality,
    calibration,
    counts: { total, byState },
    goldenCount: GOLDEN.length,
  };

  print(report, wellFormed);
  return report;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function print(r: EvalReport, wellFormed: number): void {
  const lines: string[] = [];
  lines.push("EREBUS evals ──────────────────────────────");
  lines.push(`  nodes total        ${r.counts.total}`);
  lines.push(
    `  forecast quality   ${pct(r.forecastQuality)}  (${wellFormed}/${r.counts.total} well-formed: >=2 indicators, >=1 falsifier, horizon)`
  );
  lines.push(`  indicator quality  ${r.indicatorQuality.toFixed(2)} avg indicators/node`);
  lines.push(
    `  calibration        ${r.calibration == null ? "n/a (no resolved nodes)" : `${r.calibration.toFixed(4)} mean Brier`}`
  );
  lines.push(`  golden set         ${r.goldenCount} smoke-test prompts`);
  lines.push("  by state:");
  const states = Object.keys(r.counts.byState).sort();
  if (states.length === 0) {
    lines.push("    (none)");
  } else {
    for (const s of states) {
      lines.push(`    ${s.padEnd(16)} ${r.counts.byState[s]}`);
    }
  }
  lines.push("────────────────────────────────────────────");
  console.log(lines.join("\n"));
}

// Allow `tsx src/index.ts` (the package "run" script) to execute directly.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts") === true;
  } catch {
    return false;
  }
})();

if (isMain) {
  runEvals()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("eval run failed:", err);
      process.exit(1);
    });
}
