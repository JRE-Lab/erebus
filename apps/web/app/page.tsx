"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Theory, Confidence } from "@erebus/core";
import { CONFIDENCE_COLORS, CONFIDENCE_SCORE } from "@erebus/core";
import { fetchHealth, fetchCost, fetchTheories, createTheory, pollNow } from "@/lib/api";
import EventFeed from "@/components/EventFeed";

type Health = { status: string; db: boolean; llm: string };
type Cost = { today: number; month: number; budget: number };

function confColor(c: Confidence | string): string {
  return (CONFIDENCE_COLORS as Record<string, string>)[c] ?? "var(--nx-text-muted)";
}

// Normalize score into a 0..1 fraction for the bar. Falls back to the
// confidence ladder anchor when score is missing or out of range.
function scoreFraction(t: Theory): number {
  const raw = typeof t.score === "number" && !Number.isNaN(t.score) ? t.score : NaN;
  let v = raw;
  if (Number.isNaN(v)) v = (CONFIDENCE_SCORE as Record<string, number>)[t.confidence] ?? 0;
  if (v > 1) v = v / 100; // tolerate 0..100 scoring
  return Math.max(0, Math.min(1, v));
}

function usd(n: number | undefined): string {
  const v = typeof n === "number" && !Number.isNaN(n) ? n : 0;
  return `$${v.toFixed(2)}`;
}

export default function DashboardPage() {
  const router = useRouter();

  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [cost, setCost] = useState<Cost | null>(null);

  const [theories, setTheories] = useState<Theory[]>([]);
  const [theoriesLoading, setTheoriesLoading] = useState(true);
  const [theoriesErr, setTheoriesErr] = useState<string | null>(null);

  const [context, setContext] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);

  const [polling, setPolling] = useState(false);
  const [pollMsg, setPollMsg] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const h = await fetchHealth();
      setHealth(h);
      setHealthErr(false);
    } catch {
      setHealthErr(true);
      setHealth(null);
    }
  }, []);

  const loadCost = useCallback(async () => {
    try {
      const res = await fetchCost();
      setCost(res?.data ?? null);
    } catch {
      setCost(null);
    }
  }, []);

  const loadTheories = useCallback(async () => {
    setTheoriesLoading(true);
    setTheoriesErr(null);
    try {
      const res = await fetchTheories();
      setTheories(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setTheoriesErr("Could not load theories");
      setTheories([]);
    } finally {
      setTheoriesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadCost();
    loadTheories();
    const id = window.setInterval(() => {
      loadHealth();
      loadCost();
    }, 20000);
    return () => window.clearInterval(id);
  }, [loadHealth, loadCost, loadTheories]);

  const onGenerate = useCallback(async () => {
    const ctx = context.trim();
    if (!ctx || generating) return;
    setGenerating(true);
    setGenErr(null);
    try {
      const res = await createTheory({ context: ctx });
      const id = res?.data?.id;
      if (id) {
        router.push(`/theories/${id}`);
      } else {
        setGenErr("Theory created but no id returned");
        setGenerating(false);
        loadTheories();
      }
    } catch {
      setGenErr("Generation failed. Is the engine online?");
      setGenerating(false);
    }
  }, [context, generating, router, loadTheories]);

  const onPoll = useCallback(async () => {
    if (polling) return;
    setPolling(true);
    setPollMsg(null);
    try {
      const res = await pollNow();
      const d = res?.data;
      setPollMsg(
        d ? `Polled ${d.sources ?? 0} sources · ${d.inserted ?? 0} new` : "Poll complete"
      );
    } catch {
      setPollMsg("Poll failed");
    } finally {
      setPolling(false);
      window.setTimeout(() => setPollMsg(null), 5000);
    }
  }, [polling]);

  return (
    <div className="flex h-full">
      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Header bar */}
        <header
          className="flex items-center gap-4 h-12 px-5 shrink-0 border-b"
          style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-secondary)" }}
        >
          <h1
            className="nx-mono text-sm font-bold tracking-[0.18em]"
            style={{ color: "var(--nx-text-primary)" }}
          >
            INTELLIGENCE DASHBOARD
          </h1>

          <div className="ml-auto flex items-center gap-3">
            <StatusPill health={health} error={healthErr} />
            <CostReadout cost={cost} />
          </div>
        </header>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Composer */}
          <section className="nx-card">
            <div className="flex items-center justify-between mb-2.5">
              <h2
                className="nx-mono text-[11px] font-bold tracking-widest"
                style={{ color: "var(--nx-text-secondary)" }}
              >
                NEW THEORY
              </h2>
              <button
                onClick={onPoll}
                disabled={polling}
                className="nx-mono text-[10px] px-2.5 py-1 rounded transition-colors disabled:opacity-50"
                style={{
                  color: "var(--nx-accent-cyan)",
                  border: "1px solid var(--nx-border-bright)",
                }}
                title="Pull fresh events from all sources"
              >
                {polling ? "Polling…" : "⟳ Poll sources now"}
              </button>
            </div>

            <textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onGenerate();
              }}
              placeholder="Drop a signal, headline, or raw context. EREBUS will generate, score, and adversarially challenge a theory…"
              rows={3}
              disabled={generating}
              className="w-full resize-y rounded-md px-3 py-2.5 text-sm outline-none transition-colors disabled:opacity-60"
              style={{
                background: "var(--nx-bg-primary)",
                border: "1px solid var(--nx-border)",
                color: "var(--nx-text-primary)",
              }}
            />

            <div className="flex items-center gap-3 mt-2.5">
              <button
                onClick={onGenerate}
                disabled={!context.trim() || generating}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-xs font-bold tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "var(--nx-accent-indigo)", color: "#fff" }}
              >
                {generating ? (
                  <>
                    <Spinner />
                    Generating…
                  </>
                ) : (
                  <>◉ Generate Theory</>
                )}
              </button>
              <span className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                <span className="nx-kbd">⌘</span> <span className="nx-kbd">↵</span> to submit
              </span>
              {genErr ? (
                <span className="text-[11px] ml-auto" style={{ color: "var(--nx-accent-red)" }}>
                  {genErr}
                </span>
              ) : pollMsg ? (
                <span className="text-[11px] ml-auto nx-mono" style={{ color: "var(--nx-text-muted)" }}>
                  {pollMsg}
                </span>
              ) : null}
            </div>
          </section>

          {/* Theory list */}
          <section>
            <div className="flex items-center justify-between mb-2.5">
              <h2
                className="nx-mono text-[11px] font-bold tracking-widest"
                style={{ color: "var(--nx-text-secondary)" }}
              >
                ACTIVE THEORIES
                {!theoriesLoading && theories.length > 0 ? (
                  <span style={{ color: "var(--nx-text-muted)" }}> · {theories.length}</span>
                ) : null}
              </h2>
              <button
                onClick={loadTheories}
                className="nx-mono text-[10px] px-2 py-1 rounded transition-colors"
                style={{ color: "var(--nx-text-muted)", border: "1px solid var(--nx-border)" }}
                title="Refresh"
              >
                ↻
              </button>
            </div>

            {theoriesLoading ? (
              <TheoryGridSkeleton />
            ) : theoriesErr ? (
              <div className="nx-card text-center py-8">
                <p className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
                  {theoriesErr}.
                </p>
                <button
                  onClick={loadTheories}
                  className="mt-2 nx-mono text-[10px] px-2.5 py-1 rounded"
                  style={{ color: "var(--nx-text-secondary)", border: "1px solid var(--nx-border)" }}
                >
                  Retry
                </button>
              </div>
            ) : theories.length === 0 ? (
              <div className="nx-card text-center py-10">
                <p className="text-sm font-semibold" style={{ color: "var(--nx-text-secondary)" }}>
                  No theories yet
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--nx-text-muted)" }}>
                  Generate your first theory from a signal above.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {theories.map((t) => (
                  <TheoryCard key={t.id} theory={t} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Right rail */}
      <aside
        className="shrink-0 border-l flex flex-col"
        style={{ width: 340, borderColor: "var(--nx-border)", background: "var(--nx-bg-secondary)" }}
      >
        <EventFeed />
      </aside>
    </div>
  );
}

/* ----------------------------- Sub-components ----------------------------- */

function StatusPill({ health, error }: { health: Health | null; error: boolean }) {
  const dbOk = !!health?.db;
  const llmRaw = (health?.llm ?? "").toLowerCase();
  const llmOk = !error && (llmRaw === "online" || llmRaw === "ok" || llmRaw === "ready");
  const llmLabel = health?.llm ? health.llm : error ? "offline" : "—";

  const dbColor = error ? "var(--nx-text-muted)" : dbOk ? "var(--nx-accent-green)" : "var(--nx-accent-red)";
  const llmColor = error
    ? "var(--nx-accent-red)"
    : llmOk
    ? "var(--nx-accent-green)"
    : "var(--nx-accent-amber)";

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 rounded-full"
      style={{ background: "var(--nx-bg-card)", border: "1px solid var(--nx-border)" }}
      title={error ? "Health check failed" : `db: ${dbOk ? "up" : "down"} · llm: ${llmLabel}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="nx-dot" style={{ background: dbColor }} />
        <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-secondary)" }}>
          DB
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className={"nx-dot" + (llmOk ? " nx-pulse" : "")}
          style={{ background: llmColor }}
        />
        <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-secondary)" }}>
          LLM
        </span>
      </span>
    </div>
  );
}

function CostReadout({ cost }: { cost: Cost | null }) {
  const today = cost?.today ?? 0;
  const month = cost?.month ?? 0;
  const budget = cost?.budget ?? 0;
  const frac = budget > 0 ? Math.min(1, month / budget) : 0;
  const over = budget > 0 && month > budget;
  const barColor = over
    ? "var(--nx-accent-red)"
    : frac > 0.8
    ? "var(--nx-accent-amber)"
    : "var(--nx-accent-green)";

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 rounded-full"
      style={{ background: "var(--nx-bg-card)", border: "1px solid var(--nx-border)" }}
      title="LLM spend"
    >
      <div className="flex items-baseline gap-1.5">
        <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
          TODAY
        </span>
        <span className="nx-mono text-[11px] font-bold" style={{ color: "var(--nx-text-primary)" }}>
          {usd(today)}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
          MTD
        </span>
        <span className="nx-mono text-[11px] font-bold" style={{ color: over ? "var(--nx-accent-red)" : "var(--nx-text-primary)" }}>
          {usd(month)}
        </span>
        {budget > 0 ? (
          <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
            / {usd(budget)}
          </span>
        ) : null}
      </div>
      {budget > 0 ? (
        <div className="w-12 h-1 rounded-full overflow-hidden" style={{ background: "var(--nx-bg-elevated)" }}>
          <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: barColor }} />
        </div>
      ) : null}
    </div>
  );
}

function TheoryCard({ theory }: { theory: Theory }) {
  const color = confColor(theory.confidence);
  const frac = scoreFraction(theory);
  const domains = Array.isArray(theory.domains) ? theory.domains.filter(Boolean) : [];
  const shadow = !!theory.is_shadow;

  return (
    <Link
      href={`/theories/${theory.id}`}
      className="nx-card group flex flex-col transition-all hover:-translate-y-0.5"
      style={{
        borderColor: shadow ? "rgba(239,68,68,0.35)" : "var(--nx-border)",
        boxShadow: shadow ? "inset 0 0 0 1px rgba(239,68,68,0.12)" : undefined,
      }}
    >
      <div className="flex items-start gap-2">
        <h3
          className="flex-1 text-sm font-bold leading-snug line-clamp-2 transition-colors group-hover:brightness-125"
          style={{ color: "var(--nx-text-primary)" }}
        >
          {theory.title || "Untitled theory"}
        </h3>
        {shadow ? (
          <span
            className="nx-badge shrink-0"
            style={{ background: "rgba(239,68,68,0.12)", color: "var(--nx-accent-red)" }}
            title="Shadow theory"
          >
            ◑ Shadow
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <span
          className="nx-badge"
          style={{ background: `${color}1f`, color }}
        >
          <span className="nx-dot" style={{ background: color }} />
          {theory.confidence || "—"}
        </span>
        <span className="nx-mono text-[10px] ml-auto" style={{ color: "var(--nx-text-muted)" }}>
          {Math.round(frac * 100)}%
        </span>
      </div>

      {/* Score bar */}
      <div
        className="mt-1.5 h-1.5 rounded-full overflow-hidden"
        style={{ background: "var(--nx-bg-elevated)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${frac * 100}%`, background: color }}
        />
      </div>

      {theory.summary ? (
        <p
          className="mt-2.5 text-xs leading-snug line-clamp-3"
          style={{ color: "var(--nx-text-secondary)" }}
        >
          {theory.summary}
        </p>
      ) : (
        <p className="mt-2.5 text-xs italic" style={{ color: "var(--nx-text-muted)" }}>
          No summary yet.
        </p>
      )}

      {domains.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-auto pt-3">
          {domains.slice(0, 4).map((d) => (
            <span
              key={d}
              className="nx-mono text-[9px] px-1.5 py-0.5 rounded"
              style={{
                background: "var(--nx-bg-elevated)",
                color: "var(--nx-text-muted)",
                border: "1px solid var(--nx-border)",
              }}
            >
              {d}
            </span>
          ))}
          {domains.length > 4 ? (
            <span className="nx-mono text-[9px] px-1 py-0.5" style={{ color: "var(--nx-text-muted)" }}>
              +{domains.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}

function TheoryGridSkeleton() {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="nx-card">
          <div className="h-3.5 w-3/4 rounded" style={{ background: "var(--nx-bg-elevated)" }} />
          <div className="h-4 w-20 rounded mt-3" style={{ background: "var(--nx-bg-elevated)" }} />
          <div className="h-1.5 w-full rounded mt-2" style={{ background: "var(--nx-bg-elevated)" }} />
          <div className="h-2.5 w-full rounded mt-3" style={{ background: "var(--nx-bg-elevated)" }} />
          <div className="h-2.5 w-5/6 rounded mt-1.5" style={{ background: "var(--nx-bg-elevated)" }} />
        </div>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin"
      style={{ borderColor: "rgba(255,255,255,0.35)", borderTopColor: "#fff" }}
      aria-hidden
    />
  );
}
