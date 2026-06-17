// ============================================================================
// "What Changed Since You Left" digest (CLAUDE.md §10, Phase 7 gate).
//
// whatChanged(sinceISO) reads the provenance ledger + nodes table to report,
// since a timestamp:
//   newNodes     — nodes created after `since` (kind='created' events).
//   newlyGreen   — state_change events whose `after.state` became 'corroborated'.
//   resolved     — nodes resolved after `since` (kind='resolved' events), split
//                  into true/false.
//   newMatches   — signal_matches landed after `since` (reality engaging the tree).
//
// Returns both a short human-readable line and the structured object. Fully
// guarded: any read failure yields zeroed counts, never throws.
// ============================================================================
import { pool } from "@erebus/db";

export interface ChangeDigest {
  since: string;
  newNodes: number;
  newlyGreen: number;
  resolvedTrue: number;
  resolvedFalse: number;
  newMatches: number;
  text: string;
}

function emptyDigest(since: string): ChangeDigest {
  return {
    since,
    newNodes: 0,
    newlyGreen: 0,
    resolvedTrue: 0,
    resolvedFalse: 0,
    newMatches: 0,
    text: `No changes since ${since}.`,
  };
}

export async function whatChanged(sinceISO: string): Promise<ChangeDigest> {
  // Normalise / validate the timestamp; bad input => "no changes" rather than throw.
  const since = new Date(sinceISO);
  if (Number.isNaN(since.getTime())) return emptyDigest(sinceISO);
  const iso = since.toISOString();

  try {
    // New nodes: count distinct 'created' provenance events since `since`.
    const newNodesRes = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM events
        WHERE kind = 'created' AND created_at >= $1`,
      [iso]
    );

    // Newly green: state_change events whose after->>'state' is 'corroborated'.
    const greenRes = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM events
        WHERE kind = 'state_change'
          AND created_at >= $1
          AND after ->> 'state' = 'corroborated'`,
      [iso]
    );

    // Resolved: split true/false from the resolved events' after->>'resolved'.
    const resolvedRes = await pool.query<{ resolved: string | null; c: number }>(
      `SELECT (after ->> 'resolved') AS resolved, COUNT(*)::int AS c
         FROM events
        WHERE kind = 'resolved' AND created_at >= $1
        GROUP BY (after ->> 'resolved')`,
      [iso]
    );
    let resolvedTrue = 0;
    let resolvedFalse = 0;
    for (const row of resolvedRes.rows) {
      // after.resolved is a JSON boolean; serialized as 'true' / 'false'.
      if (row.resolved === "true") resolvedTrue += Number(row.c);
      else resolvedFalse += Number(row.c);
    }

    // New signal matches — reality engaging the tree since `since`.
    const matchRes = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
         FROM signal_matches
        WHERE created_at >= $1`,
      [iso]
    );

    const newNodes = Number(newNodesRes.rows[0]?.c ?? 0);
    const newlyGreen = Number(greenRes.rows[0]?.c ?? 0);
    const newMatches = Number(matchRes.rows[0]?.c ?? 0);

    const parts: string[] = [];
    parts.push(`${newNodes} new node${newNodes === 1 ? "" : "s"}`);
    parts.push(`${newlyGreen} newly green`);
    if (resolvedTrue || resolvedFalse) {
      parts.push(`${resolvedTrue + resolvedFalse} resolved (${resolvedTrue}✓/${resolvedFalse}✗)`);
    } else {
      parts.push(`0 resolved`);
    }
    parts.push(`${newMatches} signal match${newMatches === 1 ? "" : "es"}`);

    const text = `Since ${iso}: ${parts.join(", ")}.`;

    return {
      since: iso,
      newNodes,
      newlyGreen,
      resolvedTrue,
      resolvedFalse,
      newMatches,
      text,
    };
  } catch {
    return emptyDigest(iso);
  }
}
