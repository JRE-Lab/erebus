// ============================================================================
// @erebus/loom — narrative intelligence layer (LOOM_SPEC v0.1).
// Phase 0: ingestion + dual timestamps (R1).
//   - ingestLoom() / loomStatus() / pullGdelt() (BigQuery-gated stub)
// Phase 1: narratives.
//   - runLoomPass(): embed -> assign -> promote -> label -> lifecycle ->
//     entities -> framing -> intent -> forecasts -> playbook matcher, ALL
//     under one cross-process advisory lock (the hourly write entry point)
//   - listLoomNarratives()/getLoomNarrative(): read layer (centroid never leaves)
// Phase 2: entity graph + market linkage.
//   - resolveNarrativeEntities(), narrativeInstruments(), refreshLoomPrices(),
//     runEventStudies()
// Phase 3: positioning + placebo (R4) + regimes.
//   - runLoomMarketPass(): the free heavy pass (prices/detectors/regimes/
//     event studies/placebo/flags/resolutions) on its own lock + cadence
// Phase 4: intent (ACH + ICD 203 + R2 falsifiers), forecasts (R3 append-only),
//   scoreboard (R6), playbook pilot (M9).
//   - loomScoreboard(), generatePlaybooks(theoryRef)
// Phase 5: analogs (M7, self-corpus — priors only when the precedent set is
//   deep enough, else the hand-set prior stands and says so), source/actor
//   behavioral priors (M4), negative space (M10 asymmetry + displacement),
//   playbook confidence decay + retirement (M9 automation). Options-flow and
//   social velocity remain unbuilt: both require paid vendors.
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
export { runLoomMarketPass } from "./marketpass.js";
export type { LoomMarketPassResult } from "./marketpass.js";
export { loomScoreboard } from "./forecasts.js";
export type { LoomHeadScore } from "./forecasts.js";
export { generatePlaybooks, decayPlaybooks } from "./playbooks.js";
export type { PlaybookGenResult } from "./playbooks.js";
export { buildAnalogs, lifecyclePrior, marketPrior, narrativeAnalogs } from "./analogs.js";
export type { LoomAnalogResult, AnalogPrior } from "./analogs.js";
export { runSourceGraph, narrativeSourcePriors, narrativeNegativeSpace } from "./sourcegraph.js";
export type { LoomSourceGraphResult } from "./sourcegraph.js";
