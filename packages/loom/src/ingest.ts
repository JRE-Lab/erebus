// ============================================================================
// LOOM M1 (Phase 0 slice) — wire + outlet RSS ingestion with R1 dual
// timestamps. Everything here is FREE: plain HTTP fetches, hashing, inserts.
// No embeddings (Phase 1) and no LLM. first_seen_at is set by US at insert time
// and never trusted from the feed — that rule is the system's spine.
// ============================================================================
import { eq, sql } from "drizzle-orm";
import { db, loomOutlets, loomArticles, loomWireReleases } from "@erebus/db";
import { parseFeed } from "@erebus/ingest";
import { canonicalizeUrl, textHash, domainOf } from "./util.js";

interface FeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
}

// --- press-release wires (the provenance fingerprint library, spec M1) -------
// env LOOM_WIRE_FEEDS: "Name|url,Name|url". Defaults use stable public RSS.
function wireFeeds(): Array<{ name: string; url: string }> {
  const env = process.env.LOOM_WIRE_FEEDS;
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, url] = s.split("|");
        return { name: (name || "wire").trim(), url: (url || "").trim() };
      })
      .filter((f) => f.url);
  }
  return [
    { name: "PR Newswire", url: "https://www.prnewswire.com/rss/news-releases-list.rss" },
    {
      name: "GlobeNewswire",
      url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20Releases",
    },
  ];
}

// --- outlet feeds (sampled article stream; reuses EREBUS's source list) ------
function outletFeeds(): string[] {
  const env = process.env.LOOM_ARTICLE_FEEDS || process.env.NEWS_SOURCES;
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.theguardian.com/world/rss",
  ];
}

async function fetchFeed(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 EREBUS-LOOM/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`feed ${res.status}: ${url}`);
  return parseFeed(await res.text()) as FeedItem[];
}

async function outletIdFor(url: string): Promise<string | null> {
  const domain = domainOf(url);
  if (!domain) return null;
  const [existing] = await db.select({ id: loomOutlets.id }).from(loomOutlets).where(eq(loomOutlets.domain, domain)).limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(loomOutlets)
    .values({ name: domain, domain })
    .onConflictDoNothing()
    .returning({ id: loomOutlets.id });
  if (row) return row.id;
  const [again] = await db.select({ id: loomOutlets.id }).from(loomOutlets).where(eq(loomOutlets.domain, domain)).limit(1);
  return again?.id ?? null;
}

export interface LoomIngestResult {
  wires: number;
  articles: number;
  errors: string[];
}

export async function ingestLoom(): Promise<LoomIngestResult> {
  const errors: string[] = [];
  let wires = 0;
  let articles = 0;

  // 1) wire releases
  for (const feed of wireFeeds()) {
    try {
      const items = await fetchFeed(feed.url);
      for (const it of items) {
        const url = canonicalizeUrl(it.url);
        if (!url || !it.title) continue;
        const lede = (it.summary || "").slice(0, 1000);
        const [row] = await db
          .insert(loomWireReleases)
          .values({
            wireName: feed.name,
            url,
            title: it.title.slice(0, 500),
            lede,
            textHash: textHash(it.title, lede),
            publishedAt: it.publishedAt, // claimed (R1)
            // firstSeenAt: defaultNow()  — observed by US (R1)
          })
          .onConflictDoNothing()
          .returning({ id: loomWireReleases.id });
        if (row) wires++;
      }
    } catch (e) {
      errors.push(`wire ${feed.name}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  // 2) outlet articles (title + lede only in Phase 0)
  for (const feedUrl of outletFeeds()) {
    try {
      const items = await fetchFeed(feedUrl);
      for (const it of items) {
        const url = canonicalizeUrl(it.url);
        if (!url || !it.title) continue;
        const outletId = await outletIdFor(url);
        const lede = (it.summary || "").slice(0, 1000);
        const [row] = await db
          .insert(loomArticles)
          .values({
            urlCanon: url,
            outletId,
            title: it.title.slice(0, 500),
            lede,
            textHash: textHash(it.title, lede),
            publishedAt: it.publishedAt, // claimed (R1)
            // firstSeenAt: defaultNow()  — observed by US (R1)
          })
          .onConflictDoNothing()
          .returning({ id: loomArticles.id });
        if (row) articles++;
      }
    } catch (e) {
      errors.push(`outlet ${feedUrl}: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  return { wires, articles, errors };
}

// --- Phase 0 acceptance criteria (spec §7) -----------------------------------
// "72h unattended ingestion, dedup rate < 5% on audit, first_seen_at on 100%."
export interface LoomStatus {
  articlesTotal: number;
  wiresTotal: number;
  articles24h: number;
  wires24h: number;
  firstSeenCoveragePct: number; // must be 100
  dupTextHashPct: number; // near-dup rate proxy; accept < 5
  oldestFirstSeen: string | null;
  newestFirstSeen: string | null;
  // Phase 1 (narratives)
  articlesEmbedded: number;
  articlesAssigned: number;
  narrativesPromoted: number;
  narrativesCandidates: number;
  narrativesUnlabeled: number; // promoted but awaiting an LLM label
}

export async function loomStatus(): Promise<LoomStatus> {
  const res = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM loom_articles)                                                    AS articles_total,
      (SELECT count(*) FROM loom_wire_releases)                                               AS wires_total,
      (SELECT count(*) FROM loom_articles WHERE first_seen_at > now() - interval '24 hours')  AS articles_24h,
      (SELECT count(*) FROM loom_wire_releases WHERE first_seen_at > now() - interval '24 hours') AS wires_24h,
      (SELECT count(*) FROM loom_articles WHERE first_seen_at IS NULL)                        AS missing_first_seen,
      (SELECT count(*) - count(DISTINCT text_hash) FROM loom_articles WHERE text_hash IS NOT NULL) AS dup_hashes,
      (SELECT min(first_seen_at)::text FROM loom_articles)                                    AS oldest_fs,
      (SELECT max(first_seen_at)::text FROM loom_articles)                                    AS newest_fs,
      (SELECT count(*) FROM loom_articles WHERE embedding IS NOT NULL)                        AS embedded,
      (SELECT count(*) FROM loom_articles WHERE narrative_id IS NOT NULL)                     AS assigned,
      (SELECT count(*) FROM loom_narratives WHERE promoted_at IS NOT NULL)                    AS promoted,
      (SELECT count(*) FROM loom_narratives WHERE promoted_at IS NULL)                        AS candidates,
      (SELECT count(*) FROM loom_narratives WHERE promoted_at IS NOT NULL AND label IS NULL)  AS unlabeled
  `);
  const r = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
  const total = Number(r.articles_total ?? 0);
  return {
    articlesTotal: total,
    wiresTotal: Number(r.wires_total ?? 0),
    articles24h: Number(r.articles_24h ?? 0),
    wires24h: Number(r.wires_24h ?? 0),
    firstSeenCoveragePct: total === 0 ? 100 : Math.round(((total - Number(r.missing_first_seen ?? 0)) / total) * 1000) / 10,
    dupTextHashPct: total === 0 ? 0 : Math.round((Number(r.dup_hashes ?? 0) / total) * 1000) / 10,
    oldestFirstSeen: (r.oldest_fs as string) ?? null,
    newestFirstSeen: (r.newest_fs as string) ?? null,
    articlesEmbedded: Number(r.embedded ?? 0),
    articlesAssigned: Number(r.assigned ?? 0),
    narrativesPromoted: Number(r.promoted ?? 0),
    narrativesCandidates: Number(r.candidates ?? 0),
    narrativesUnlabeled: Number(r.unlabeled ?? 0),
  };
}
