// Provider-swappable embeddings with a deterministic OFFLINE fallback so the
// whole system runs with zero keys. Dimension fixed at 1536 (schema-baked).
import { createHash } from "node:crypto";
import { isPaused } from "./settings.js";

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);
const PROVIDER = (process.env.EMBEDDING_PROVIDER || "offline").toLowerCase();

function offlineEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const h = createHash("sha256").update(tok).digest();
    for (let i = 0; i < h.length; i++) {
      const idx = (h[i]! + i * 131) % EMBEDDING_DIM;
      vec[idx]! += (h[i]! / 255) * 2 - 1;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
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
      dimensions: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) return offlineEmbed(text);
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data[0]!.embedding;
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
      output_dimension: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) return offlineEmbed(text);
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data[0]!.embedding;
}

export async function embed(text: string): Promise<number[]> {
  if (!text?.trim()) return new Array<number>(EMBEDDING_DIM).fill(0);
  // Global pause kill-switch — never hit a paid embedding API while paused.
  if (await isPaused()) return offlineEmbed(text);
  if (PROVIDER === "openai") return openaiEmbed(text);
  if (PROVIDER === "voyage") return voyageEmbed(text);
  return offlineEmbed(text);
}
