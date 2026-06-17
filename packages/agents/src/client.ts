// ============================================================================
// Tiered Anthropic client. Opus for debate/synthesis/shadow; Sonnet for bulk.
// Every call logs spend to exploration_jobs (governors read this). Offline
// fallback returns { offline:true } so the whole system runs with no key.
// ============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { db, explorationJobs } from "@erebus/db";

const OPUS = process.env.OPUS_MODEL || "claude-opus-4-8";
const SONNET = process.env.SONNET_MODEL || "claude-sonnet-4-6";

const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

let _c: Anthropic | null = null;
function client(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_c) _c = new Anthropic({ apiKey: key });
  return _c;
}

export function llmLive(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function cost(model: string, i: number, o: number): number {
  const p = PRICING[model] ?? { in: 15, out: 75 };
  return (p.in * i + p.out * o) / 1_000_000;
}

async function logSpend(type: string, model: string, i: number, o: number, c: number, targetNode?: string) {
  try {
    await db.insert(explorationJobs).values({
      type,
      targetNode: targetNode ?? null,
      status: "done",
      inputTokens: i,
      outputTokens: o,
      costUsd: c,
      finishedAt: new Date(),
    });
  } catch {
    /* non-fatal */
  }
}

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let n = 0; n <= tries; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const s = (e as { status?: number }).status;
      if (s === 429 || (s && s >= 500)) {
        await new Promise((r) => setTimeout(r, 2 ** n * 800 + Math.random() * 400));
        continue;
      }
      throw e;
    }
  }
  throw last;
}

export interface CallOpts {
  tier?: "opus" | "sonnet";
  system?: string;
  maxTokens?: number;
  agent?: string;
  targetNode?: string;
}

export interface LLMResult {
  content: string;
  cost: number;
  model: string;
  offline: boolean;
  usage: { input: number; output: number };
}

export async function call(prompt: string, opts: CallOpts = {}): Promise<LLMResult> {
  const model = opts.tier === "sonnet" ? SONNET : OPUS;
  const c = client();
  if (!c) {
    return { content: "", cost: 0, model, offline: true, usage: { input: 0, output: 0 } };
  }
  const res = await retry(() =>
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
  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };
  const spend = cost(model, usage.input, usage.output);
  await logSpend(opts.agent || "agent", model, usage.input, usage.output, spend, opts.targetNode);
  return { content, cost: spend, model, offline: false, usage };
}

// JSON helper: strict JSON, fence-stripping, fallback on offline/parse failure.
export async function callJSON<T>(prompt: string, fallback: T, opts: CallOpts = {}): Promise<{ data: T; cost: number; offline: boolean }> {
  const system = (opts.system ? opts.system + "\n\n" : "") + "Respond with ONLY valid JSON — no prose, no markdown fences.";
  const r = await call(prompt, { ...opts, system });
  if (r.offline || !r.content) return { data: fallback, cost: 0, offline: true };
  try {
    const cleaned = r.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return { data: JSON.parse(cleaned) as T, cost: r.cost, offline: false };
  } catch {
    return { data: fallback, cost: r.cost, offline: false };
  }
}

export { OPUS, SONNET };
