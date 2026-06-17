"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow } from "@erebus/core/client";
import { fetchTree, triggerIngest } from "@/lib/api";
import { ForecastTree } from "@/components/ForecastTree";
import { NodeDetail } from "@/components/NodeDetail";
import { SignalFeed } from "@/components/SignalFeed";
import { Composer } from "@/components/Composer";

// fetchTree may return TreeNode[] (nested) or a flat NodeRow[]. Flatten either
// to a flat list — ForecastTree nests by parentId itself.
function flatten(input: unknown): NodeRow[] {
  const out: NodeRow[] = [];
  const seen = new Set<string>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const node = n as NodeRow & { children?: unknown[] };
    if (node.id && !seen.has(node.id)) {
      seen.add(node.id);
      out.push(node);
    }
    const kids = (n as { children?: unknown[] }).children;
    if (Array.isArray(kids)) kids.forEach(walk);
  };
  if (Array.isArray(input)) input.forEach(walk);
  else if (input && typeof input === "object" && "nodes" in (input as object)) {
    const arr = (input as { nodes?: unknown[] }).nodes;
    if (Array.isArray(arr)) arr.forEach(walk);
  }
  return out;
}

const GREEN = new Set(["corroborated", "resolved_true"]);

export default function ExplorerPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await fetchTree();
      setNodes(flatten(t));
    } catch {
      setNodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000); // poll so the tree greens live
    return () => clearInterval(id);
  }, [load]);

  const onSelect = useCallback((id: string, additive: boolean) => {
    setPrimary(id);
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      }
      return [id];
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setPrimary(null);
  }, []);

  const runIngest = async () => {
    setIngesting(true);
    try {
      await triggerIngest();
      await load();
    } catch {
      /* offline-safe */
    } finally {
      setIngesting(false);
    }
  };

  const greens = useMemo(() => nodes.filter((n) => GREEN.has(n.state)).length, [nodes]);
  const launchPoints = useMemo(() => nodes.filter((n) => n.isLaunchPoint).length, [nodes]);

  return (
    <div className="flex h-full min-h-0">
      {/* center column: composer + tree */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 space-y-2 p-3">
          <Composer onCreated={load} />
          <div className="flex flex-wrap items-center gap-3">
            <Stat label="nodes" value={nodes.length} />
            <Stat label="greens" value={greens} accent="var(--nx-green)" glow />
            <Stat label="launch points" value={launchPoints} accent="var(--nx-green)" />
            <div className="ml-auto flex items-center gap-2">
              {selectedIds.length >= 2 && (
                <span className="nx-chip nx-chip-indigo">{selectedIds.length} selected</span>
              )}
              {selectedIds.length > 0 && (
                <button className="nx-btn" onClick={clearSelection}>
                  Clear
                </button>
              )}
              <button className="nx-btn" disabled={ingesting} onClick={runIngest}>
                {ingesting ? "Running…" : "Run ingest"}
              </button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 border-t border-nx-border">
          {loading && nodes.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-nx-text-muted">
              Loading the tree…
            </div>
          ) : (
            <ForecastTree
              nodes={nodes}
              selectedId={primary}
              selectedIds={selectedIds}
              onSelect={onSelect}
            />
          )}
        </div>
      </section>

      {/* right: node detail */}
      <aside className="flex w-[420px] shrink-0 flex-col border-l border-nx-border">
        <NodeDetail
          nodeId={primary}
          selectedIds={selectedIds}
          onRefresh={load}
          onClearSelection={clearSelection}
        />
      </aside>

      {/* far right: signal feed rail */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-l border-nx-border xl:flex">
        <SignalFeed onIngested={load} />
      </aside>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  glow,
}: {
  label: string;
  value: number;
  accent?: string;
  glow?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={`text-lg font-bold tabular-nums ${glow && value > 0 ? "nx-green-glow" : ""}`}
        style={{ color: accent ?? "var(--nx-text-primary)" }}
      >
        {value}
      </span>
      <span className="nx-label">{label}</span>
    </div>
  );
}
