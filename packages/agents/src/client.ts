// ============================================================================
// Multi-provider reasoning client. Anthropic (Claude) + OpenAI (GPT), with
// automatic fallback. LLM_PROVIDER = auto | anthropic | openai.
//  - auto (default): try Claude; on credit/auth/quota error fall back to OpenAI.
//  - anthropic / openai: force one provider.
// Tiers map per provider: deep = Opus / gpt-4o; fast = Sonnet / gpt-4o-mini.
// Every call logs spend to exploration_jobs. Offline only if NO provider key.
// ============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { db, explorationJobs } from "@erebus/db";

const PROVIDER = (process.env.LLM_PROVIDER || "auto").toLowerCase();
const OPUS = process.env.OPUS_MODEL || "claude-opus-4-8";
const SONNET = process.env.SONNET_MODEL || "claude-sonnet-4-6";
const OAI_DEEP = process.env.OPENAI_DEEP_MODEL || "gpt-4o";
const OAI_FAST = process.env.OPENAI_FAST_MODEL || "gpt-4o-mini";

// USD per million tokens (input, output).
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

function anthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }
function openaiKey() { return process.env.OPENAI_API_KEY || ""; }
export function hasAnthropic() { return Boolean(anthropicKey()); }
export function hasOpenAI() { return Boolean(openaiKey()); }
export function llmLive() { return hasAnthropic() || hasOpenAI(); }

let _anth: Anthropic | null = null;
function anth(): Anthropic {
  if (!_anth) _anth = new Anthropic({ apiKey: anthropicKey() });
  return _anth;
}

function cost(model: string, i: number, o: number): number {
  const p = PRICING[model] ?? { in: 5, out: 15 };
  return (p.in * i + p.out * o) / 1_000_000;
}

async function logSpend(type: string, model: string, i: number, o: number, c: number, targetNode?: string) {
  try {
    await db.insert(explorationJobs).values({
      type, targetNode: targetNode ?? null, status: "done",
      inputTokens: i, outputTokens: o, costUsd: c, finishedAt: new Date(),
    });
  } catch { /* non-fatal */ }
}

async function retry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let n = 0; n <= tries; n++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const s = (e as { status?: number }).status;
      if (s === 429 || (s && s >= 500)) { await new Promise((r) => setTimeout(r, 2 ** n * 800)); continue; }
      throw e;
    }
  }
  throw last;
}

interface Raw { content: string; input: number; output: number; model: string; }

async function callAnthropic(model: string, system: string | undefined, prompt: string, maxTokens: number): Promise<Raw> {
  const res = await retry(() =>
    anth().messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] })
  );
  const content = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n");
  return { content, input: res.usage.input_tokens, output: res.usage.output_tokens, model };
}

async function callOpenAI(model: string, system: string | undefined, prompt: string, maxTokens: number): Promise<Raw> {
  const messages = [] as Array<{ role: string; content: string }>;
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await retry(async () => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey()}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });
    if (!r.ok) { const err = new Error(`openai ${r.status}: ${await r.text()}`); (err as { status?: number }).status = r.status; throw err; }
    return r.json() as Promise<{ choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } }>;
  });
  return { content: res.choices[0]?.message.content ?? "", input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0, model };
}

export interface CallOpts {
  tier?: "opus" | "sonnet";
  system?: string;
  maxTokens?: number;
  agent?: string;
  targetNode?: string;
}

export interface LLMResult {
  content: string; cost: number; model: string; offline: boolean;
  usage: { input: number; output: number };
}

function providerOrder(): Array<"anthropic" | "openai"> {
  if (PROVIDER === "anthropic") return hasAnthropic() ? ["anthropic"] : [];
  if (PROVIDER === "openai") return hasOpenAI() ? ["openai"] : [];
  // auto
  const order: Array<"anthropic" | "openai"> = [];
  if (hasAnthropic()) order.push("anthropic");
  if (hasOpenAI()) order.push("openai");
  return order;
}

export async function call(prompt: string, opts: CallOpts = {}): Promise<LLMResult> {
  const order = providerOrder();
  if (order.length === 0) {
    return { content: "", cost: 0, model: "none", offline: true, usage: { input: 0, output: 0 } };
  }
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i]!;
    const model = provider === "anthropic" ? (opts.tier === "sonnet" ? SONNET : OPUS) : opts.tier === "sonnet" ? OAI_FAST : OAI_DEEP;
    try {
      const raw = provider === "anthropic"
        ? await callAnthropic(model, opts.system, prompt, opts.maxTokens || 4096)
        : await callOpenAI(model, opts.system, prompt, opts.maxTokens || 4096);
      const c = cost(raw.model, raw.input, raw.output);
      await logSpend(opts.agent || "agent", raw.model, raw.input, raw.output, c, opts.targetNode);
      return { content: raw.content, cost: c, model: raw.model, offline: false, usage: { input: raw.input, output: raw.output } };
    } catch (e) {
      lastErr = e;
      // In auto mode (another provider remains), ANY Anthropic failure after
      // retries — no credit, auth, rate, outage — falls through to OpenAI.
      if (i < order.length - 1) {
        console.warn(`[llm] ${provider} failed (${(e as Error).message?.slice(0, 100)}); falling back to ${order[i + 1]}`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function callJSON<T>(prompt: string, fallback: T, opts: CallOpts = {}): Promise<{ data: T; cost: number; offline: boolean }> {
  const system = (opts.system ? opts.system + "\n\n" : "") + "Respond with ONLY valid JSON — no prose, no markdown fences.";
  let r: LLMResult;
  try {
    r = await call(prompt, { ...opts, system });
  } catch {
    return { data: fallback, cost: 0, offline: true };
  }
  if (r.offline || !r.content) return { data: fallback, cost: 0, offline: true };
  try {
    const cleaned = r.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return { data: JSON.parse(cleaned) as T, cost: r.cost, offline: false };
  } catch {
    return { data: fallback, cost: r.cost, offline: false };
  }
}

export { OPUS, SONNET };
