"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { FeedItem, FeedItemType, Priority } from "@erebus/core";
import { fetchFeed } from "@/lib/api";
import { onErebusEvent } from "@/lib/ws";

// Priority -> color token. CRITICAL/HIGH lean red/amber, MEDIUM cyan, LOW muted.
const PRIORITY_COLOR: Record<Priority, string> = {
  CRITICAL: "var(--nx-accent-red)",
  HIGH: "var(--nx-accent-amber)",
  MEDIUM: "var(--nx-accent-cyan)",
  LOW: "var(--nx-text-muted)",
};

// Type -> short label + accent for the type tag.
const TYPE_META: Record<FeedItemType, { label: string; color: string }> = {
  theory_update: { label: "THEORY", color: "var(--nx-accent-indigo)" },
  evidence: { label: "EVIDENCE", color: "var(--nx-accent-green)" },
  connection: { label: "LINK", color: "var(--nx-accent-cyan)" },
  shadow: { label: "SHADOW", color: "var(--nx-accent-red)" },
  ingestion: { label: "INGEST", color: "var(--nx-accent-purple)" },
  prediction: { label: "PREDICT", color: "var(--nx-accent-amber)" },
  system: { label: "SYSTEM", color: "var(--nx-text-muted)" },
};

function typeMeta(type: string): { label: string; color: string } {
  return TYPE_META[type as FeedItemType] ?? { label: String(type || "EVENT").toUpperCase(), color: "var(--nx-text-muted)" };
}

function priorityColor(priority: string): string {
  return PRIORITY_COLOR[priority as Priority] ?? "var(--nx-text-muted)";
}

// Relative time formatting that degrades gracefully on bad/missing timestamps.
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(t).toLocaleDateString();
}

// Coerce an arbitrary live-event payload into a FeedItem-ish shape.
function coerceItem(type: string, payload: unknown): FeedItem | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const title = typeof p.title === "string" ? p.title : "";
  // Only render something if there's at least a title or summary to show.
  const summary = typeof p.summary === "string" ? p.summary : "";
  if (!title && !summary) return null;
  const idRaw = p.id;
  const id =
    typeof idRaw === "number"
      ? idRaw
      : typeof idRaw === "string" && idRaw.trim() !== ""
      ? Number(idRaw) || -Date.now()
      : -Date.now();
  const itemType = (typeof p.type === "string" ? p.type : type) as FeedItemType;
  const priority = (typeof p.priority === "string" ? p.priority : "MEDIUM") as Priority;
  const related = Array.isArray(p.related_theory_ids)
    ? (p.related_theory_ids.filter((x) => typeof x === "string") as string[])
    : [];
  return {
    id,
    type: itemType,
    title: title || summary,
    summary,
    priority,
    related_theory_ids: related,
    read: false,
    created_at: typeof p.created_at === "string" ? p.created_at : new Date().toISOString(),
  };
}

const LIVE_TYPES = new Set<string>([
  "theory_update",
  "evidence",
  "connection",
  "shadow",
  "ingestion",
  "prediction",
  "system",
]);

export default function EventFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFeed();
      setItems(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setError("Feed unavailable");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live subscription: prepend recognized events, de-duplicating by id.
  useEffect(() => {
    const off = onErebusEvent((type, payload) => {
      if (!LIVE_TYPES.has(type)) return;
      const item = coerceItem(type, payload);
      if (!item) return;
      setItems((prev) => {
        const next = [item, ...prev.filter((x) => x.id !== item.id)];
        return next.slice(0, 120);
      });
      setFlashId(item.id);
      window.setTimeout(() => setFlashId((cur) => (cur === item.id ? null : cur)), 1200);
    });
    return off;
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-4 h-11 shrink-0 border-b"
        style={{ borderColor: "var(--nx-border)" }}
      >
        <div className="flex items-center gap-2">
          <span className="nx-dot nx-pulse" style={{ background: "var(--nx-accent-green)" }} />
          <span
            className="nx-mono text-[11px] font-bold tracking-widest"
            style={{ color: "var(--nx-text-secondary)" }}
          >
            LIVE FEED
          </span>
        </div>
        <button
          onClick={load}
          className="nx-mono text-[10px] px-2 py-1 rounded transition-colors"
          style={{ color: "var(--nx-text-muted)", border: "1px solid var(--nx-border)" }}
          title="Refresh feed"
        >
          ↻
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 ? (
          <FeedSkeleton />
        ) : error && items.length === 0 ? (
          <div className="p-4">
            <p className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
              {error}.
            </p>
            <button
              onClick={load}
              className="mt-2 nx-mono text-[10px] px-2 py-1 rounded"
              style={{ color: "var(--nx-text-secondary)", border: "1px solid var(--nx-border)" }}
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
              No activity yet.
            </p>
            <p className="mt-1 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
              New events appear here in real time.
            </p>
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <FeedRow key={`${it.type}-${it.id}`} item={it} flash={flashId === it.id} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FeedRow({ item, flash }: { item: FeedItem; flash: boolean }) {
  const meta = typeMeta(item.type);
  const pColor = priorityColor(item.priority);
  const theoryId = item.related_theory_ids?.[0];

  const body = (
    <li
      className="px-4 py-3 border-b transition-colors"
      style={{
        borderColor: "var(--nx-border)",
        background: flash ? "var(--nx-bg-elevated)" : "transparent",
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="nx-dot mt-1.5 shrink-0"
          style={{ background: pColor, boxShadow: `0 0 6px ${pColor}` }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="nx-mono text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded shrink-0"
              style={{ color: meta.color, border: `1px solid ${meta.color}40` }}
            >
              {meta.label}
            </span>
            <span
              className="nx-mono text-[10px] ml-auto shrink-0"
              style={{ color: "var(--nx-text-muted)" }}
            >
              {relativeTime(item.created_at)}
            </span>
          </div>
          <p
            className="mt-1.5 text-xs font-semibold leading-snug line-clamp-2"
            style={{ color: "var(--nx-text-primary)" }}
          >
            {item.title || "Untitled event"}
          </p>
          {item.summary ? (
            <p
              className="mt-1 text-[11px] leading-snug line-clamp-2"
              style={{ color: "var(--nx-text-secondary)" }}
            >
              {item.summary}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );

  if (theoryId) {
    return (
      <Link href={`/theories/${theoryId}`} className="block hover:brightness-125 transition-all">
        {body}
      </Link>
    );
  }
  return body;
}

function FeedSkeleton() {
  return (
    <ul>
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="px-4 py-3 border-b" style={{ borderColor: "var(--nx-border)" }}>
          <div className="flex items-start gap-2.5">
            <span className="nx-dot mt-1.5" style={{ background: "var(--nx-border-bright)" }} />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-16 rounded" style={{ background: "var(--nx-bg-elevated)" }} />
              <div className="h-3 w-full rounded" style={{ background: "var(--nx-bg-elevated)" }} />
              <div className="h-2.5 w-3/4 rounded" style={{ background: "var(--nx-bg-elevated)" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
