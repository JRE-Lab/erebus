// ============================================================================
// runCycle — one bounded autonomous cycle (CLAUDE.md §10, Phase 7).
//
// A single cycle:
//   1) Ingest reality (ingestAll) — free, always allowed even past the daily cap.
//   2) Count nodes due for adjudication (free; resolution is external now —
//      market auto-resolves, the operator adjudicates).
//   3) While under CYCLE_BUDGET_USD (and the daily cap): pick a node and extend
//      the tree — expandForward, and occasionally a deeper pass (runDebate to
//      sharpen, or runShadowRead for a deception read on a green node).
//
// Budget is enforced two ways: the per-cycle running tally (CYCLE_BUDGET_USD)
// stops this cycle, and withinDailyBudget() gates ALL LLM work for the day.
// Everything is guarded and offline-safe — when llmLive() is false the LLM
// helpers return their fallbacks and the cycle still completes cleanly.
// ============================================================================
import { resolveDueNodes } from "@erebus/core";
import { runDebate } from "@erebus/agents";
import { ingestAll, matchNode } from "@erebus/ingest";
import { runShadowRead } from "@erebus/shadowboard";
import { expandForward } from "@erebus/core";
import {
  CYCLE_BUDGET_USD,
  withinCycleBudget,
  withinDailyBudget,
} from "./governors.js";
import { pickNext } from "./selector.js";

export interface CycleSummary {
  startedAt: string;
  finishedAt: string;
  ingested: { signals: number; matches: number };
  resolved: number;
  expansions: number;
  childrenSpawned: number;
  debates: number;
  shadowReads: number;
  cost: number;
  cycleBudget: number;
  dailyCapHit: boolean;
  stoppedReason: string;
  notes: string[];
}

export interface RunCycleOpts {
  ingest?: boolean; // default true — pull + match reality first
  maxActions?: number; // hard cap on LLM-driven steps per cycle (default 6)
}

export async function runCycle(opts: RunCycleOpts = {}): Promise<CycleSummary> {
  const startedAt = new Date();
  const doIngest = opts.ingest !== false;
  const maxActions = Number.isFinite(opts.maxActions) ? Number(opts.maxActions) : 6;

  const notes: string[] = [];
  let cost = 0;
  let expansions = 0;
  let childrenSpawned = 0;
  let debates = 0;
  let shadowReads = 0;
  let ingested = { signals: 0, matches: 0 };
  let resolved = 0;
  let stoppedReason = "completed";

  // 1) Ingest — free; runs regardless of budget so reality keeps greening the tree.
  if (doIngest) {
    try {
      ingested = await ingestAll();
      notes.push(`ingested ${ingested.signals} signals -> ${ingested.matches} matches`);
    } catch (e) {
      notes.push(`ingest failed: ${(e as Error).message}`);
    }
  }

  // 2) Count due-unresolved nodes — free. Resolution itself is EXTERNAL now
  // (market auto-resolves in the market tick; the operator adjudicates in the
  // UI); we no longer self-grade on internal confirmation.
  try {
    const r = await resolveDueNodes();
    resolved = r.resolved; // always 0 now (kept for CycleSummary shape)
    if (r.due) notes.push(`${r.due} node(s) due for adjudication`);
  } catch (e) {
    notes.push(`resolve-check failed: ${(e as Error).message}`);
  }

  // Daily ceiling gates all paid (LLM) work for the rest of the cycle.
  const dailyOk = await withinDailyBudget();
  if (!dailyOk) {
    notes.push("daily budget exceeded — skipping LLM work (ingestion/resolution done)");
    const finishedAt = new Date();
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ingested,
      resolved,
      expansions,
      childrenSpawned,
      debates,
      shadowReads,
      cost,
      cycleBudget: CYCLE_BUDGET_USD,
      dailyCapHit: true,
      stoppedReason: "daily_cap",
      notes,
    };
  }

  // 3) Extend the tree until the per-cycle budget (or action cap) is reached.
  let actions = 0;
  while (withinCycleBudget(cost) && actions < maxActions) {
    const pick = await pickNext();
    if (!pick) {
      stoppedReason = "nothing_to_do";
      notes.push("selector found no live node to extend");
      break;
    }

    // Primary work: forward expansion from the picked node.
    try {
      const exp = await expandForward(pick.nodeId);
      cost += exp.cost;
      expansions++;
      actions++;
      if (exp.blocked) {
        notes.push(`expand ${pick.nodeId} blocked: ${exp.blocked}`);
      } else {
        childrenSpawned += exp.children.length;
        notes.push(`expand ${pick.nodeId} (${pick.reason}) -> ${exp.children.length} children`);
        // Green the new branches against existing reality immediately, so an
        // autonomously-grown node can corroborate from the current signal corpus
        // instead of waiting for a future signal to coincidentally land near it.
        for (const ch of exp.children) {
          try {
            await matchNode(ch.id);
          } catch (e) {
            notes.push(`match ${ch.id} failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      notes.push(`expand ${pick.nodeId} failed: ${(e as Error).message}`);
      actions++;
    }

    if (!withinCycleBudget(cost)) break;

    // Occasional deeper pass on the SAME node: shadow read on a confirmed
    // launch point (deception analysis on solid ground), else a 1-round debate
    // to sharpen the forecast. Roughly 1-in-3 to keep cycles cheap and varied.
    const roll = Math.random();
    if (roll < 0.33) {
      try {
        if (pick.action === "expand" && pick.reason.startsWith("green")) {
          const sr = await runShadowRead(pick.nodeId);
          cost += sr.cost;
          shadowReads++;
          actions++;
          notes.push(`shadow read ${pick.nodeId}${sr.spawnedNode ? ` -> spawned ${sr.spawnedNode}` : ""}`);
        } else {
          const d = await runDebate(pick.nodeId, 1);
          if (d) {
            cost += d.cost;
            debates++;
            actions++;
            notes.push(`debate ${pick.nodeId}: ${d.verdict} (conf ${d.confidenceBefore.toFixed(2)}->${d.confidenceAfter.toFixed(2)})`);
          }
        }
      } catch (e) {
        notes.push(`deep pass on ${pick.nodeId} failed: ${(e as Error).message}`);
      }
    }
  }

  if (actions >= maxActions && stoppedReason === "completed") stoppedReason = "action_cap";
  if (!withinCycleBudget(cost) && stoppedReason === "completed") stoppedReason = "cycle_budget";

  const finishedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ingested,
    resolved,
    expansions,
    childrenSpawned,
    debates,
    shadowReads,
    cost,
    cycleBudget: CYCLE_BUDGET_USD,
    dailyCapHit: false,
    stoppedReason,
    notes,
  };
}
