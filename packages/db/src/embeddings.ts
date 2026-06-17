// Provider-swappable embeddings. Defaults to a deterministic offline fallback
// so EREBUS runs with zero embedding keys; set EMBEDDING_PROVIDER=voyage|openai
// for real semantic vectors.
import { createHash } from "node:crypto";

const DIM = Number(process.env.EMBEDDING_DIM || 1024);
const PROVIDER = (process.env.EMBEDDING_PROVIDER || "offline").toLowerCase();

export function embeddingDim(): number {
  return DIM;
}

// Deterministic, dependency-free pseudo-embedding. Not semantically meaningful,
// but stable and unit-normalized so the pipeline (and pgvector) works offline.
function offlineEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const h = createHash("sha256").update(tok).digest();
    for (let i = 0; i < h.length; i++) {
      const idx = (h[i]! + i * 31) % DIM;
      vec[idx]! += (h[i]! / 255) * 2 - 1;
    }
  }
  let norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

async function voyageEmbed(text: string): Promise<number[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return offlineEmbed(text);
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      input: text.slice(0, 8000),
      model: process.env.VOYAGE_MODEL || "voyage-3.5",
      output_dimension: DIM,
    }),
  });
  if (!res.ok) {
    console.warn("[embeddings] voyage failed, using offline:", res.status);
    return offlineEmbed(text);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0]!.embedding;
}

async function openaiEmbed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return offlineEmbed(text);
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      input: text.slice(0, 8000),
      model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      dimensions: DIM,
    }),
  });
  if (!res.ok) {
    console.warn("[embeddings] openai failed, using offline:", res.status);
    return offlineEmbed(text);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0]!.embedding;
}

export async function embed(text: string): Promise<number[]> {
  if (!text?.trim()) return new Array<number>(DIM).fill(0);
  if (PROVIDER === "voyage") return voyageEmbed(text);
  if (PROVIDER === "openai") return openaiEmbed(text);
  return offlineEmbed(text);
}
