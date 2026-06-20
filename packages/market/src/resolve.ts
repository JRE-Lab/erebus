// External truth for calibration: when an instrument-linked forecast's horizon
// passes, let the realized market move adjudicate it. The linked instruments
// encode the expected direction; if the net realized move (over a resolution
// window) clearly aligns it RESOLVED TRUE, clearly opposes -> FALSE, ambiguous
// -> left for the operator. This is what makes the Brier score mean something.
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db, nodes, nodeInstruments } from "@erebus/db";
import { adjudicate } from "@erebus/core";
import { fetchCandles, changePct } from "./sources.js";

const RESOLVE_MOVE_PCT = Number(process.env.MARKET_RESOLVE_PCT || 6); // % over the window
const RESOLVE_WINDOW = Number(process.env.MARKET_RESOLVE_WINDOW_DAYS || 22); // ~1 trading month
// Only auto-resolve forecasts whose horizon passed RECENTLY — the trailing price
// window must overlap the forecast period. Older overdue nodes are left for the
// operator (we don't have price history anchored to an arbitrary past horizon).
const HORIZON_GRACE_DAYS = Number(process.env.MARKET_RESOLVE_GRACE_DAYS || 35);

export async function resolveByMarket(): Promise<{ checked: number; resolved: number }> {
  // Instrument-linked, horizon passed within the grace window, not yet resolved.
  const now = Date.now();
  const cutoff = new Date(now - HORIZON_GRACE_DAYS * 86_400_000);
  const due = await db
    .selectDistinct({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeInstruments, eq(nodeInstruments.nodeId, nodes.id))
    .where(and(isNull(nodes.resolved), lte(nodes.horizon, new Date(now)), gte(nodes.horizon, cutoff)));

  let resolved = 0;
  let checked = 0;
  for (const { id } of due) {
    checked++;
    const links = await db.select().from(nodeInstruments).where(eq(nodeInstruments.nodeId, id));
    let votesTrue = 0;
    let votesFalse = 0;
    for (const l of links) {
      const c = await fetchCandles(l.symbol);
      const move = changePct(c.closes, RESOLVE_WINDOW);
      if (move === null || Math.abs(move) < RESOLVE_MOVE_PCT) continue; // ambiguous
      const up = move > 0;
      const exp = l.expectation === "down" ? "down" : "up";
      const aligned = (exp === "up" && up) || (exp === "down" && !up);
      if (aligned) votesTrue++;
      else votesFalse++;
    }
    if (votesTrue === votesFalse) continue; // tie or no clear signal -> leave for operator
    await adjudicate(id, votesTrue > votesFalse, "market");
    resolved++;
  }
  return { checked, resolved };
}
