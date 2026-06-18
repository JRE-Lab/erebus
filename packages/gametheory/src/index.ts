// ============================================================================
// @erebus/gametheory — the strategic depth layer. A "game read" models a
// forecast as a game: players + payoffs + BATNA, the predicted equilibrium and
// its TYPE, and an equilibrium-STABILITY score (orthogonal to confirmation — a
// forecast can be greening yet sit on a knife-edge). It then derives a DECISION:
// the focal point, the highest-leverage move, a no-regret action, and the single
// reversal tripwire. Offline-safe (LLM fallback -> empty read, no state change).
// ============================================================================
import { eq, desc } from "drizzle-orm";
import { db, nodes, gameReads, recordEvent } from "@erebus/db";
import { callJSON, gameReadPrompt, decidePrompt, OPUS } from "@erebus/agents";
import { applyStability } from "@erebus/core";

export type GameReadRow = typeof gameReads.$inferSelect;

interface Player {
  name: string;
  type: string;
  payoffRanking: string;
  batna: string;
  dominantStrategy: string;
  patience: string;
}
interface GameShape {
  players: Player[];
  gameType: string;
  predictedEquilibrium: string;
  equilibriumType: string;
  outcomeIsEquilibrium: boolean;
  stability: number;
  fragilityDrivers: string[];
}
interface LeverageMove {
  actor: string;
  move: string;
  mechanism: string;
  expectedShift: string;
  reversibility: string;
}
interface DecisionShape {
  focalPoint: string;
  leverageMoves: LeverageMove[];
  noRegretAction: string;
  reversalTripwire: string;
}

const EMPTY_GAME: GameShape = {
  players: [],
  gameType: "one_shot",
  predictedEquilibrium: "",
  equilibriumType: "none",
  outcomeIsEquilibrium: false,
  stability: 0.5,
  fragilityDrivers: [],
};
const EMPTY_DECISION: DecisionShape = {
  focalPoint: "",
  leverageMoves: [],
  noRegretAction: "",
  reversalTripwire: "",
};

function clamp01(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

export interface GameReadResult {
  gameRead: GameReadRow | null;
  cost: number;
  offline: boolean;
}

// Run the full strategic analysis (game read + decision layer) for a node, store
// it, and fold the stability back into the node's state (-> "tipping" if fragile).
export async function runGameRead(nodeId: string): Promise<GameReadResult> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node) return { gameRead: null, cost: 0, offline: false };

  // 1) Game read (Opus).
  const read = await callJSON<GameShape>(
    gameReadPrompt({ question: node.question, outcome: node.outcome, rationale: node.rationale }),
    EMPTY_GAME,
    { tier: "opus", agent: "game-read", targetNode: nodeId }
  );
  const g = read.data;
  const stability = clamp01(g.stability);

  // 2) Decision layer (Sonnet — derivative of the read).
  const decision = await callJSON<DecisionShape>(
    decidePrompt({ question: node.question, outcome: node.outcome }, JSON.stringify(g)),
    EMPTY_DECISION,
    { tier: "sonnet", agent: "game-decide", targetNode: nodeId }
  );
  const d = decision.data;
  const cost = read.cost + decision.cost;
  const offline = read.offline;

  // 3) Persist one combined row.
  const [row] = await db
    .insert(gameReads)
    .values({
      nodeId,
      players: (Array.isArray(g.players) ? g.players : []) as object,
      gameType: g.gameType ?? null,
      predictedEquilibrium: g.predictedEquilibrium ?? null,
      equilibriumType: g.equilibriumType ?? null,
      outcomeIsEquilibrium: Boolean(g.outcomeIsEquilibrium),
      stability,
      fragilityDrivers: Array.isArray(g.fragilityDrivers) ? g.fragilityDrivers : [],
      focalPoint: d.focalPoint ?? null,
      leverageMoves: (Array.isArray(d.leverageMoves) ? d.leverageMoves : []) as object,
      noRegretAction: d.noRegretAction ?? null,
      reversalTripwire: d.reversalTripwire ?? null,
      model: OPUS,
    })
    .returning();

  // 4) Fold equilibrium stability into the node (may flip it to "tipping").
  if (!offline) {
    await applyStability(nodeId, stability, g.equilibriumType);
    // The reversal tripwire is a thing to watch — add it as an indicator so
    // greening tracks whether the window to act opens. Dedup, cap the list.
    const tw = (d.reversalTripwire ?? "").trim();
    if (tw && !node.indicators.includes(tw)) {
      await db
        .update(nodes)
        .set({ indicators: [...node.indicators, tw].slice(0, 12), updatedAt: new Date() })
        .where(eq(nodes.id, nodeId));
    }
  }

  await recordEvent({
    nodeId,
    kind: "game_read",
    causeType: "job",
    after: {
      equilibriumType: g.equilibriumType,
      stability,
      outcomeIsEquilibrium: Boolean(g.outcomeIsEquilibrium),
    },
    model: OPUS,
  });

  return { gameRead: row ?? null, cost, offline };
}

// Latest game read for a node (for the GET /nodes/:id bundle).
export async function latestGameRead(nodeId: string): Promise<GameReadRow | null> {
  const [row] = await db
    .select()
    .from(gameReads)
    .where(eq(gameReads.nodeId, nodeId))
    .orderBy(desc(gameReads.createdAt))
    .limit(1);
  return row ?? null;
}
