import { pool } from "./client.js";

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

export interface Neighbor {
  id: string;
  distance: number;
}

// Cosine-distance nearest neighbours over nodes or signals.
export async function nearest(
  table: "nodes" | "signals",
  embedding: number[],
  limit = 10
): Promise<Neighbor[]> {
  const res = await pool.query(
    `SELECT id::text AS id, embedding <=> $1::vector AS distance
       FROM ${table}
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [toVector(embedding), limit]
  );
  return res.rows as Neighbor[];
}
