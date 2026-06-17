// ============================================================================
// EREBUS v2 — shared domain types. Mirrors packages/db/schema.sql.
// ============================================================================

export type Confidence =
  | "SPECULATIVE"
  | "EMERGING"
  | "MEDIUM"
  | "HIGH"
  | "CONFIRMED"
  | "DEAD";

export type TheoryStatus = "ACTIVE" | "DORMANT" | "DEAD" | "ARCHIVED";

export type EvidenceStatus = "pending" | "confirmed" | "partial" | "disconfirmed";

export type LensVerdictValue = "pass" | "warn" | "fail";

export type ConnectionRelationship =
  | "supports"
  | "contradicts"
  | "tension"
  | "explains"
  | "predicts"
  | "deepens";

export type FeedItemType =
  | "theory_update"
  | "evidence"
  | "connection"
  | "shadow"
  | "ingestion"
  | "prediction"
  | "system";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

// The seven Shadow Board lenses.
export const LENS_KEYS = [
  "sourceReliability",
  "confirmationBias",
  "denialDeception",
  "competingHypotheses",
  "incentiveAnalysis",
  "logicalCoherence",
  "baseRate",
] as const;
export type LensKey = (typeof LENS_KEYS)[number];

export interface EventRecord {
  id: number;
  source: string;
  source_type: string;
  url: string | null;
  title: string;
  body: string | null;
  author: string | null;
  published_at: string | null;
  observed_at: string;
  dedup_hash: string | null;
  metadata: Record<string, unknown>;
}

export interface Theory {
  id: string;
  slug: string | null;
  title: string;
  summary: string;
  full_analysis: string;
  confidence: Confidence;
  score: number;
  status: TheoryStatus;
  domains: string[];
  is_shadow: boolean;
  novelty: { score?: number; reason?: string };
  change_everything: string | null;
  root_event_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceDetail {
  summary?: string;
  confidence?: number;
  supporting?: string[];
  contradicting?: string[];
  key_indicator?: string;
  manual?: boolean;
  checked_at?: string;
}

export interface TheoryNode {
  id: string;
  theory_id: string;
  parent_id: string | null;
  hypothesis: string;
  content: string;
  questions: string[];
  wildcard: string | null;
  key_insight: string | null;
  depth: number;
  score: number;
  explored_by: "user" | "erebus";
  shadow_tagged: boolean;
  financial_signal: boolean;
  evidence_status: EvidenceStatus;
  evidence: EvidenceDetail;
  evidence_checked_at: string | null;
  created_at: string;
  children?: TheoryNode[];
}

export interface LensVerdict {
  id: number;
  theory_id: string | null;
  node_id: string | null;
  lens: LensKey;
  verdict: LensVerdictValue;
  severity: number;
  confidence: number;
  rationale: string;
  created_at: string;
}

export interface ShadowBoardResult {
  theoryId: string;
  verdicts: Array<{
    lens: LensKey;
    verdict: LensVerdictValue;
    severity: number;
    confidence: number;
    rationale: string;
  }>;
  overall: { verdict: LensVerdictValue; severity: number; summary: string };
  cost: number;
}

export interface TheoryConnection {
  id: number;
  a_id: string;
  b_id: string;
  relationship: ConnectionRelationship;
  strength: number;
  rationale: string | null;
  created_at: string;
}

export interface Prediction {
  id: string;
  theory_id: string;
  statement: string;
  deadline: string | null;
  status: "PENDING" | "CONFIRMED" | "REFUTED" | "EXPIRED";
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface FeedItem {
  id: number;
  type: FeedItemType;
  title: string;
  summary: string;
  priority: Priority;
  related_theory_ids: string[];
  read: boolean;
  created_at: string;
}

export interface Source {
  id: number;
  name: string;
  type: "rss" | "newsapi";
  url: string;
  enabled: boolean;
  tier: number;
  last_polled: string | null;
  status: "healthy" | "degraded" | "down";
  created_at: string;
}

export interface CostEntry {
  id: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  agent: string | null;
  created_at: string;
}

// LLM client response shape (used across engine + shadowboard).
export interface LLMResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  cost: number;
  model: string;
  offline?: boolean;
}

// Result of expanding a Theory Tree node.
export interface NodeExpansion {
  content: string;
  questions: string[];
  wildcard: string;
  keyInsight: string;
  shadowFlag: boolean;
  financialSignal: boolean;
}
