// Curated macro instrument catalog — the vocabulary theories are mapped onto and
// the default watchlist for the Market tab. Each entry carries source-specific
// symbols (Stooq + Yahoo) so the fetcher can fall back between free, no-key feeds.
export type Kind = "commodity" | "equity" | "index" | "fx" | "crypto";

export interface Instrument {
  symbol: string; // canonical id used everywhere in EREBUS
  name: string;
  kind: Kind;
  stooq: string; // Stooq ticker
  yahoo: string; // Yahoo ticker
  note: string; // what it tracks (helps the LLM map theories)
}

export const CATALOG: Instrument[] = [
  // --- energy ---
  { symbol: "CL", name: "WTI Crude Oil", kind: "commodity", stooq: "cl.f", yahoo: "CL=F", note: "US oil price; rises on supply fear / Middle East conflict" },
  { symbol: "BZ", name: "Brent Crude Oil", kind: "commodity", stooq: "cb.f", yahoo: "BZ=F", note: "global oil benchmark; chokepoint/OPEC sensitive" },
  { symbol: "NG", name: "Natural Gas", kind: "commodity", stooq: "ng.f", yahoo: "NG=F", note: "gas price; Europe/Russia energy supply sensitive" },
  { symbol: "XLE", name: "Energy Sector ETF", kind: "equity", stooq: "xle.us", yahoo: "XLE", note: "US energy majors (Exxon/Chevron); tracks oil profitability" },
  { symbol: "URA", name: "Uranium ETF", kind: "equity", stooq: "ura.us", yahoo: "URA", note: "uranium/nuclear; rises on nuclear buildout / energy security" },
  // --- metals / safe haven ---
  { symbol: "GC", name: "Gold", kind: "commodity", stooq: "gc.f", yahoo: "GC=F", note: "safe haven; rises on war, inflation, dollar distrust" },
  { symbol: "SI", name: "Silver", kind: "commodity", stooq: "si.f", yahoo: "SI=F", note: "industrial + safe-haven metal" },
  { symbol: "HG", name: "Copper", kind: "commodity", stooq: "hg.f", yahoo: "HG=F", note: "global growth barometer; demand-sensitive" },
  // --- equities / sectors ---
  { symbol: "SPX", name: "S&P 500", kind: "index", stooq: "^spx", yahoo: "^GSPC", note: "broad US equities; risk-on/off" },
  { symbol: "NDX", name: "Nasdaq 100", kind: "index", stooq: "^ndq", yahoo: "^NDX", note: "US tech-heavy index" },
  { symbol: "SMH", name: "Semiconductors ETF", kind: "equity", stooq: "smh.us", yahoo: "SMH", note: "chips (Nvidia/TSMC); AI + Taiwan/China-risk sensitive" },
  { symbol: "ITA", name: "Defense & Aerospace ETF", kind: "equity", stooq: "ita.us", yahoo: "ITA", note: "defense primes; rises on war / rearmament" },
  // --- macro / vol / fx / crypto ---
  { symbol: "VIX", name: "Volatility Index", kind: "index", stooq: "^vix", yahoo: "^VIX", note: "fear gauge; spikes on crisis/uncertainty" },
  { symbol: "DXY", name: "US Dollar Index", kind: "fx", stooq: "^dx", yahoo: "DX-Y.NYB", note: "USD strength; rises on flight-to-safety / Fed hawkishness" },
  { symbol: "TLT", name: "20Y+ Treasuries ETF", kind: "equity", stooq: "tlt.us", yahoo: "TLT", note: "long bonds; rises when rates fall / recession fear" },
  { symbol: "BTC", name: "Bitcoin", kind: "crypto", stooq: "btcusd", yahoo: "BTC-USD", note: "crypto risk asset / debasement hedge" },
];

const BY_SYMBOL = new Map(CATALOG.map((i) => [i.symbol, i]));
export const findInstrument = (symbol: string): Instrument | undefined =>
  BY_SYMBOL.get(symbol.toUpperCase());

// Compact vocabulary string for the theory->instrument mapping prompt.
export const catalogVocabulary = (): string =>
  CATALOG.map((i) => `${i.symbol} (${i.name}, ${i.kind}) — ${i.note}`).join("\n");
