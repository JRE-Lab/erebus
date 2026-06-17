// RSS/Atom ingestion: fetch a feed, parse items, dedup, embed, store as events.
import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { query, embed, toVectorLiteral } from "@erebus/db";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

interface ParsedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return v == null ? "" : String(v);
}

export function parseFeed(xml: string): ParsedItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  // RSS 2.0
  const rssItems = asArray(doc?.rss?.channel?.item);
  if (rssItems.length) {
    return rssItems.map((it: any) => ({
      title: textOf(it.title).trim(),
      link: textOf(it.link).trim(),
      description: textOf(it.description ?? it["content:encoded"]).replace(/<[^>]+>/g, "").trim(),
      pubDate: textOf(it.pubDate) || undefined,
    }));
  }
  // Atom
  const atomEntries = asArray(doc?.feed?.entry);
  return atomEntries.map((e: any) => {
    const link = Array.isArray(e.link) ? e.link[0]?.["@_href"] : e.link?.["@_href"] ?? textOf(e.link);
    return {
      title: textOf(e.title).trim(),
      link: String(link ?? "").trim(),
      description: textOf(e.summary ?? e.content).replace(/<[^>]+>/g, "").trim(),
      pubDate: textOf(e.updated ?? e.published) || undefined,
    };
  });
}

function hashItem(title: string, link: string): string {
  return createHash("sha256").update(`${title.toLowerCase().trim()}|${link.trim()}`).digest("hex");
}

export interface IngestResult {
  fetched: number;
  inserted: number;
}

export async function ingestFeed(source: { name: string; url: string }): Promise<IngestResult> {
  const res = await fetch(source.url, {
    headers: { "user-agent": "EREBUS/2.0 (+intelligence)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = parseFeed(xml).filter((i) => i.title && i.link);

  let inserted = 0;
  for (const it of items.slice(0, 50)) {
    const hash = hashItem(it.title, it.link);
    const exists = await query("SELECT 1 FROM events WHERE dedup_hash = $1", [hash]);
    if (exists.length) continue;
    const emb = await embed(`${it.title}\n${it.description}`);
    await query(
      `INSERT INTO events (source, source_type, url, title, body, published_at, dedup_hash, embedding)
       VALUES ($1,'rss',$2,$3,$4,$5,$6,$7::vector)
       ON CONFLICT (dedup_hash) DO NOTHING`,
      [
        source.name,
        it.link,
        it.title,
        it.description,
        it.pubDate ? new Date(it.pubDate).toISOString() : null,
        hash,
        toVectorLiteral(emb),
      ]
    );
    inserted++;
  }
  return { fetched: items.length, inserted };
}
