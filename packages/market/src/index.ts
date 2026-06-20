// ============================================================================
// @erebus/market — market/commodities correlation. Theories are mapped to
// instruments (LLM), free no-key feeds (Stooq->Yahoo) supply daily closes, and
// significant aligned/opposed moves become evidence signals that green or
// contradict the linked forecasts. Read model for the Market tab included.
// ============================================================================
export { CATALOG, findInstrument, catalogVocabulary } from "./catalog.js";
export type { Instrument, Kind } from "./catalog.js";
export { fetchCandles, getQuote, changePct } from "./sources.js";
export type { Candles, Quote } from "./sources.js";
export { mapTheory, mapUnmappedTheories } from "./map.js";
export { refreshMarket } from "./correlate.js";
export { resolveByMarket } from "./resolve.js";
export { getMarketOverview } from "./overview.js";
export type {
  MarketOverview,
  OverviewInstrument,
  TheoryCorrelation,
  TheoryLink,
} from "./overview.js";
