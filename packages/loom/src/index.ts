// ============================================================================
// @erebus/loom — narrative intelligence layer (LOOM_SPEC v0.1).
// Phase 0: ingestion + dual timestamps (R1). Free — no LLM, no embeddings.
//   - ingestLoom(): wire releases + outlet articles, canonical URLs, text hashes
//   - pullGdelt(): GDELT-via-BigQuery stub (activates with GCP credentials)
//   - loomStatus(): Phase 0 acceptance metrics (first_seen coverage, dedup rate)
// Phase 1 (next): clustering -> narratives, lifecycle machine, read-only tab.
// ============================================================================
export { ingestLoom, loomStatus } from "./ingest.js";
export type { LoomIngestResult, LoomStatus } from "./ingest.js";
export { pullGdelt, GKG_QUERY } from "./gdelt.js";
export type { GdeltPullResult } from "./gdelt.js";
export { canonicalizeUrl, textHash, domainOf } from "./util.js";
