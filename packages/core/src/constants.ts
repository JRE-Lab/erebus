import type { LensKey, Confidence } from "./types.js";

// Human-readable metadata for the seven Shadow Board lenses.
export const LENSES: Record<LensKey, { title: string; failureMode: string; short: string }> = {
  sourceReliability: {
    title: "Source Reliability",
    failureMode: "Trusting weak or unverified provenance",
    short: "Provenance & trustworthiness of the underlying evidence.",
  },
  confirmationBias: {
    title: "Confirmation Bias",
    failureMode: "Cherry-picking confirming evidence",
    short: "Is the theory only selecting evidence that confirms it?",
  },
  denialDeception: {
    title: "Denial & Deception",
    failureMode: "Signal deliberately planted or manipulated",
    short: "Could the signal be an intentional plant or manipulation?",
  },
  competingHypotheses: {
    title: "Competing Hypotheses (ACH)",
    failureMode: "Ignoring stronger alternative explanations",
    short: "Are stronger alternative explanations being ignored?",
  },
  incentiveAnalysis: {
    title: "Incentive Analysis (Cui Bono)",
    failureMode: "Missing who benefits from belief",
    short: "Who benefits if this theory is believed?",
  },
  logicalCoherence: {
    title: "Logical Coherence",
    failureMode: "Internal contradiction / fallacy",
    short: "Internal consistency and logical-fallacy check.",
  },
  baseRate: {
    title: "Base Rate",
    failureMode: "Ignoring prior probabilities",
    short: "Is the theory ignoring base rates and priors?",
  },
};

// Confidence ladder with numeric anchors for scoring.
export const CONFIDENCE_SCORE: Record<Confidence, number> = {
  DEAD: 0.0,
  SPECULATIVE: 0.2,
  EMERGING: 0.4,
  MEDIUM: 0.6,
  HIGH: 0.8,
  CONFIRMED: 0.95,
};

export const CONFIDENCE_COLORS: Record<Confidence, string> = {
  CONFIRMED: "#22c55e",
  HIGH: "#22c55e",
  MEDIUM: "#3b82f6",
  EMERGING: "#a855f7",
  SPECULATIVE: "#f59e0b",
  DEAD: "#6b7280",
};

export const EVIDENCE_COLORS = {
  confirmed: "#22c55e",
  partial: "#eab308",
  disconfirmed: "#ef4444",
  pending: "#94a3b8",
} as const;

// Theory Tree recursion budgets.
export const TREE_BUDGET = {
  maxDepth: 6,
  maxBranchesPerNode: 4,
  maxNodesPerTheory: 60,
};

// Default ingestion sources (seeded on first run).
export const DEFAULT_SOURCES: Array<{ name: string; url: string; tier: number }> = [
  { name: "Reuters World", url: "https://feeds.reuters.com/reuters/worldNews", tier: 1 },
  { name: "AP Top News", url: "https://rsshub.app/apnews/topics/apf-topnews", tier: 1 },
  { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml", tier: 1 },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", tier: 2 },
  { name: "Defense One", url: "https://www.defenseone.com/rss/", tier: 2 },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", tier: 2 },
];
