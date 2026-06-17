// Poll all enabled sources, ingest new events, update source health.
import { query } from "@erebus/db";
import type { Source } from "@erebus/core";
import { ingestFeed } from "./rss.js";

function broadcast(type: string, payload: unknown) {
  (globalThis as { broadcast?: (t: string, p: unknown) => void }).broadcast?.(type, payload);
}

export interface PollSummary {
  sources: number;
  inserted: number;
  errors: number;
}

export async function pollAllSources(): Promise<PollSummary> {
  const sources = await query<Source>("SELECT * FROM sources WHERE enabled = true");
  let inserted = 0;
  let errors = 0;

  for (const s of sources) {
    try {
      const r = await ingestFeed({ name: s.name, url: s.url });
      inserted += r.inserted;
      await query("UPDATE sources SET last_polled = now(), status = 'healthy' WHERE id = $1", [s.id]);
      if (r.inserted > 0) broadcast("ingestion", { source: s.name, inserted: r.inserted });
    } catch (err) {
      errors++;
      await query("UPDATE sources SET last_polled = now(), status = 'degraded' WHERE id = $1", [s.id]);
      console.warn(`[ingest] ${s.name} failed:`, (err as Error).message);
    }
  }

  if (inserted > 0) {
    await query(
      `INSERT INTO feed_items (type, title, summary, priority)
       VALUES ('ingestion', $1, $2, 'LOW')`,
      [`Ingested ${inserted} new events`, `Across ${sources.length} sources.`]
    );
  }
  return { sources: sources.length, inserted, errors };
}
