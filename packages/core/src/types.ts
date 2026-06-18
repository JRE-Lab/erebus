import type { nodes, signals } from "@erebus/db";

export type NodeRow = typeof nodes.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;

export type NodeState =
  | "speculative"
  | "corroborating"
  | "corroborated"
  | "contradicted"
  | "tipping" // confirming on reality, but sitting on a FRAGILE equilibrium
  | "resolved_true"
  | "resolved_false"
  | "dormant"
  | "merged";

export type MatchEffect = "confirm" | "refute" | "neutral";

export type RelationshipType =
  | "supports"
  | "contradicts"
  | "depends_on"
  | "validates"
  | "tension"
  | "best_response_to"
  | "deters";

// A node enriched with its children, for tree rendering.
export interface TreeNode extends NodeRow {
  children: TreeNode[];
}

export const STATE_COLORS: Record<NodeState, string> = {
  speculative: "#6b7280", // gray
  corroborating: "#f59e0b", // amber
  corroborated: "#22c55e", // green
  contradicted: "#ef4444", // red
  tipping: "#a855f7", // violet — greening but knife-edge (fragile equilibrium)
  resolved_true: "#16a34a",
  resolved_false: "#7f1d1d",
  dormant: "#3f3f46",
  merged: "#52525b",
};
