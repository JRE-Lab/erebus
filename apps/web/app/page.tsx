"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow, NodeState } from "@erebus/core/client";
import { STATE_COLORS } from "@erebus/core/client";
import {
  fetchTree,
  triggerIngest,
  fetchAutonomous,
  setAutonomous,
  roam,
  fetchContinuousRoam,
  setContinuousRoam,
  fetchCalibration,
  runGenesis,
  type AutonomousState,
  type CalibrationStats,
} from "@/lib/api";
import { ForecastTree } from "@/components/ForecastTree";
import { NodeDetail } from "@/components/NodeDetail";
import { SignalFeed } from "@/components/SignalFeed";
import { Composer } from "@/components/Composer";
import { AlertsBell } from "@/components/AlertsBell";

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
  // focus a single theory (root) onto its own graph; null = all theories
  const [focusRoot, setFocusRoot] = useState<string | null>(null);

  // autonomy: server-side roam worker state + manual roam
  const [auto, setAuto] = useState<AutonomousState | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [roaming, setRoaming] = useState(false);
  const [roamNote, setRoamNote] = useState<string | null>(null);
  // continuous roam: worker branches back-to-back while on
  const [continuous, setContinuous] = useState(false);
  const [contBusy, setContBusy] = useState(false);
  // real-world calibration (Brier over externally-resolved forecasts)
  const [cal, setCal] = useState<CalibrationStats | null>(null);
  // genesis: EREBUS births new root theories from the signal stream
  const [genesisBusy, setGenesisBusy] = useState<null | "light" | "dark">(null);

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
    try {
      const c = await fetchContinuousRoam();
      setContinuous(Boolean(c?.continuous));
    } catch {
      /* offline-safe */
    }
    try {
      setCal(await fetchCalibration());
    } catch {
      /* offline-safe */
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

  // deep-link support: /?focus=<root>&node=<id> from the Made/Market tabs
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    const focus = p.get("focus");
    const node = p.get("node");
    if (focus) setFocusRoot(focus);
    if (node) {
      setPrimary(node);
      setSelectedIds([node]);
    }
  }, []);

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

  const toggleContinuous = async () => {
    const next = !continuous;
    setContBusy(true);
    setContinuous(next); // optimistic
    try {
      const r = await setContinuousRoam(next);
      setContinuous(Boolean(r?.continuous));
      setRoamNote(
        next
          ? "Continuous roam ON — EREBUS will branch back-to-back (budget-capped)."
          : "Continuous roam off."
      );
    } catch {
      setContinuous(!next); // revert
    } finally {
      setContBusy(false);
    }
  };

  const genesis = async (dark: boolean) => {
    setGenesisBusy(dark ? "dark" : "light");
    setRoamNote(null);
    try {
      const r = await runGenesis(dark, 2);
      if (r.offline) setRoamNote("Genesis ran offline — no theories born (LLM unavailable/paused).");
      else if (!r.created.length) setRoamNote("Genesis found nothing new worth theorizing.");
      else
        setRoamNote(
          `${dark ? "⚡ Dark genesis" : "✦ Genesis"} → ${r.created.length} new theor${r.created.length === 1 ? "y" : "ies"}: ${r.created.map((t) => t.id).join(", ")}`
        );
      await load();
      await loadAuto();
      if (r.created[0]) {
        setPrimary(r.created[0].id);
        setSelectedIds([r.created[0].id]);
      }
    } catch {
      setRoamNote("Genesis failed.");
    } finally {
      setGenesisBusy(null);
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
  const darkNodes = useMemo(() => nodes.filter((n) => n.origin === "shadow").length, [nodes]);

  // roots = theories (no parent, or parent not loaded)
  const roots = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return nodes
      .filter((n) => !n.parentId || !ids.has(n.parentId))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [nodes]);

  // children index, reused for focus filtering + per-theory stats
  const childrenOf = useMemo(() => {
    const m = new Map<string, NodeRow[]>();
    for (const n of nodes) {
      if (!n.parentId) continue;
      const a = m.get(n.parentId) ?? [];
      a.push(n);
      m.set(n.parentId, a);
    }
    return m;
  }, [nodes]);

  // subtree of a given root (the node + all descendants)
  const subtreeOf = useCallback(
    (rootId: string): NodeRow[] => {
      const out: NodeRow[] = [];
      const seen = new Set<string>();
      const start = nodes.find((n) => n.id === rootId);
      const stack: NodeRow[] = start ? [start] : [];
      while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
        for (const c of childrenOf.get(n.id) ?? []) stack.push(c);
      }
      return out;
    },
    [nodes, childrenOf]
  );

  // what the graph renders: one theory's subtree when focused, else everything
  const visibleNodes = useMemo(
    () => (focusRoot ? subtreeOf(focusRoot) : nodes),
    [focusRoot, subtreeOf, nodes]
  );

  // per-theory stats for the left panel
  const rootStats = useMemo(() => {
    const m = new Map<string, { count: number; greens: number }>();
    for (const r of roots) {
      const sub = subtreeOf(r.id);
      m.set(r.id, { count: sub.length, greens: sub.filter((n) => GREEN.has(n.state)).length });
    }
    return m;
  }, [roots, subtreeOf]);

  // prefer server-reported counts (whole worldview) and fall back to the loaded tree
  const greensShown = auto?.greens ?? greens;
  const launchShown = auto?.launch_points ?? launchPoints;
  const erebusShown = auto?.erebus_nodes ?? erebusNodes;
  const autoOn = auto?.enabled ?? false;

  const focusedRoot = focusRoot ? roots.find((r) => r.id === focusRoot) ?? null : null;

  return (
    <div className="flex h-full min-h-0">
      {/* left: theories panel — select one to branch it on its own graph */}
      <aside className="hidden w-[230px] shrink-0 flex-col border-r border-nx-border lg:flex">
        <div className="shrink-0 border-b border-nx-border p-3">
          <div className="nx-label mb-2">Theories</div>
          <button
            onClick={() => setFocusRoot(null)}
            className="w-full rounded-lg border p-2 text-left text-xs transition"
            style={{
              borderColor: focusRoot === null ? "var(--nx-indigo)" : "var(--nx-border)",
              background: focusRoot === null ? "rgba(99,102,241,0.12)" : "transparent",
              color: focusRoot === null ? "var(--nx-text-primary)" : "var(--nx-text-secondary)",
            }}
          >
            ◈ All theories · {roots.length}
          </button>
        </div>
        <div className="nx-scroll min-h-0 flex-1 space-y-1 p-2">
          {roots.map((r) => {
            const st = rootStats.get(r.id) ?? { count: 1, greens: 0 };
            const active = focusRoot === r.id;
            return (
              <button
                key={r.id}
                onClick={() => {
                  setFocusRoot(r.id);
                  setPrimary(r.id);
                  setSelectedIds([r.id]);
                }}
                className="w-full rounded-lg border p-2 text-left transition"
                style={{
                  borderColor: active ? "var(--nx-indigo)" : "var(--nx-border)",
                  background: active ? "rgba(99,102,241,0.12)" : "transparent",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="nx-mono text-[10px] text-nx-text-muted">
                    {r.origin === "shadow" && (
                      <span title="dark theory" style={{ color: "#a855f7" }}>
                        ⚡{" "}
                      </span>
                    )}
                    {r.origin === "erebus" && (
                      <span title="EREBUS-made" style={{ color: "var(--nx-amber)" }}>
                        ✦{" "}
                      </span>
                    )}
                    {r.id}
                  </span>
                  <span
                    className="nx-dot"
                    style={{ background: STATE_COLORS[r.state as NodeState] ?? STATE_COLORS.speculative }}
                  />
                </div>
                <div className="line-clamp-2 text-xs leading-snug text-nx-text-primary">
                  {r.question}
                </div>
                <div className="mt-1 text-[10px] text-nx-text-muted">
                  {st.count} node{st.count === 1 ? "" : "s"}
                  {st.greens > 0 && (
                    <span style={{ color: "var(--nx-green)" }}> · {st.greens} green</span>
                  )}
                </div>
              </button>
            );
          })}
          {roots.length === 0 && (
            <p className="p-2 text-xs italic text-nx-text-muted">
              No theories yet — seed one with the composer.
            </p>
          )}
        </div>
      </aside>

      {/* center column: composer + tree */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 space-y-2 p-3">
          <Composer onCreated={load} />
          <div className="flex flex-wrap items-center gap-3">
            <Stat label="nodes" value={nodes.length} />
            <Stat label="greens" value={greensShown} accent="var(--nx-green)" glow />
            <Stat label="launch points" value={launchShown} accent="var(--nx-green)" />
            <Stat label="erebus-made" value={erebusShown} accent="var(--nx-amber)" />
            <Stat label="dark" value={darkNodes} accent="#a855f7" />
            {cal && cal.resolved > 0 && cal.meanBrier != null && (
              <div className="flex items-baseline gap-1.5" title={`${cal.resolved} forecasts resolved against external truth`}>
                <span
                  className="text-lg font-bold tabular-nums"
                  style={{ color: cal.meanBrier < 0.25 ? "var(--nx-green)" : "var(--nx-red)" }}
                >
                  {cal.meanBrier.toFixed(2)}
                </span>
                <span className="nx-label">Brier · {cal.resolved}</span>
              </div>
            )}
            {focusedRoot && (
              <span className="nx-chip nx-chip-indigo" title={focusedRoot.question}>
                focused · {focusedRoot.id}
                <button
                  type="button"
                  className="ml-1.5 opacity-70 hover:opacity-100"
                  onClick={() => setFocusRoot(null)}
                  title="Show all theories"
                >
                  ✕
                </button>
              </span>
            )}
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
              <AlertsBell
                onJump={(id) => {
                  setPrimary(id);
                  setSelectedIds([id]);
                }}
              />
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

            {/* genesis: birth NEW root theories from the signal stream */}
            <button
              type="button"
              className="nx-btn"
              disabled={genesisBusy !== null}
              onClick={() => genesis(false)}
              title="EREBUS reads the signal stream and births new root theories"
              style={{ borderColor: "var(--nx-amber)", color: "var(--nx-amber)" }}
            >
              {genesisBusy === "light" ? "Theorizing…" : "✦ Genesis"}
            </button>
            <button
              type="button"
              className="nx-btn"
              disabled={genesisBusy !== null}
              onClick={() => genesis(true)}
              title="The shadow layer: hidden agendas, cui bono, cover narratives — falsifiable dark theories"
              style={{ borderColor: "#a855f7", color: "#a855f7" }}
            >
              {genesisBusy === "dark" ? "Descending…" : "⚡ Dark genesis"}
            </button>

            {/* continuous roam: keep branching back-to-back */}
            <button
              type="button"
              role="switch"
              aria-checked={continuous}
              disabled={contBusy}
              onClick={toggleContinuous}
              className="group flex items-center gap-2 disabled:opacity-50"
              title={
                continuous
                  ? "EREBUS is roaming continuously (budget-capped)"
                  : "Roam continuously instead of one step at a time"
              }
            >
              <span
                className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                style={{ background: continuous ? "var(--nx-green)" : "var(--nx-border-strong)" }}
              >
                <span
                  className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                  style={{ transform: continuous ? "translateX(18px)" : "translateX(2px)" }}
                />
              </span>
              <span className="nx-label" style={{ color: continuous ? "var(--nx-green)" : undefined }}>
                Continuous · {contBusy ? "…" : continuous ? "ON" : "OFF"}
              </span>
            </button>

            {continuous && (
              <span className="nx-chip nx-green-glow" style={{ color: "var(--nx-green)", borderColor: "var(--nx-green)" }}>
                <span className="nx-dot" style={{ background: "var(--nx-green)" }} />
                branching live
              </span>
            )}

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
              key={focusRoot ?? "all"}
              nodes={visibleNodes}
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
