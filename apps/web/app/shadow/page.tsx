"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow } from "@erebus/core/client";
import { fetchNodes, fetchNode, shadowNode } from "@/lib/api";

// ----------------------------------------------------------------------------
// Shadow Board (CLAUDE.md §3.3) — a dedicated deception-analysis workspace.
// Powerful actors lie deliberately; the Shadow Board models that. Each read
// states the indicators that would CONFIRM or REFUTE the deception thesis.
//
// Aesthetic: deep-red / amber accents. Defensive everywhere — the shadow_reads
// payload may arrive snake_case or camelCase, and any field may be null. Empty
// and offline states fall back to guidance rather than crashing.
// ----------------------------------------------------------------------------

const RED = "#ef4444";
const RED_DEEP = "rgba(239, 68, 68, 0.4)";
const RED_DIM = "rgba(239, 68, 68, 0.08)";

// A single shadow read, tolerant of either serialization. The API currently
// returns raw Drizzle rows (camelCase); the spec documents snake_case. We read
// both so the page is correct regardless of how the route evolves.
interface ShadowReadLike {
  id?: string | null;
  revealed_preference?: string | null;
  revealedPreference?: string | null;
  cui_bono?: string | null;
  cuiBono?: string | null;
  counter_narrative?: string | null;
  counterNarrative?: string | null;
  deception_indicators?: string[] | null;
  deceptionIndicators?: string[] | null;
  misdirection?: string | null;
  spawned_node?: string | null;
  spawnedNode?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
}

interface NormalizedRead {
  key: string;
  revealedPreference: string | null;
  cuiBono: string | null;
  counterNarrative: string | null;
  deceptionIndicators: string[];
  misdirection: string | null;
  spawnedNode: string | null;
  createdAt: string | null;
}

function normalizeRead(r: ShadowReadLike, i: number): NormalizedRead {
  const inds = r.deception_indicators ?? r.deceptionIndicators ?? [];
  return {
    key: r.id ?? r.created_at ?? r.createdAt ?? `read-${i}`,
    revealedPreference: r.revealed_preference ?? r.revealedPreference ?? null,
    cuiBono: r.cui_bono ?? r.cuiBono ?? null,
    counterNarrative: r.counter_narrative ?? r.counterNarrative ?? null,
    deceptionIndicators: Array.isArray(inds) ? inds.filter(Boolean) : [],
    misdirection: r.misdirection ?? null,
    spawnedNode: r.spawned_node ?? r.spawnedNode ?? null,
    createdAt: r.created_at ?? r.createdAt ?? null,
  };
}

function fmtDate(d?: string | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ShadowBoardPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // shadow reads for the selected node + counts per node (for list highlight).
  const [reads, setReads] = useState<NormalizedRead[]>([]);
  const [loadingReads, setLoadingReads] = useState(false);
  const [readCounts, setReadCounts] = useState<Record<string, number>>({});

  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // --- load the forecast node list -----------------------------------------
  const loadNodes = useCallback(async () => {
    try {
      const n = await fetchNodes().catch(() => []);
      setNodes(Array.isArray(n) ? (n as NodeRow[]) : []);
    } catch {
      setNodes([]);
    } finally {
      setLoadingNodes(false);
    }
  }, []);

  useEffect(() => {
    loadNodes();
  }, [loadNodes]);

  // --- load detail (shadow reads) for the selected node --------------------
  const loadReads = useCallback(async (id: string) => {
    setLoadingReads(true);
    try {
      const detail = (await fetchNode(id)) as { shadow_reads?: unknown } | null;
      const raw = Array.isArray(detail?.shadow_reads)
        ? (detail!.shadow_reads as ShadowReadLike[])
        : [];
      const normalized = raw.map(normalizeRead);
      setReads(normalized);
      setReadCounts((prev) => ({ ...prev, [id]: normalized.length }));
    } catch {
      setReads([]);
    } finally {
      setLoadingReads(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadReads(selectedId);
    else setReads([]);
  }, [selectedId, loadReads]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  // --- run a shadow read ----------------------------------------------------
  const runShadow = async () => {
    if (!selectedId) return;
    setRunning(true);
    setNote(null);
    try {
      const r = (await shadowNode(selectedId)) as
        | { offline?: boolean; spawnedNode?: string | null; shadowRead?: unknown | null }
        | undefined;
      if (r?.offline) {
        setNote("Shadow read generated (offline fallback — LLM unavailable).");
      } else if (r && r.shadowRead === null) {
        setNote("No shadow read returned for this node.");
      } else if (r?.spawnedNode) {
        setNote(`Shadow read complete — spawned a contested node (${r.spawnedNode}).`);
      } else {
        setNote("Shadow read complete.");
      }
      await loadReads(selectedId);
    } catch {
      setNote("Could not run shadow read.");
    } finally {
      setRunning(false);
    }
  };

  const latest = reads[0] ?? null;
  const history = reads.slice(1);

  return (
    <div className="nx-scroll h-full">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        {/* header --------------------------------------------------------- */}
        <header
          className="nx-card p-5"
          style={{ borderColor: RED_DEEP, background: `linear-gradient(180deg, ${RED_DIM}, transparent)` }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="nx-dot"
              style={{ background: RED, boxShadow: `0 0 10px ${RED_DEEP}` }}
            />
            <h1 className="text-xl font-bold" style={{ color: "#fca5a5" }}>
              Shadow Board
            </h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-nx-text-secondary">
            Model deliberate deception by powerful actors. Every read states the indicators that
            would <span style={{ color: "#86efac", fontWeight: 600 }}>confirm</span> OR{" "}
            <span style={{ color: "#fca5a5", fontWeight: 600 }}>refute</span> it — surfacing
            revealed preference, who benefits, the counter-narrative, and the misdirection.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
          {/* left: forecast node list ----------------------------------- */}
          <aside className="nx-card flex max-h-[70vh] flex-col overflow-hidden">
            <div className="border-b border-nx-border px-4 py-3">
              <h2 className="nx-label">Forecast nodes</h2>
            </div>
            <div className="nx-scroll flex-1">
              {loadingNodes && nodes.length === 0 ? (
                <p className="p-4 text-sm text-nx-text-muted">Loading…</p>
              ) : nodes.length === 0 ? (
                <div className="p-4">
                  <p className="text-sm text-nx-text-secondary">No forecast nodes yet.</p>
                  <p className="mt-1 text-xs text-nx-text-muted">
                    Create a forecast on the Explorer, then return here to run a shadow read
                    against it.
                  </p>
                </div>
              ) : (
                <ul>
                  {nodes.map((n) => {
                    const active = n.id === selectedId;
                    const count = readCounts[n.id] ?? 0;
                    const flagged = count > 0;
                    return (
                      <li key={n.id}>
                        <button
                          onClick={() => setSelectedId(n.id)}
                          className="flex w-full flex-col gap-1 border-b border-nx-border px-4 py-3 text-left transition-colors"
                          style={{
                            background: active ? RED_DIM : "transparent",
                            borderLeft: active
                              ? `2px solid ${RED}`
                              : "2px solid transparent",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="nx-mono text-[11px] text-nx-text-muted">
                              {n.id}
                            </span>
                            {flagged && (
                              <span
                                className="nx-chip"
                                style={{
                                  background: RED_DIM,
                                  borderColor: RED_DEEP,
                                  color: "#fca5a5",
                                }}
                                title={`${count} shadow read${count === 1 ? "" : "s"}`}
                              >
                                ◆ {count}
                              </span>
                            )}
                          </div>
                          <span className="line-clamp-2 text-sm text-nx-text-primary">
                            {n.question}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          {/* main: selected node + shadow read --------------------------- */}
          <main className="space-y-5">
            {!selectedNode ? (
              <div className="nx-card flex flex-col items-center justify-center p-12 text-center">
                <span
                  className="mb-3 text-3xl"
                  style={{ color: RED }}
                  aria-hidden
                >
                  ◆
                </span>
                <p className="text-sm font-medium text-nx-text-primary">
                  Select a forecast node
                </p>
                <p className="mt-1 max-w-sm text-xs text-nx-text-muted">
                  Pick a node from the left to interrogate it for deliberate deception. Nodes
                  with prior reads are flagged.
                </p>
              </div>
            ) : (
              <>
                {/* selected node header + run button */}
                <div
                  className="nx-card p-5"
                  style={{ borderColor: RED_DEEP }}
                >
                  <span className="nx-mono text-[11px] text-nx-text-muted">
                    {selectedNode.id}
                  </span>
                  <h2 className="mt-1 text-base font-semibold text-nx-text-primary">
                    {selectedNode.question}
                  </h2>
                  {selectedNode.outcome && (
                    <p className="mt-2 text-sm leading-snug text-nx-text-secondary">
                      {selectedNode.outcome}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      onClick={runShadow}
                      disabled={running}
                      className="nx-btn"
                      style={{
                        background: RED,
                        borderColor: RED,
                        color: "#fff",
                      }}
                    >
                      {running ? "Reading the shadows…" : "Run Shadow Read"}
                    </button>
                    {note && (
                      <span className="text-xs text-nx-text-secondary">{note}</span>
                    )}
                  </div>
                </div>

                {/* latest read */}
                <section>
                  <h3 className="nx-label mb-2">Latest shadow read</h3>
                  {loadingReads ? (
                    <div className="nx-card p-6 text-sm text-nx-text-muted">Loading…</div>
                  ) : latest ? (
                    <ShadowReadCard read={latest} primary />
                  ) : (
                    <div
                      className="nx-card p-6 text-center"
                      style={{ borderColor: RED_DEEP }}
                    >
                      <p className="text-sm text-nx-text-secondary">
                        No shadow read for this node yet.
                      </p>
                      <p className="mt-1 text-xs text-nx-text-muted">
                        Run a read above to model how a powerful actor might be deceiving the
                        market on this thesis.
                      </p>
                    </div>
                  )}
                </section>

                {/* history */}
                {history.length > 0 && (
                  <section>
                    <h3 className="nx-label mb-2">Prior reads ({history.length})</h3>
                    <div className="space-y-3">
                      {history.map((r) => (
                        <ShadowReadCard key={r.key} read={r} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// A single shadow read, rendered defensively. `primary` gives the latest read a
// stronger deep-red frame.
// ----------------------------------------------------------------------------
function ShadowReadCard({ read, primary }: { read: NormalizedRead; primary?: boolean }) {
  const date = fmtDate(read.createdAt);
  return (
    <div
      className="nx-card-elevated space-y-3 p-4 nx-fade-in"
      style={{
        borderLeft: `3px solid ${RED}`,
        ...(primary ? { borderColor: RED_DEEP, boxShadow: `0 0 0 1px ${RED_DIM}` } : {}),
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className="nx-badge"
          style={{ borderColor: RED_DEEP, color: "#fca5a5" }}
        >
          Shadow read
        </span>
        {date && <span className="text-[11px] text-nx-text-muted">{date}</span>}
      </div>

      <Field label="Revealed preference" value={read.revealedPreference} />
      <Field label="Cui bono — who benefits" value={read.cuiBono} accent="amber" />
      <Field label="Counter-narrative" value={read.counterNarrative} />
      <Field label="Misdirection" value={read.misdirection} accent="amber" />

      <div>
        <div className="nx-label mb-1.5">Deception indicators</div>
        {read.deceptionIndicators.length > 0 ? (
          <ul className="space-y-1.5">
            {read.deceptionIndicators.map((d, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm leading-snug text-nx-text-primary"
              >
                <span style={{ color: RED }} aria-hidden>
                  ◆
                </span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs italic text-nx-text-muted">
            No specific indicators recorded.
          </p>
        )}
      </div>

      {read.spawnedNode ? (
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
          style={{ background: RED_DIM, border: `1px solid ${RED_DEEP}`, color: "#fca5a5" }}
        >
          <span aria-hidden>⚑</span>
          <span>
            Spawned a contested node:{" "}
            <span className="nx-mono">{read.spawnedNode}</span>
          </span>
        </div>
      ) : (
        <div className="text-[11px] italic text-nx-text-muted">
          No contested node spawned from this read.
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | null;
  accent?: "amber";
}) {
  return (
    <div>
      <div
        className="nx-label mb-0.5"
        style={accent === "amber" ? { color: "var(--nx-amber)" } : undefined}
      >
        {label}
      </div>
      {value ? (
        <p className="text-sm leading-snug text-nx-text-primary">{value}</p>
      ) : (
        <p className="text-xs italic text-nx-text-muted">—</p>
      )}
    </div>
  );
}
