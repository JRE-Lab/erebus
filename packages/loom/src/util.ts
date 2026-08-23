// LOOM shared utilities — canonicalization + hashing (Phase 0).
import { createHash } from "node:crypto";

// R1 discipline lives in the schema (published_at vs first_seen_at); here we
// make sure the SAME story maps to the SAME row: canonical URLs + text hashes.

// Tracking params that create fake-distinct URLs for identical content.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "cmpid", "ns_mchannel",
]);

export function canonicalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    // sort remaining params for stability
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    // A truncated URL is a corrupt identity (two distinct articles could
    // collide on the unique url_canon index) — reject oversized ones instead.
    if (s.length > 2048) return null;
    return s;
  } catch {
    return null;
  }
}

export function textHash(title: string, lede: string): string {
  const norm = `${title}|${lede}`.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
