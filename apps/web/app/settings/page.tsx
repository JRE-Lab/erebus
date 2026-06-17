"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchCost, fetchHealth } from "@/lib/api";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface AgentCost {
  agent: string | null;
  cost: number;
  calls: number;
}

interface CostData {
  today: number;
  month: number;
  budget: number;
  byAgent: unknown[];
}

type HealthData = { status: string; db: boolean; llm: string };

// API key reference fields. Stored in localStorage only — the server reads the
// authoritative values from its own .env. These are for operator convenience.
const KEY_FIELDS: Array<{ id: string; label: string; hint: string }> = [
  { id: "ANTHROPIC_API_KEY", label: "Anthropic", hint: "Powers theory generation + Shadow Board" },
  { id: "VOYAGE_API_KEY", label: "Voyage", hint: "Embeddings for semantic search" },
  { id: "OPENAI_API_KEY", label: "OpenAI", hint: "Optional fallback / auxiliary models" },
  { id: "ELEVENLABS_API_KEY", label: "ElevenLabs", hint: "Optional briefing narration" },
];

const LS_PREFIX = "erebus.apikey.";

// Worker intervals are configured server-side via env. These mirror the
// defaults in apps/api/src/workers/scheduler.ts for informational display.
const WORKERS: Array<{ label: string; env: string; minutes: number; desc: string; accent: string }> = [
  {
    label: "Ingest",
    env: "INGEST_POLL_MINUTES",
    minutes: 30,
    desc: "Polls enabled sources and inserts new world events.",
    accent: "var(--nx-accent-cyan)",
  },
  {
    label: "Explore",
    env: "AUTONOMOUS_EXPLORE_MINUTES",
    minutes: 60,
    desc: "Autonomously expands theory trees from fresh signals.",
    accent: "var(--nx-accent-purple)",
  },
  {
    label: "Evidence",
    env: "EVIDENCE_SWEEP_MINUTES",
    minutes: 120,
    desc: "Re-checks node hypotheses against incoming evidence.",
    accent: "var(--nx-accent-amber)",
  },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function usd(n: number | undefined): string {
  const v = Number.isFinite(n) ? (n as number) : 0;
  return `$${v.toFixed(2)}`;
}

function intervalLabel(minutes: number): string {
  if (minutes <= 0) return "disabled";
  if (minutes < 60) return `every ${minutes}m`;
  const h = minutes / 60;
  return h === Math.floor(h) ? `every ${h}h` : `every ${minutes}m`;
}

// ----------------------------------------------------------------------------
// Inline helper components
// ----------------------------------------------------------------------------

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="nx-card mb-5">
      <div className="mb-4">
        <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: "var(--nx-text-primary)" }}>
          {title}
        </h2>
        {subtitle && (
          <p className="text-[11px] mt-1" style={{ color: "var(--nx-text-muted)" }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Toggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative inline-flex items-center rounded-full transition-colors shrink-0"
      style={{
        width: 38,
        height: 20,
        background: on ? "var(--nx-accent-green)" : "var(--nx-border-bright)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="absolute rounded-full transition-all"
        style={{ width: 14, height: 14, top: 3, left: on ? 21 : 3, background: "#fff" }}
      />
    </button>
  );
}

function PasswordInput({
  id,
  label,
  hint,
  value,
  saved,
  onChange,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  saved: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="flex flex-col gap-1 mb-3">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-xs font-medium" style={{ color: "var(--nx-text-secondary)" }}>
          {label}
          <span className="ml-2 nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
            {id}
          </span>
        </label>
        {saved && value && (
          <span className="nx-badge" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-accent-green)" }}>
            saved
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            id={id}
            type={reveal ? "text" : "password"}
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            onChange={(e) => onChange(e.target.value)}
            className="w-full text-sm rounded-md px-3 py-2 pr-16 outline-none nx-mono"
            style={{
              background: "var(--nx-bg-elevated)",
              border: "1px solid var(--nx-border)",
              color: "var(--nx-text-primary)",
            }}
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider"
            style={{ color: "var(--nx-text-muted)" }}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="text-xs font-semibold rounded-md px-3 py-2 transition-colors shrink-0"
          style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border-bright)", color: "var(--nx-text-primary)" }}
        >
          Save
        </button>
      </div>
      <span className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
        {hint}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export default function SettingsPage() {
  const [cost, setCost] = useState<CostData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [costErr, setCostErr] = useState<string | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // API key reference values (localStorage)
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [c, h] = await Promise.allSettled([fetchCost(), fetchHealth()]);
      if (cancelled) return;
      if (c.status === "fulfilled") setCost(c.value?.data ?? null);
      else setCostErr((c.reason as Error)?.message || "Failed to load cost");
      if (h.status === "fulfilled") setHealth(h.value ?? null);
      else setHealthErr((h.reason as Error)?.message || "Failed to load health");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load reference keys from localStorage on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next: Record<string, string> = {};
    const seen: Record<string, boolean> = {};
    for (const f of KEY_FIELDS) {
      const v = window.localStorage.getItem(LS_PREFIX + f.id) ?? "";
      next[f.id] = v;
      seen[f.id] = Boolean(v);
    }
    setKeys(next);
    setSavedKeys(seen);
  }, []);

  const saveKey = useCallback(
    (id: string) => {
      if (typeof window === "undefined") return;
      const v = keys[id] ?? "";
      if (v) window.localStorage.setItem(LS_PREFIX + id, v);
      else window.localStorage.removeItem(LS_PREFIX + id);
      setSavedKeys((s) => ({ ...s, [id]: Boolean(v) }));
    },
    [keys]
  );

  const llmLive = health?.llm === "live";

  const budgetPct = useMemo(() => {
    if (!cost || !cost.budget) return 0;
    return Math.min(100, Math.max(0, (cost.today / cost.budget) * 100));
  }, [cost]);

  const overBudget = budgetPct >= 100;
  const nearBudget = budgetPct >= 80 && !overBudget;
  const barColor = overBudget
    ? "var(--nx-accent-red)"
    : nearBudget
    ? "var(--nx-accent-amber)"
    : "var(--nx-accent-green)";

  const agents = useMemo<AgentCost[]>(
    () => (Array.isArray(cost?.byAgent) ? (cost!.byAgent as AgentCost[]) : []),
    [cost]
  );
  const maxAgentCost = useMemo(
    () => agents.reduce((m, a) => Math.max(m, Number(a.cost) || 0), 0),
    [agents]
  );

  return (
    <div className="px-8 py-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold tracking-wide" style={{ color: "var(--nx-text-primary)" }}>
          Settings
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--nx-text-muted)" }}>
          Operational status, spend, models, and credentials.
        </p>
      </div>

      {/* ---------------- Cost ---------------- */}
      <SectionCard title="Cost & Budget" subtitle="LLM spend tracked per call against the daily budget.">
        {costErr ? (
          <div className="text-xs" style={{ color: "var(--nx-accent-red)" }}>
            {costErr}
          </div>
        ) : loading && !cost ? (
          <div className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
            Loading cost…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Stat label="Today" value={usd(cost?.today)} accent="var(--nx-text-primary)" />
              <Stat label="This month" value={usd(cost?.month)} accent="var(--nx-text-primary)" />
              <Stat label="Daily budget" value={usd(cost?.budget)} accent="var(--nx-text-secondary)" />
            </div>

            {/* Budget bar */}
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span style={{ color: "var(--nx-text-muted)" }}>
                Daily usage · {usd(cost?.today)} / {usd(cost?.budget)}
              </span>
              <span className="nx-mono" style={{ color: barColor }}>
                {budgetPct.toFixed(0)}%
                {overBudget ? " · over budget" : nearBudget ? " · approaching" : ""}
              </span>
            </div>
            <div
              className="w-full rounded-full overflow-hidden"
              style={{ height: 8, background: "var(--nx-bg-elevated)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${budgetPct}%`, background: barColor }}
              />
            </div>

            {/* By agent */}
            <div className="mt-5">
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "var(--nx-text-muted)" }}>
                Spend by agent · this month
              </div>
              {agents.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
                  No spend recorded yet.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {agents.map((a, i) => {
                    const c = Number(a.cost) || 0;
                    const pct = maxAgentCost > 0 ? (c / maxAgentCost) * 100 : 0;
                    return (
                      <div key={`${a.agent ?? "unknown"}-${i}`} className="flex items-center gap-3">
                        <div className="w-28 shrink-0 text-xs nx-mono truncate" style={{ color: "var(--nx-text-secondary)" }}>
                          {a.agent || "unattributed"}
                        </div>
                        <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: "var(--nx-bg-elevated)" }}>
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--nx-accent-indigo)" }} />
                        </div>
                        <div className="w-16 shrink-0 text-right text-xs nx-mono" style={{ color: "var(--nx-text-primary)" }}>
                          {usd(c)}
                        </div>
                        <div className="w-14 shrink-0 text-right text-[10px] nx-mono" style={{ color: "var(--nx-text-muted)" }}>
                          {Number(a.calls) || 0} call{Number(a.calls) === 1 ? "" : "s"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </SectionCard>

      {/* ---------------- Models / LLM status ---------------- */}
      <SectionCard title="Models & LLM Status" subtitle="Models are configured server-side via environment.">
        <div className="flex items-center gap-3 mb-4">
          <span
            className={`nx-dot${llmLive ? " nx-pulse" : ""}`}
            style={{ background: llmLive ? "var(--nx-accent-green)" : "var(--nx-accent-red)" }}
          />
          <span className="text-sm font-medium" style={{ color: "var(--nx-text-primary)" }}>
            LLM {healthErr ? "unknown" : llmLive ? "Live" : "Offline"}
          </span>
          {health?.db === false && (
            <span className="nx-badge" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-accent-amber)" }}>
              db degraded
            </span>
          )}
        </div>

        {healthErr ? (
          <div className="text-xs" style={{ color: "var(--nx-accent-red)" }}>
            Could not reach the API: {healthErr}
          </div>
        ) : !llmLive ? (
          <div
            className="text-xs rounded-md p-3"
            style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", color: "var(--nx-text-secondary)" }}
          >
            The model is offline — EREBUS is running in degraded mode and will return empty
            generations. Add{" "}
            <code className="nx-kbd">ANTHROPIC_API_KEY</code> to the API server&apos;s{" "}
            <code className="nx-kbd">.env</code> and restart to enable theory generation.
          </div>
        ) : (
          <div className="text-xs" style={{ color: "var(--nx-text-secondary)" }}>
            Connected and ready. Theory generation and the Shadow Board are operational.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mt-4">
          <ModelCard tier="Deep" env="ANTHROPIC_MODEL_DEEP" desc="Theory synthesis · Shadow Board" />
          <ModelCard tier="Fast" env="ANTHROPIC_MODEL_FAST" desc="Node expansion · evidence checks" />
        </div>
        <p className="text-[10px] mt-3" style={{ color: "var(--nx-text-muted)" }}>
          Model identifiers are set via the <code className="nx-kbd">ANTHROPIC_MODEL_DEEP</code> and{" "}
          <code className="nx-kbd">ANTHROPIC_MODEL_FAST</code> environment variables on the server.
        </p>
      </SectionCard>

      {/* ---------------- API keys ---------------- */}
      <SectionCard
        title="API Keys"
        subtitle="Stored locally in your browser for reference. The server reads its keys from its own .env."
      >
        {KEY_FIELDS.map((f) => (
          <PasswordInput
            key={f.id}
            id={f.id}
            label={f.label}
            hint={f.hint}
            value={keys[f.id] ?? ""}
            saved={savedKeys[f.id] ?? false}
            onChange={(v) => setKeys((k) => ({ ...k, [f.id]: v }))}
            onSave={() => saveKey(f.id)}
          />
        ))}
        <div
          className="text-[10px] mt-1 rounded-md p-2"
          style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", color: "var(--nx-text-muted)" }}
        >
          ⚠ These fields never leave your browser. They do not configure the running server —
          set the authoritative keys in the API server&apos;s <code className="nx-kbd">.env</code>.
        </div>
      </SectionCard>

      {/* ---------------- Autonomous workers ---------------- */}
      <SectionCard title="Autonomous Workers" subtitle="Background loops driving continuous ingestion and refinement.">
        <div className="flex flex-col gap-3">
          {WORKERS.map((w) => (
            <div
              key={w.env}
              className="flex items-center gap-3 rounded-md p-3"
              style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)" }}
            >
              <span className="nx-dot" style={{ background: w.accent }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium" style={{ color: "var(--nx-text-primary)" }}>
                    {w.label}
                  </span>
                  <span className="nx-badge" style={{ background: "var(--nx-bg-card)", color: "var(--nx-text-secondary)" }}>
                    {intervalLabel(w.minutes)}
                  </span>
                </div>
                <div className="text-[11px] truncate" style={{ color: "var(--nx-text-muted)" }}>
                  {w.desc}
                </div>
              </div>
              <code className="nx-kbd shrink-0">{w.env}</code>
            </div>
          ))}
        </div>
        <p className="text-[10px] mt-3" style={{ color: "var(--nx-text-muted)" }}>
          Intervals are the server defaults — override them via the listed environment variables and
          set <code className="nx-kbd">WORKERS_ENABLED=true</code> to run the scheduler in-process.
        </p>
      </SectionCard>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Small presentational helpers
// ----------------------------------------------------------------------------

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-md p-3" style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)" }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nx-text-muted)" }}>
        {label}
      </div>
      <div className="text-lg font-bold nx-mono mt-1" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function ModelCard({ tier, env, desc }: { tier: string; env: string; desc: string }) {
  return (
    <div className="rounded-md p-3" style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--nx-text-primary)" }}>
          {tier}
        </span>
        <span className="nx-badge" style={{ background: "var(--nx-bg-card)", color: "var(--nx-text-secondary)" }}>
          server-side
        </span>
      </div>
      <code className="nx-kbd inline-block mt-2">{env}</code>
      <div className="text-[10px] mt-2" style={{ color: "var(--nx-text-muted)" }}>
        {desc}
      </div>
    </div>
  );
}
