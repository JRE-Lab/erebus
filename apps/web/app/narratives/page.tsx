"use client";

import { useCallback, useEffect, useState } from "react";

// ----------------------------------------------------------------------------
// LOOM narratives (Phase 1, read-only) — the story stream clustered into
// discrete narratives with a lifecycle. Cards show the LLM label when it
// exists, else the cluster's seed headline. Spec M12 grows richer sections
// (origin trace, intent, forecasts) in later phases.
// ----------------------------------------------------------------------------

interface NarrativeCard {
  id: string;
  label: string | null;
  summary: string | null;
  seedTitle: string | null;
  state: string;
  articleCount: number;
  outletCount: number;
  langCount: number;
  vel24: number;
  seededAt: string | null;
  lastSeenAt: string | null;
}

interface LoomStatusShape {
  articlesTotal: number;
  articles24h: number;
  articlesEmbedded: number;
  articlesAssigned: number;
  narrativesPromoted: number;
  narrativesCandidates: number;
  narrativesUnlabeled: number;
}

interface Detail extends NarrativeCard {
  articles: Array<{ id: string; title: string | null; url: string; outlet: string | null; firstSeenAt: string | null }>;
  transitions: Array<{ fromState: string; toState: string; at: string }>;
}

const STATE_META: Record<string, { color: string; hint: string }> = {
  seeding: { color: "#6b7280", hint: "promoted, low velocity" },
  amplifying: { color: "#f59e0b", hint: "velocity climbing" },
  peak: { color: "#ef4444", hint: "crested — maximum attention" },
  decaying: { color: "#3b82f6", hint: "attention fading" },
  dormant: { color: "#4b5563", hint: "gone quiet (can reignite)" },
};
const STATES = ["seeding", "amplifying", "peak", "decaying", "dormant"] as const;

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NarrativesPage() {
  const [cards, setCards] = useState<NarrativeCard[]>([]);
  const [status, setStatus] = useState<LoomStatusShape | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const q = filter ? `?state=${filter}` : "";
      const [n, s] = await Promise.all([
        fetch(`/api/loom/narratives${q}`).then((r) => r.json()),
        fetch("/api/loom/status").then((r) => r.json()),
      ]);
      setCards(Array.isArray(n) ? n : []);
      if (s && typeof s === "object") setStatus(s as LoomStatusShape);
    } catch {
      /* keep last good render */
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const d = await fetch(`/api/loom/narratives/${id}`).then((r) => r.json());
      if (d && !d.error) setOpen(d as Detail);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* list */}
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mb-1 flex items-baseline gap-3">
          <h1 className="text-lg font-bold" style={{ color: "var(--nx-text-primary)" }}>
            ∿ Narratives
          </h1>
          <span className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
            the story stream, clustered — how narratives move, not just what happened
          </span>
        </div>
        {status && (
          <div className="mb-4 text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
            {status.articlesTotal} articles ({status.articles24h} / 24h) · {status.articlesEmbedded} embedded ·{" "}
            {status.articlesAssigned} clustered · {status.narrativesPromoted} narratives ·{" "}
            {status.narrativesCandidates} candidates
            {status.narrativesUnlabeled > 0 ? ` · ${status.narrativesUnlabeled} awaiting label` : ""}
          </div>
        )}

        {/* state filter chips */}
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setFilter(null)}
            className="rounded-full border px-3 py-1 text-[11px] font-semibold"
            style={{
              borderColor: filter === null ? "var(--nx-indigo)" : "var(--nx-border)",
              color: filter === null ? "var(--nx-text-primary)" : "var(--nx-text-muted)",
            }}
          >
            all
          </button>
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(filter === s ? null : s)}
              title={STATE_META[s]?.hint}
              className="rounded-full border px-3 py-1 text-[11px] font-semibold"
              style={{
                borderColor: filter === s ? STATE_META[s]!.color : "var(--nx-border)",
                color: filter === s ? STATE_META[s]!.color : "var(--nx-text-muted)",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-sm" style={{ color: "var(--nx-text-muted)" }}>
            loading…
          </div>
        ) : cards.length === 0 ? (
          <div className="text-sm" style={{ color: "var(--nx-text-muted)" }}>
            No promoted narratives yet. Clusters promote once a story reaches enough articles across enough
            distinct outlets — the hourly loom-cluster tick is building them from the article stream.
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(340px,1fr))" }}>
            {cards.map((n) => {
              const meta = STATE_META[n.state] ?? STATE_META.seeding!;
              return (
                <button
                  key={n.id}
                  onClick={() => openDetail(n.id)}
                  className="rounded-xl border p-4 text-left transition hover:brightness-110"
                  style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-card)" }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}55` }}
                    >
                      {n.state}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
                      {n.vel24}/24h · {n.articleCount} articles · {n.outletCount} outlets
                    </span>
                  </div>
                  <div className="mb-1 text-sm font-semibold leading-snug" style={{ color: "var(--nx-text-primary)" }}>
                    {n.label || n.seedTitle || "(unlabeled narrative)"}
                  </div>
                  {n.summary && (
                    <div className="mb-2 text-xs leading-relaxed" style={{ color: "var(--nx-text-muted)" }}>
                      {n.summary}
                    </div>
                  )}
                  <div className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                    seeded {ago(n.seededAt)} · last seen {ago(n.lastSeenAt)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* detail drawer */}
      {open && (
        <div
          className="w-[420px] shrink-0 overflow-y-auto border-l p-5"
          style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-card)" }}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="text-sm font-bold leading-snug" style={{ color: "var(--nx-text-primary)" }}>
              {open.label || open.seedTitle || "(unlabeled narrative)"}
            </div>
            <button onClick={() => setOpen(null)} className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
              ✕
            </button>
          </div>
          {open.summary && (
            <p className="mb-4 text-xs leading-relaxed" style={{ color: "var(--nx-text-muted)" }}>
              {open.summary}
            </p>
          )}
          {open.transitions.length > 0 && (
            <div className="mb-4">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--nx-text-muted)" }}>
                lifecycle
              </div>
              {open.transitions.map((t, i) => (
                <div key={i} className="text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
                  {t.fromState} → <span style={{ color: STATE_META[t.toState]?.color }}>{t.toState}</span> · {ago(t.at)}
                </div>
              ))}
            </div>
          )}
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--nx-text-muted)" }}>
            articles ({open.articleCount})
          </div>
          {open.articles.map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="mb-2 block rounded-lg border p-2 text-xs leading-snug transition hover:brightness-110"
              style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-primary)" }}
            >
              {a.title || a.url}
              <div className="mt-0.5 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                {a.outlet || "?"} · first seen {ago(a.firstSeenAt)}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
