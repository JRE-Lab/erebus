"use client";

import { useCallback, useEffect, useState } from "react";
import type { Source } from "@erebus/core";
import { fetchSources, addSource, toggleSource, pollNow } from "@/lib/api";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const STATUS_COLOR: Record<Source["status"], string> = {
  healthy: "var(--nx-accent-green)",
  degraded: "var(--nx-accent-amber)",
  down: "var(--nx-accent-red)",
};

const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · Primary",
  2: "Tier 2 · Secondary",
  3: "Tier 3 · Fringe",
};

function tierLabel(tier: number): string {
  return TIER_LABEL[tier] ?? `Tier ${tier}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Inline toggle helper component.
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
        style={{
          width: 14,
          height: 14,
          top: 3,
          left: on ? 21 : 3,
          background: "#fff",
        }}
      />
    </button>
  );
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-source form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [tier, setTier] = useState(2);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Polling state
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<{ sources: number; inserted: number } | null>(null);

  // Per-row pending toggles
  const [pending, setPending] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchSources();
      setSources(Array.isArray(res?.data) ? res.data : []);
    } catch (e) {
      setError((e as Error).message || "Failed to load sources");
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = useCallback(
    async (src: Source, next: boolean) => {
      setPending((p) => new Set(p).add(src.id));
      // optimistic
      setSources((list) => list.map((s) => (s.id === src.id ? { ...s, enabled: next } : s)));
      try {
        const res = await toggleSource(src.id, next);
        if (res?.data) {
          setSources((list) => list.map((s) => (s.id === src.id ? { ...s, ...res.data } : s)));
        }
      } catch {
        // revert on failure
        setSources((list) => list.map((s) => (s.id === src.id ? { ...s, enabled: !next } : s)));
      } finally {
        setPending((p) => {
          const n = new Set(p);
          n.delete(src.id);
          return n;
        });
      }
    },
    []
  );

  const onAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      const trimmedName = name.trim();
      const trimmedUrl = url.trim();
      if (!trimmedName || !trimmedUrl) {
        setFormError("Name and URL are required.");
        return;
      }
      setAdding(true);
      try {
        await addSource({ name: trimmedName, url: trimmedUrl, tier });
        setName("");
        setUrl("");
        setTier(2);
        await load();
      } catch (err) {
        setFormError((err as Error).message || "Failed to add source");
      } finally {
        setAdding(false);
      }
    },
    [name, url, tier, load]
  );

  const onPoll = useCallback(async () => {
    setPolling(true);
    setPollResult(null);
    try {
      const res = await pollNow();
      setPollResult(res?.data ?? { sources: 0, inserted: 0 });
      await load();
    } catch (err) {
      setPollResult(null);
      setError((err as Error).message || "Poll failed");
    } finally {
      setPolling(false);
    }
  }, [load]);

  const enabledCount = sources.filter((s) => s.enabled).length;

  return (
    <div className="px-8 py-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-wide" style={{ color: "var(--nx-text-primary)" }}>
            Ingestion Sources
          </h1>
          <p className="text-xs mt-1" style={{ color: "var(--nx-text-muted)" }}>
            {loading
              ? "Loading feeds…"
              : `${sources.length} source${sources.length === 1 ? "" : "s"} · ${enabledCount} active`}
          </p>
        </div>
        <button
          type="button"
          onClick={onPoll}
          disabled={polling || loading}
          className="text-xs font-semibold rounded-md px-3 py-2 transition-colors shrink-0"
          style={{
            background: "var(--nx-accent-indigo)",
            color: "#fff",
            opacity: polling || loading ? 0.6 : 1,
            cursor: polling || loading ? "not-allowed" : "pointer",
          }}
        >
          {polling ? "Polling…" : "↻ Poll all now"}
        </button>
      </div>

      {/* Poll result banner */}
      {pollResult && (
        <div
          className="nx-card mb-4 flex items-center gap-3"
          style={{ borderColor: "var(--nx-accent-green)", padding: "10px 14px" }}
        >
          <span className="nx-dot" style={{ background: "var(--nx-accent-green)" }} />
          <span className="text-xs" style={{ color: "var(--nx-text-secondary)" }}>
            Polled{" "}
            <strong className="nx-mono" style={{ color: "var(--nx-text-primary)" }}>
              {pollResult.sources}
            </strong>{" "}
            source{pollResult.sources === 1 ? "" : "s"} ·{" "}
            <strong className="nx-mono" style={{ color: "var(--nx-accent-green)" }}>
              {pollResult.inserted}
            </strong>{" "}
            new event{pollResult.inserted === 1 ? "" : "s"} inserted
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          className="nx-card mb-4 text-xs"
          style={{ borderColor: "var(--nx-accent-red)", color: "var(--nx-accent-red)", padding: "10px 14px" }}
        >
          {error}
        </div>
      )}

      {/* Add source form */}
      <form onSubmit={onAdd} className="nx-card mb-6">
        <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--nx-text-secondary)" }}>
          Add source
        </div>
        <div className="flex flex-col md:flex-row gap-3 md:items-end">
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nx-text-muted)" }}>
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Reuters World"
              className="text-sm rounded-md px-3 py-2 outline-none"
              style={{
                background: "var(--nx-bg-elevated)",
                border: "1px solid var(--nx-border)",
                color: "var(--nx-text-primary)",
              }}
            />
          </label>
          <label className="flex-[2] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nx-text-muted)" }}>
              Feed URL
            </span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://feeds.example.com/rss"
              className="text-sm rounded-md px-3 py-2 outline-none nx-mono"
              style={{
                background: "var(--nx-bg-elevated)",
                border: "1px solid var(--nx-border)",
                color: "var(--nx-text-primary)",
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nx-text-muted)" }}>
              Tier
            </span>
            <select
              value={tier}
              onChange={(e) => setTier(Number(e.target.value))}
              className="text-sm rounded-md px-3 py-2 outline-none"
              style={{
                background: "var(--nx-bg-elevated)",
                border: "1px solid var(--nx-border)",
                color: "var(--nx-text-primary)",
              }}
            >
              <option value={1}>Tier 1</option>
              <option value={2}>Tier 2</option>
              <option value={3}>Tier 3</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={adding}
            className="text-xs font-semibold rounded-md px-4 py-2 transition-colors shrink-0"
            style={{
              background: "var(--nx-accent-green)",
              color: "#05140a",
              opacity: adding ? 0.6 : 1,
              cursor: adding ? "not-allowed" : "pointer",
            }}
          >
            {adding ? "Adding…" : "+ Add"}
          </button>
        </div>
        {formError && (
          <div className="text-[11px] mt-2" style={{ color: "var(--nx-accent-red)" }}>
            {formError}
          </div>
        )}
      </form>

      {/* Sources list */}
      <div className="nx-card" style={{ padding: 0, overflow: "hidden" }}>
        {/* Header row */}
        <div
          className="hidden md:grid items-center px-4 py-2 text-[10px] uppercase tracking-wider"
          style={{
            gridTemplateColumns: "1.6fr 1.2fr 0.6fr 0.8fr 0.6fr",
            color: "var(--nx-text-muted)",
            borderBottom: "1px solid var(--nx-border)",
          }}
        >
          <span>Source</span>
          <span>Tier</span>
          <span>Status</span>
          <span>Last polled</span>
          <span className="text-right">Enabled</span>
        </div>

        {loading ? (
          <div className="px-4 py-10 text-center text-xs" style={{ color: "var(--nx-text-muted)" }}>
            Loading sources…
          </div>
        ) : sources.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs" style={{ color: "var(--nx-text-muted)" }}>
            No sources yet. Add an RSS feed above to begin ingestion.
          </div>
        ) : (
          sources.map((s, i) => (
            <div
              key={s.id}
              className="grid items-center px-4 py-3 gap-y-1 transition-colors"
              style={{
                gridTemplateColumns: "1.6fr 1.2fr 0.6fr 0.8fr 0.6fr",
                borderTop: i === 0 ? "none" : "1px solid var(--nx-border)",
                opacity: s.enabled ? 1 : 0.6,
              }}
            >
              {/* Name + url */}
              <div className="min-w-0 col-span-2 md:col-span-1">
                <div className="text-sm font-medium truncate" style={{ color: "var(--nx-text-primary)" }}>
                  {s.name || "Untitled source"}
                </div>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] truncate block nx-mono hover:underline"
                  style={{ color: "var(--nx-text-muted)" }}
                  title={s.url}
                >
                  {s.url}
                </a>
              </div>

              {/* Tier */}
              <div className="text-xs" style={{ color: "var(--nx-text-secondary)" }}>
                <span
                  className="nx-badge"
                  style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-secondary)" }}
                >
                  {tierLabel(s.tier)}
                </span>
                <span className="ml-2 text-[10px] uppercase nx-mono" style={{ color: "var(--nx-text-muted)" }}>
                  {s.type}
                </span>
              </div>

              {/* Status */}
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--nx-text-secondary)" }}>
                <span
                  className={`nx-dot${s.status === "healthy" && s.enabled ? " nx-pulse" : ""}`}
                  style={{ background: STATUS_COLOR[s.status] ?? "var(--nx-pending)" }}
                />
                <span className="capitalize">{s.status}</span>
              </div>

              {/* Last polled */}
              <div className="text-xs nx-mono" style={{ color: "var(--nx-text-muted)" }}>
                {relativeTime(s.last_polled)}
              </div>

              {/* Toggle */}
              <div className="flex justify-start md:justify-end">
                <Toggle
                  on={s.enabled}
                  disabled={pending.has(s.id)}
                  onChange={(next) => void onToggle(s, next)}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
