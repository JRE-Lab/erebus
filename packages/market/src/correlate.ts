// The integration: significant market moves become evidence signals that green
// or contradict the theories they're linked to. Deterministic (no LLM) — the
// node->instrument link already encodes the expected direction, so a move that
// aligns confirms and one that opposes refutes, weighted by magnitude. Each
// (node, symbol, day, direction) is recorded at most once (dedupHash).
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, nodes, signals, signalMatches, nodeInstruments, embed, toVector } from "@erebus/db";
import { applyMatch } from "@erebus/core";
import type { MatchEffect } from "@erebus/core";
import { fetchCandles, changePct } from "./sources.js";
import { findInstrument } from "./catalog.js";

const MOVE_THRESHOLD = Number(process.env.MARKET_MOVE_PCT || 4); // % over the window
const WINDOW_DAYS = Number(process.env.MARKET_WINDOW_DAYS || 5);

export async function refreshMarket(): Promise<{ checked: number; signals: number; matches: number }> {
  const links = await db
    .select({
      nodeId: nodeInstruments.nodeId,
      symbol: nodeInstruments.symbol,
      name: nodeInstruments.name,
      expectation: nodeInstruments.expectation,
      merged: nodes.mergedInto,
      resolved: nodes.resolved,
      state: nodes.state,
    })
    .from(nodeInstruments)
    .innerJoin(nodes, eq(nodes.id, nodeInstruments.nodeId));

  // Fetch each distinct symbol once (cached inside sources).
  const symbols = Array.from(new Set(links.map((l) => l.symbol)));
  const candles = new Map<string, Awaited<ReturnType<typeof fetchCandles>>>();
  for (const s of symbols) candles.set(s, await fetchCandles(s));

  let created = 0;
  let matched = 0;
  let checked = 0;

  for (const l of links) {
    // Resolved/merged/dormant theories are finished — no new market evidence.
    if (!l.nodeId || l.merged || l.resolved || l.state === "dormant" || l.state === "merged") continue;
    const c = candles.get(l.symbol);
    if (!c || c.closes.length < 2) continue;
    checked++;

    const move = changePct(c.closes, WINDOW_DAYS);
    if (move === null || Math.abs(move) < MOVE_THRESHOLD) continue;

    const up = move > 0;
    const exp = l.expectation === "down" ? "down" : "up";
    const aligned = (exp === "up" && up) || (exp === "down" && !up);
    const effect: MatchEffect = aligned ? "confirm" : "refute";
    const weight = Math.max(0.2, Math.min(1, Math.abs(move) / 12));

    const hash = createHash("sha256")
      .update(`market|${l.symbol}|${l.nodeId}|${c.asOf}|${effect}`)
      .digest("hex");

    const title = `${l.name} (${l.symbol}) ${up ? "+" : ""}${move.toFixed(1)}% over ${WINDOW_DAYS}d`;
    const summary = `Market move ${aligned ? "supports" : "contradicts"} the forecast (expected ${exp}). As of ${c.asOf || "latest"}.`;
    const vec = toVector(await embed(`${title}\n${summary}`));

    const [sig] = await db
      .insert(signals)
      .values({
        source: "market",
        url: `https://stooq.com/q/?s=${findInstrument(l.symbol)?.stooq ?? ""}`,
        title,
        summary,
        dedupHash: hash,
        publishedAt: new Date(),
        embedding: sql.raw(`'${vec}'::vector`),
      })
      .onConflictDoNothing()
      .returning({ id: signals.id });
    if (!sig) continue; // this move/day/direction already recorded
    created++;

    const [m] = await db
      .insert(signalMatches)
      .values({ signalId: sig.id, nodeId: l.nodeId, effect, weight, rationale: summary })
      .returning({ id: signalMatches.id });
    await applyMatch(l.nodeId, effect, weight, m?.id);
    matched++;
  }

  return { checked, signals: created, matches: matched };
}
