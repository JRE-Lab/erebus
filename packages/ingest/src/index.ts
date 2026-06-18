// ============================================================================
// @erebus/ingest — the Corroboration Engine ("the green"). Pull signals from
// configured feeds, then match each new signal to forecast nodes to green/red
// the tree. Fully offline-safe: no feeds + no LLM key => {signals:0, matches:0}.
// ============================================================================
import { ingestFeed, type FeedSource } from "./rss.js";
import { ingestGdelt } from "./gdelt.js";
import { matchSignal } from "./match.js";

// Parse NEWS_SOURCES (comma-separated feed URLs) into sources, naming each by
// its hostname. Malformed entries fall back to the raw string as the name.
export function sources(): FeedSource[] {
  const raw = process.env.NEWS_SOURCES || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => {
      let name = url;
      try {
        name = new URL(url).hostname;
      } catch {
        /* keep raw string as the name */
      }
      return { name, url };
    });
}

export interface IngestResult {
  signals: number;
  matches: number;
}

// Ingest every configured source, then match each newly inserted signal.
// Returns counts of signals ingested and signal_matches rows created.
export async function ingestAll(): Promise<IngestResult> {
  const srcs = sources();
  const newSignalIds: string[] = [];

  for (const src of srcs) {
    try {
      const ids = await ingestFeed(src);
      newSignalIds.push(...ids);
    } catch {
      // a single bad feed never kills the whole pull.
    }
  }

  // GDELT (free, no key) — broad geopolitical/energy/markets pull, when enabled.
  if ((process.env.GDELT_ENABLED ?? "true") !== "false") {
    try {
      newSignalIds.push(...(await ingestGdelt()));
    } catch {
      // GDELT outages never kill the pull.
    }
  }

  let matches = 0;
  for (const signalId of newSignalIds) {
    try {
      const made = await matchSignal(signalId);
      matches += made.length;
    } catch {
      // a single bad match never kills the whole cycle.
    }
  }

  return { signals: newSignalIds.length, matches };
}

export { ingestFeed } from "./rss.js";
export { ingestGdelt } from "./gdelt.js";
export { matchSignal, matchNode, rematchRecent } from "./match.js";
export type { FeedSource } from "./rss.js";
export type { MatchRecord } from "./match.js";
