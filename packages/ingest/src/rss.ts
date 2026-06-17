// ============================================================================
// RSS/Atom ingestion. Fetch a feed, parse items, dedup via sha256(title|url),
// embed (title + summary) into signals.embedding. Cap 50 items, 15s timeout.
// Everything is best-effort: a dead feed or empty body never crashes the loop.
// ============================================================================
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { eq, sql } from "drizzle-orm";
import { db, signals, embed, toVector } from "@erebus/db";

const MAX_ITEMS = 50;
const TIMEOUT_MS = 15_000;

export interface FeedSource {
  name: string;
  url: string;
}

export interface ParsedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

// fast-xml-parser yields a single object or an array depending on cardinality.
function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// A field may be a plain string, a number, or an object (e.g. CDATA / Atom
// link objects). Coerce to a clean string.
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return (o["#text"] as string).trim();
    if (typeof o["@_href"] === "string") return (o["@_href"] as string).trim();
  }
  return "";
}

// Atom <link> can be an array of objects; prefer rel="alternate" / no rel.
function atomLink(link: unknown): string {
  const arr = toArray(link as unknown);
  for (const l of arr) {
    if (l && typeof l === "object") {
      const o = l as Record<string, unknown>;
      const rel = typeof o["@_rel"] === "string" ? (o["@_rel"] as string) : "";
      if (rel === "alternate" || rel === "") {
        const href = asText(o["@_href"]);
        if (href) return href;
      }
    }
  }
  // fall back to the first link with any href, or a plain string link
  for (const l of arr) {
    const href = asText(l);
    if (href) return href;
  }
  return "";
}

function parseDate(v: unknown): Date | null {
  const s = asText(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Parse raw RSS or Atom XML into a normalized item list.
export function parseFeed(xml: string): ParsedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const items: ParsedItem[] = [];

  // --- RSS 2.0 / RDF: <rss><channel><item> or <rdf:RDF><item> ---
  const rss = doc["rss"] as Record<string, unknown> | undefined;
  const channel = rss?.["channel"] as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const rssItems = toArray(
    (channel?.["item"] ?? rdf?.["item"]) as unknown
  ) as Record<string, unknown>[];

  for (const it of rssItems) {
    const title = stripTags(asText(it["title"]));
    const url = asText(it["link"]) || asText(it["guid"]);
    const summary = stripTags(
      asText(it["description"]) || asText(it["content:encoded"]) || asText(it["summary"])
    );
    const publishedAt = parseDate(it["pubDate"] ?? it["dc:date"] ?? it["published"]);
    if (title || url) items.push({ title, url, summary, publishedAt });
  }

  // --- Atom: <feed><entry> ---
  const feed = doc["feed"] as Record<string, unknown> | undefined;
  const entries = toArray(feed?.["entry"] as unknown) as Record<string, unknown>[];
  for (const e of entries) {
    const title = stripTags(asText(e["title"]));
    const url = atomLink(e["link"]) || asText(e["id"]);
    const summary = stripTags(asText(e["summary"]) || asText(e["content"]));
    const publishedAt = parseDate(e["published"] ?? e["updated"]);
    if (title || url) items.push({ title, url, summary, publishedAt });
  }

  return items.slice(0, MAX_ITEMS);
}

export function dedupHashFor(title: string, url: string): string {
  return createHash("sha256").update(`${title}|${url}`).digest("hex");
}

async function fetchXml(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "erebus-ingest/2.0 (+corroboration-engine)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + parse a feed and insert any new signals. Returns the ids of rows
// that were actually inserted (skips existing dedupHash). Caps at 50 items.
export async function ingestFeed(source: FeedSource): Promise<string[]> {
  const xml = await fetchXml(source.url);
  if (!xml) return [];

  const items = parseFeed(xml);
  const insertedIds: string[] = [];

  for (const item of items) {
    const title = item.title;
    const url = item.url;
    if (!title && !url) continue;

    const dedupHash = dedupHashFor(title, url);

    // Skip if this dedupHash already exists.
    const existing = await db
      .select({ id: signals.id })
      .from(signals)
      .where(eq(signals.dedupHash, dedupHash))
      .limit(1);
    if (existing.length > 0) continue;

    const v = await embed(`${title}\n${item.summary}`.trim());
    try {
      const [row] = await db
        .insert(signals)
        .values({
          source: source.name,
          url: url || null,
          title: title || null,
          summary: item.summary || null,
          dedupHash,
          publishedAt: item.publishedAt,
          embedding: sql.raw(`'${toVector(v)}'::vector`),
        })
        .onConflictDoNothing({ target: signals.dedupHash })
        .returning({ id: signals.id });
      if (row?.id) insertedIds.push(row.id);
    } catch {
      // unique race or transient insert failure — best-effort, keep going.
    }
  }

  return insertedIds;
}
