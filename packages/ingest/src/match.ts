// ============================================================================
// The matcher — second stage of the Corroboration Engine. Judge signal<->node
// pairs (confirm/refute/neutral, LLM Sonnet tier), record a signal_matches row,
// and green/red the node via applyMatch. Dedup keeps rematching idempotent.
//   matchSignal(id)  — a signal vs its nearest nodes (ingest-time).
//   matchNode(id)    — a node vs its nearest signals (so new branches green
//                      against reality that already arrived).
//   rematchRecent(n) — sweep recent signals (idempotent).
// Offline-safe: callJSON returns the neutral fallback.
// ============================================================================
import { and, desc, eq } from "drizzle-orm";
import { db, signals, signalMatches, nodes, nearest } from "@erebus/db";
import { callJSON, matchPrompt } from "@erebus/agents";
import { applyMatch } from "@erebus/core";
import type { MatchEffect } from "@erebus/core";

const CANDIDATES = 8;

interface MatchVerdict {
  effect: MatchEffect;
  weight: number;
  rationale: string;
}

export interface MatchRecord {
  signalId: string;
  nodeId: string;
  effect: MatchEffect;
  weight: number;
  rationale: string;
}

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function normEffect(e: unknown): MatchEffect {
  return e === "confirm" || e === "refute" ? e : "neutral";
}

async function alreadyMatched(signalId: string, nodeId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: signalMatches.id })
    .from(signalMatches)
    .where(and(eq(signalMatches.signalId, signalId), eq(signalMatches.nodeId, nodeId)))
    .limit(1);
  return Boolean(hit);
}

// Judge one signal<->node pair and persist (dedup'd). Returns the record or null.
async function judgePair(
  signal: { id: string; title: string | null; summary: string | null },
  node: { id: string; question: string; outcome: string; indicators: string[]; falsifiers: string[] }
): Promise<MatchRecord | null> {
  if (await alreadyMatched(signal.id, node.id)) return null;

  const { data, offline, parsed } = await callJSON<MatchVerdict>(
    matchPrompt(
      { title: signal.title ?? "", summary: signal.summary ?? "" },
      { question: node.question, outcome: node.outcome, indicators: node.indicators, falsifiers: node.falsifiers }
    ),
    { effect: "neutral", weight: 0, rationale: "" },
    { tier: "sonnet", agent: "match", targetNode: node.id, maxTokens: 500 }
  );

  // CRITICAL (deep-review #2): a fallback verdict must NEVER be persisted —
  // storing it consumed the (signal,node) dedup slot forever, so every pause or
  // provider outage permanently destroyed the evidence of that window. Skip and
  // let a later sweep re-judge the pair for real.
  if (offline || !parsed) return null;

  const effect = normEffect(data.effect);
  const weight = clamp01(data.weight);
  const rationale = typeof data.rationale === "string" ? data.rationale : "";

  // Unique(signal,node) + onConflictDoNothing: a concurrent sweep judging the
  // same pair loses cleanly instead of double-applying Bayesian evidence.
  const [matchRow] = await db
    .insert(signalMatches)
    .values({ signalId: signal.id, nodeId: node.id, effect, weight, rationale })
    .onConflictDoNothing()
    .returning({ id: signalMatches.id });
  if (!matchRow) return null; // lost the race — evidence already applied once

  if ((effect === "confirm" || effect === "refute") && weight > 0) {
    await applyMatch(node.id, effect, weight, matchRow.id);
  }
  return { signalId: signal.id, nodeId: node.id, effect, weight, rationale };
}

// Nodes reality has finished with must not receive (or pay for) new judgments.
function isDeadNode(n: { resolved: boolean | null; state: string; mergedInto: string | null }): boolean {
  return Boolean(n.resolved) || n.mergedInto !== null || n.state === "dormant" || n.state === "merged";
}

// A signal vs its nearest forecast nodes.
export async function matchSignal(signalId: string): Promise<MatchRecord[]> {
  const [signal] = await db.select().from(signals).where(eq(signals.id, signalId)).limit(1);
  if (!signal || !signal.embedding) return [];
  const candidates = await nearest("nodes", signal.embedding, CANDIDATES);
  const made: MatchRecord[] = [];
  for (const cand of candidates) {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, cand.id)).limit(1);
    if (!node || isDeadNode(node)) continue; // no judge spend on finished nodes
    const rec = await judgePair(signal, node);
    if (rec) made.push(rec);
  }
  return made;
}

// A node vs its nearest signals — greens a freshly created/expanded branch
// against reality that already arrived. Call after create/expand/pursue/roam.
export async function matchNode(nodeId: string): Promise<MatchRecord[]> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node || !node.embedding || isDeadNode(node)) return [];
  const candidates = await nearest("signals", node.embedding, CANDIDATES);
  const made: MatchRecord[] = [];
  for (const cand of candidates) {
    const [signal] = await db.select().from(signals).where(eq(signals.id, String(cand.id))).limit(1);
    if (!signal) continue;
    const rec = await judgePair(signal, node);
    if (rec) made.push(rec);
  }
  return made;
}

// Sweep the most recent signals back through matching (idempotent via dedup).
export async function rematchRecent(limit = 40): Promise<{ signals: number; matches: number }> {
  const rows = await db
    .select({ id: signals.id })
    .from(signals)
    .orderBy(desc(signals.ingestedAt))
    .limit(limit);
  let matches = 0;
  for (const r of rows) matches += (await matchSignal(r.id)).length;
  return { signals: rows.length, matches };
}
