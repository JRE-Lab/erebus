// ============================================================================
// Claude client — model-swappable (deep/fast), cost-tracked to DB, retry +
// graceful OFFLINE fallback so EREBUS runs with no API key (degraded).
// ============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { query } from "@erebus/db";
import type { LLMResponse } from "@erebus/core";

const MODEL_DEEP = process.env.ANTHROPIC_MODEL_DEEP || "claude-opus-4-8";
const MODEL_FAST = process.env.ANTHROPIC_MODEL_FAST || "claude-sonnet-4-6";

// Approx per-token USD (input, output) per million. Update if pricing changes.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

let _client: Anthropic | null = null;
function client(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

export function isLive(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] ?? { in: 15, out: 75 };
  return (p.in * inTok + p.out * outTok) / 1_000_000;
}

async function logCost(model: string, inTok: number, outTok: number, cost: number, agent: string) {
  try {
    await query(
      `INSERT INTO cost_entries (model, input_tokens, output_tokens, cost_usd, agent)
       VALUES ($1,$2,$3,$4,$5)`,
      [model, inTok, outTok, cost, agent]
    );
  } catch {
    /* non-fatal */
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status === 429 || (status && status >= 500)) {
        await new Promise((r) => setTimeout(r, 2 ** i * 800 + Math.random() * 400));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

interface CallOpts {
  tier?: "deep" | "fast";
  maxTokens?: number;
  agent?: string;
  system?: string;
}

// Core call. Returns offline:true with empty content when no API key is set.
export async function callClaude(prompt: string, opts: CallOpts = {}): Promise<LLMResponse> {
  const model = opts.tier === "fast" ? MODEL_FAST : MODEL_DEEP;
  const agent = opts.agent || "claude";
  const c = client();
  if (!c) {
    return { content: "", usage: { input_tokens: 0, output_tokens: 0 }, cost: 0, model, offline: true };
  }
  const res = await withRetry(() =>
    c.messages.create({
      model,
      max_tokens: opts.maxTokens || 4096,
      system: opts.system,
      messages: [{ role: "user", content: prompt }],
    })
  );
  const content = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
  const usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
  const cost = estimateCost(model, usage.input_tokens, usage.output_tokens);
  await logCost(model, usage.input_tokens, usage.output_tokens, cost, agent);
  return { content, usage, cost, model };
}

// JSON helper: instructs strict JSON, strips fences, parses. Returns fallback
// (and offline flag) when the model is unavailable or output is unparseable.
export async function callClaudeJSON<T>(
  prompt: string,
  fallback: T,
  opts: CallOpts = {}
): Promise<{ data: T; cost: number; offline: boolean }> {
  const sys =
    (opts.system ? opts.system + "\n\n" : "") +
    "Respond with ONLY valid JSON. No prose, no markdown fences.";
  const res = await callClaude(prompt, { ...opts, system: sys });
  if (res.offline || !res.content) return { data: fallback, cost: 0, offline: true };
  try {
    const cleaned = res.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return { data: JSON.parse(cleaned) as T, cost: res.cost, offline: false };
  } catch {
    return { data: fallback, cost: res.cost, offline: false };
  }
}

export { MODEL_DEEP, MODEL_FAST };
