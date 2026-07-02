"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { NodeRow, NodeState } from "@erebus/core/client";
import { STATE_COLORS } from "@erebus/core/client";
import { fetchNodes } from "@/lib/api";

// ----------------------------------------------------------------------------
// "Made" — every theory/branch EREBUS authored on its own (origin === "erebus"),
// grouped under the root theory it grew from. The autonomous mind's output.
// ----------------------------------------------------------------------------

const GREEN = new Set(["corroborated", "resolved_true"]);

export default function MadePage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const n = await fetchNodes();
      setNodes(Array.isArray(n) ? n : []);
    } catch {
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [load]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const rootOf = useCallback(
    (n: NodeRow): NodeRow => {
      let cur = n;
      const seen = new Set<string>();
      while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentId)!;
      }
      return cur;
    },
    [byId]
  );

  const made = useMemo(
    () => nodes.filter((n) => n.origin === "erebus" || n.origin === "shadow"),
    [nodes]
  );
  const darkCount = useMemo(() => made.filter((n) => n.origin === "shadow").length, [made]);

  // group erebus nodes under their root theory
  const groups = useMemo(() => {
    const m = new Map<string, { root: NodeRow; items: NodeRow[] }>();
    for (const n of made) {
      const root = rootOf(n);
      const g = m.get(root.id) ?? { root, items: [] };
      g.items.push(n);
      m.set(root.id, g);
    }
    for (const g of m.values()) g.items.sort((a, b) => a.id.localeCompare(b.id));
    return Array.from(m.values()).sort((a, b) => b.items.length - a.items.length);
  }, [made, rootOf]);

  const greens = useMemo(() => made.filter((n) => GREEN.has(n.state)).length, [made]);

  return (
    <div className="nx-scroll h-full">
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-nx-text-primary">EREBUS-made theories</h1>
            <p className="mt-1 text-sm text-nx-text-secondary">
              Branches EREBUS grew on its own while roaming — grouped under the theory each sprang from.
            </p>
          </div>
          <div className="flex gap-4 text-right">
            <Stat label="made" value={made.length} accent="var(--nx-amber)" />
            <Stat label="dark" value={darkCount} accent="#a855f7" />
            <Stat label="greened" value={greens} accent="var(--nx-green)" />
          </div>
        </header>

        {loading && nodes.length === 0 ? (
          <p className="text-sm text-nx-text-muted">Loading…</p>
        ) : made.length === 0 ? (
          <div className="nx-card p-6 text-center">
            <p className="text-sm text-nx-text-secondary">EREBUS hasn&apos;t authored any theories yet.</p>
            <p className="mt-1 text-xs text-nx-text-muted">
              Turn on Autonomous or Continuous roam in the Explorer — branches will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.root.id}>
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="nx-dot"
                    style={{ background: STATE_COLORS[g.root.state as NodeState] ?? STATE_COLORS.speculative }}
                  />
                  <h2 className="text-sm font-semibold text-nx-text-primary">
                    <span className="nx-mono text-[11px] text-nx-text-muted">{g.root.id}</span>{" "}
                    {g.root.question}
                  </h2>
                  <span className="nx-chip nx-chip-indigo ml-auto">{g.items.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {g.items.map((n) => (
                    <Link
                      key={n.id}
                      href={`/?focus=${encodeURIComponent(g.root.id)}&node=${encodeURIComponent(n.id)}`}
                      className="nx-card block border-l-2 p-3 transition hover:bg-nx-bg-elevated"
                      style={{ borderLeftColor: STATE_COLORS[n.state as NodeState] ?? STATE_COLORS.speculative }}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="nx-mono text-[10px] text-nx-text-muted">
                          {n.origin === "shadow" && (
                            <span title="dark theory" style={{ color: "#a855f7" }}>⚡ </span>
                          )}
                          {n.id}
                        </span>
                        <span
                          className="nx-chip"
                          style={{
                            color: STATE_COLORS[n.state as NodeState] ?? undefined,
                            borderColor: STATE_COLORS[n.state as NodeState] ?? undefined,
                          }}
                        >
                          {n.state.replace("_", " ")}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm font-medium text-nx-text-primary">{n.question}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-snug text-nx-text-secondary">{n.outcome}</p>
                      <ConfBar value={n.confirmation} />
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, (value + 1) / 2)) * 100);
  const color = value >= 0.34 ? "var(--nx-green)" : value <= -0.5 ? "var(--nx-red)" : "var(--nx-text-muted)";
  return (
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-nx-bg-elevated">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-lg font-bold tabular-nums" style={{ color: accent ?? "var(--nx-text-primary)" }}>
        {value}
      </span>
      <span className="nx-label">{label}</span>
    </div>
  );
}
