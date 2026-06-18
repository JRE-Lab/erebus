// Read model for the Market tab: live quotes for the catalog + every theory's
// instrument links with their current move and a confirm/contradict read.
import { eq } from "drizzle-orm";
import { db, nodes, nodeInstruments } from "@erebus/db";
import { CATALOG } from "./catalog.js";
import { getQuote, fetchCandles, changePct } from "./sources.js";

const WINDOW_DAYS = Number(process.env.MARKET_WINDOW_DAYS || 5);
const MOVE_THRESHOLD = Number(process.env.MARKET_MOVE_PCT || 4);

export interface OverviewInstrument {
  symbol: string;
  name: string;
  kind: string;
  price: number | null;
  asOf: string;
  source: string;
  d1: number | null;
  d5: number | null;
  d30: number | null;
}

export interface TheoryLink {
  symbol: string;
  name: string;
  expectation: "up" | "down" | string;
  rationale: string | null;
  move: number | null; // % over the correlation window
  verdict: "confirms" | "contradicts" | "neutral";
}

export interface TheoryCorrelation {
  nodeId: string;
  question: string;
  state: string;
  origin: string;
  links: TheoryLink[];
}

export interface MarketOverview {
  instruments: OverviewInstrument[];
  theories: TheoryCorrelation[];
  window: number;
  threshold: number;
}

export async function getMarketOverview(): Promise<MarketOverview> {
  // Quotes for the whole catalog (cached inside sources).
  const instruments: OverviewInstrument[] = await Promise.all(
    CATALOG.map(async (i) => {
      const q = await getQuote(i.symbol);
      return {
        symbol: i.symbol,
        name: i.name,
        kind: i.kind,
        price: q.price,
        asOf: q.asOf,
        source: q.source,
        d1: q.d1,
        d5: q.d5,
        d30: q.d30,
      };
    })
  );

  // Theory links joined to their node.
  const rows = await db
    .select({
      nodeId: nodeInstruments.nodeId,
      symbol: nodeInstruments.symbol,
      name: nodeInstruments.name,
      expectation: nodeInstruments.expectation,
      rationale: nodeInstruments.rationale,
      question: nodes.question,
      state: nodes.state,
      origin: nodes.origin,
    })
    .from(nodeInstruments)
    .innerJoin(nodes, eq(nodes.id, nodeInstruments.nodeId));

  const byNode = new Map<string, TheoryCorrelation>();
  for (const r of rows) {
    if (!r.nodeId) continue;
    const c = await fetchCandles(r.symbol);
    const move = changePct(c.closes, WINDOW_DAYS);
    let verdict: TheoryLink["verdict"] = "neutral";
    if (move !== null && Math.abs(move) >= MOVE_THRESHOLD) {
      const up = move > 0;
      const exp = r.expectation === "down" ? "down" : "up";
      const aligned = (exp === "up" && up) || (exp === "down" && !up);
      verdict = aligned ? "confirms" : "contradicts";
    }
    const entry =
      byNode.get(r.nodeId) ??
      ({ nodeId: r.nodeId, question: r.question, state: r.state, origin: r.origin, links: [] } as TheoryCorrelation);
    entry.links.push({
      symbol: r.symbol,
      name: r.name,
      expectation: r.expectation,
      rationale: r.rationale,
      move,
      verdict,
    });
    byNode.set(r.nodeId, entry);
  }

  return {
    instruments,
    theories: Array.from(byNode.values()),
    window: WINDOW_DAYS,
    threshold: MOVE_THRESHOLD,
  };
}
