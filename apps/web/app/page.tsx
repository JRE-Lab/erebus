"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow } from "@erebus/core/client";
import {
  fetchTree,
  triggerIngest,
  fetchAutonomous,
  setAutonomous,
  roam,
  type AutonomousState,
} from "@/lib/api";
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

  // autonomy: server-side roam worker state + manual roam
  const [auto, setAuto] = useState<AutonomousState | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [roaming, setRoaming] = useState(false);
  const [roamNote, setRoamNote] = useState<string | null>(null);

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

  const loadAuto = useCallback(async () => {
    try {
      setAuto(await fetchAutonomous());
    } catch {
      /* offline-safe: leave previous state */
    }
  }, []);

  useEffect(() => {
    load();
    loadAuto();
    const id = setInterval(() => {
      load();
      loadAuto(); // keep autonomous counts live while EREBUS roams
    }, 10000); // poll so the tree greens live
    return () => clearInterval(id);
  }, [load, loadAuto]);

  const toggleAuto = async () => {
    const next = !(auto?.enabled ?? false);
    setAutoBusy(true);
    try {
      const r = await setAutonomous(next);
      setAuto((prev) => ({ ...(prev ?? {}), ...r }));
      await loadAuto();
    } catch {
      /* offline-safe */
    } finally {
      setAutoBusy(false);
    }
  };

  const roamOnce = async () => {
    setRoaming(true);
    setRoamNote(null);
    try {
      const r = await roam();
      if (r.status === "blocked") setRoamNote(`Roam blocked: ${r.blocked ?? "unavailable"}`);
      else if (r.status === "idle") setRoamNote("Roam idle — nothing worth expanding right now.");
      else
        setRoamNote(
          `Roamed → expanded ${r.expanded} branch${r.expanded === 1 ? "" : "es"}${
            r.nodeId ? ` from ${r.nodeId}` : ""
          }.`
        );
      await load();
      await loadAuto();
      if (r.nodeId) {
        setPrimary(r.nodeId);
        setSelectedIds([r.nodeId]);
      }
    } catch {
      setRoamNote("Roam failed.");
    } finally {
      setRoaming(false);
    }
  };

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

  // after NodeDetail pursues a direction, refresh the tree and jump to the new child
  const onPursued = useCallback(
    async (id: string) => {
      await load();
      setPrimary(id);
      setSelectedIds([id]);
    },
    [load]
  );

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
  const erebusNodes = useMemo(() => nodes.filter((n) => n.origin === "erebus").length, [nodes]);

  // prefer server-reported counts (whole worldview) and fall back to the loaded tree
  const greensShown = auto?.greens ?? greens;
  const launchShown = auto?.launch_points ?? launchPoints;
  const erebusShown = auto?.erebus_nodes ?? erebusNodes;
  const autoOn = auto?.enabled ?? false;

  return (
    <div className="flex h-full min-h-0">
      {/* center column: composer + tree */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 space-y-2 p-3">
          <Composer onCreated={load} />
          <div className="flex flex-wrap items-center gap-3">
            <Stat label="nodes" value={nodes.length} />
            <Stat label="greens" value={greensShown} accent="var(--nx-green)" glow />
            <Stat label="launch points" value={launchShown} accent="var(--nx-green)" />
            <Stat label="erebus-made" value={erebusShown} accent="var(--nx-amber)" />
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

          {/* AUTONOMOUS control cluster */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-nx-border bg-nx-bg-card/60 px-3 py-2">
            <button
              type="button"
              role="switch"
              aria-checked={autoOn}
              disabled={autoBusy}
              onClick={toggleAuto}
              className="group flex items-center gap-2 disabled:opacity-50"
              title={autoOn ? "EREBUS is roaming on its own" : "Let EREBUS roam on its own"}
            >
              <span
                className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                style={{
                  background: autoOn ? "var(--nx-amber)" : "var(--nx-border-strong)",
                }}
              >
                <span
                  className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                  style={{ transform: autoOn ? "translateX(18px)" : "translateX(2px)" }}
                />
              </span>
              <span className="nx-label" style={{ color: autoOn ? "var(--nx-amber)" : undefined }}>
                EREBUS Autonomous · {autoBusy ? "…" : autoOn ? "ON" : "OFF"}
              </span>
            </button>

            {autoOn && (
              <span className="nx-chip" style={{ color: "var(--nx-amber)", borderColor: "var(--nx-amber)" }}>
                <span className="nx-dot" style={{ background: "var(--nx-amber)" }} />
                roaming
              </span>
            )}

            <button
              type="button"
              className="nx-btn"
              disabled={roaming}
              onClick={roamOnce}
              title="Have EREBUS pick a branch and expand it once"
            >
              {roaming ? "Roaming…" : "Roam once ▸"}
            </button>

            {roamNote && (
              <span className="text-[11px] text-nx-text-secondary">{roamNote}</span>
            )}

            <span className="ml-auto flex items-center gap-3 text-[11px] text-nx-text-muted">
              <span>
                greens <span className="nx-mono text-nx-text-secondary">{greensShown}</span>
              </span>
              <span>
                launch <span className="nx-mono text-nx-text-secondary">{launchShown}</span>
              </span>
              <span>
                erebus <span className="nx-mono" style={{ color: "var(--nx-amber)" }}>{erebusShown}</span>
              </span>
            </span>
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
          onPursued={onPursued}
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
