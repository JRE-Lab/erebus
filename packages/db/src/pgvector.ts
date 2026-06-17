import { query } from "./client.js";

// pgvector wants a literal like '[0.1,0.2,...]'.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export interface SimilarRow {
  id: number | string;
  distance: number;
}

// Cosine-distance nearest neighbours over a table with an `embedding` column.
export async function similaritySearch(
  table: "events" | "theories",
  embedding: number[],
  limit = 10
): Promise<SimilarRow[]> {
  const rows = await query<{ id: number | string; distance: number }>(
    `SELECT id, embedding <=> $1::vector AS distance
       FROM ${table}
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(embedding), limit]
  );
  return rows;
}
