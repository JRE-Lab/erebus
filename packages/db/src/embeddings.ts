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

// Transient provider errors retry with backoff (mirrors the LLM client) —
// embeds often run AFTER a paid LLM call, so a single 429 must not discard
// paid output (review: the throw-without-retry version created a burn loop).
async function retryFetch(fn: () => Promise<Response>, label: string): Promise<Response> {
  let last: Response | null = null;
  for (let n = 0; n <= 2; n++) {
    const res = await fn();
    if (res.ok) return res;
    last = res;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2 ** n * 700));
      continue;
    }
    break; // 4xx other than 429: not retryable
  }
  // Provider ERROR must throw, not silently store a hash-space vector: a stored
  // offline embedding is permanent corpus poison (mismatched space forever),
  // whereas a thrown error just defers the item to the next tick.
  throw new Error(`${label} embeddings ${last?.status ?? "error"}`);
}

async function openaiEmbed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return offlineEmbed(text); // zero-key mode is deliberate
  const res = await retryFetch(
    () =>
      fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          input: text.slice(0, 8000),
          model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
          dimensions: EMBEDDING_DIM,
        }),
      }),
    "openai"
  );
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data[0]!.embedding;
}

async function voyageEmbed(text: string): Promise<number[]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return offlineEmbed(text);
  const res = await retryFetch(
    () =>
      fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          input: text.slice(0, 8000),
          model: process.env.VOYAGE_MODEL || "voyage-3.5",
          output_dimension: EMBEDDING_DIM,
        }),
      }),
    "voyage"
  );
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data[0]!.embedding;
}

// Whether embed() would return a REAL provider vector right now (vs the
// deterministic hash-space fallback). Callers that PERSIST embeddings for
// similarity work (LOOM clustering) must check this first: a stored offline
// vector is permanent corpus poison, so when this is false they skip the item
// and retry next tick instead of storing junk. isPaused() is cached, so this
// is cheap enough to call per item inside a batch loop.
export async function embeddingsLive(): Promise<boolean> {
  if (PROVIDER === "openai" && !process.env.OPENAI_API_KEY) return false;
  if (PROVIDER === "voyage" && !process.env.VOYAGE_API_KEY) return false;
  if (PROVIDER !== "openai" && PROVIDER !== "voyage") return false;
  return !(await isPaused());
}

export async function embed(text: string): Promise<number[]> {
  if (!text?.trim()) return new Array<number>(EMBEDDING_DIM).fill(0);
  // Global pause kill-switch — never hit a paid embedding API while paused.
  if (await isPaused()) return offlineEmbed(text);
  if (PROVIDER === "openai") return openaiEmbed(text);
  if (PROVIDER === "voyage") return voyageEmbed(text);
  return offlineEmbed(text);
}

// Strict variant for callers that PERSIST vectors: throws instead of degrading
// to the hash-space fallback. embed()'s internal isPaused() re-read can flip
// mid-batch (4s cache TTL) and silently hand back a poison vector even after
// an embeddingsLive() pre-check — this variant never calls the fallback at
// all, so the store path is structurally incapable of persisting one.
export async function embedStrict(text: string): Promise<number[]> {
  if (!(await embeddingsLive())) throw new Error("embeddings not live (paused/keyless)");
  if (!text?.trim()) throw new Error("embedStrict: empty text");
  return PROVIDER === "voyage" ? voyageEmbed(text) : openaiEmbed(text);
}
