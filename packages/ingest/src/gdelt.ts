// ============================================================================
// GDELT DOC 2.0 ingestion — free, no API key. Pulls recent worldwide news
// articles matching a broad geopolitics/energy/markets query, deduped + embedded
// into signals like RSS items. Configurable via GDELT_QUERY / GDELT_MAX.
// ============================================================================
import { eq, sql } from "drizzle-orm";
import { db, signals, embed, toVector } from "@erebus/db";
import { dedupHashFor } from "./rss.js";

const TIMEOUT_MS = 15_000;
const DEFAULT_QUERY =
  '(oil OR sanctions OR "strait of hormuz" OR military OR nuclear OR tariff OR escalation OR ceasefire OR "central bank" OR election OR semiconductor)';

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
}

// GDELT seendate looks like 20260618T010000Z (or without separators).
function parseSeenDate(s?: string): Date | null {
  if (!s) return null;
  const m = s.replace("T", "").replace("Z", "");
  if (m.length < 8) return null;
  const iso = `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}T${m.slice(8, 10) || "00"}:${
    m.slice(10, 12) || "00"
  }:${m.slice(12, 14) || "00"}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function ingestGdelt(): Promise<string[]> {
  const query = process.env.GDELT_QUERY || DEFAULT_QUERY;
  const max = Number(process.env.GDELT_MAX || 75);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=ArtList&format=json&maxrecords=${max}&timespan=1d&sort=DateDesc`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let articles: GdeltArticle[] = [];
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "erebus-ingest/2.0 (+corroboration-engine)" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { articles?: GdeltArticle[] };
    articles = j.articles ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const inserted: string[] = [];
  for (const a of articles) {
    const title = (a.title ?? "").trim();
    const link = (a.url ?? "").trim();
    if (!title || !link) continue;

    const dedupHash = dedupHashFor(title, link);
    const existing = await db
      .select({ id: signals.id })
      .from(signals)
      .where(eq(signals.dedupHash, dedupHash))
      .limit(1);
    if (existing.length) continue;

    const v = await embed(title);
    try {
      const [row] = await db
        .insert(signals)
        .values({
          source: a.domain || "gdelt",
          url: link,
          title,
          summary: null,
          dedupHash,
          publishedAt: parseSeenDate(a.seendate),
          embedding: sql.raw(`'${toVector(v)}'::vector`),
        })
        .onConflictDoNothing({ target: signals.dedupHash })
        .returning({ id: signals.id });
      if (row?.id) inserted.push(row.id);
    } catch {
      // best-effort
    }
  }
  return inserted;
}
