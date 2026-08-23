// ============================================================================
// @erebus/loom — narrative intelligence layer (LOOM_SPEC v0.1).
// Phase 0: ingestion + dual timestamps (R1). Free — no LLM, no embeddings.
//   - ingestLoom(): wire releases + outlet articles, canonical URLs, text hashes
//   - pullGdelt(): GDELT-via-BigQuery stub (activates with GCP credentials)
//   - loomStatus(): Phase 0 acceptance metrics (first_seen coverage, dedup rate)
// Phase 1: narratives.
//   - runLoomPass(): embed -> assign -> promote -> label -> lifecycle, ALL
//     under one cross-process advisory lock (the only write entry point)
//   - listLoomNarratives()/getLoomNarrative(): read layer (centroid never leaves)
// ============================================================================
export { ingestLoom, loomStatus } from "./ingest.js";
export type { LoomIngestResult, LoomStatus } from "./ingest.js";
export { pullGdelt, GKG_QUERY } from "./gdelt.js";
export type { GdeltPullResult } from "./gdelt.js";
export { canonicalizeUrl, textHash, domainOf } from "./util.js";
export { runLoomPass } from "./cluster.js";
export type { LoomClusterResult, LoomPassResult } from "./cluster.js";
export type { LoomLifecycleResult, LoomState } from "./lifecycle.js";
export { listLoomNarratives, getLoomNarrative } from "./queries.js";
export type { LoomNarrativeCard, LoomNarrativeDetail } from "./queries.js";
