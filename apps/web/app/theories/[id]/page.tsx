"use client";

// Theory workspace: header + interactive tree + selected-node panel + Shadow Board.
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CONFIDENCE_COLORS } from "@erebus/core";
import type {
  Theory,
  TheoryNode,
  EvidenceStatus,
  Confidence,
  ConnectionRelationship,
} from "@erebus/core";
import TheoryTree from "@/components/TheoryTree";
import ShadowBoard from "@/components/ShadowBoard";
import EvidencePanel from "@/components/EvidencePanel";
import {
  fetchTheory,
  fetchTree,
  expandNode,
  checkNodeEvidence,
  checkAllEvidence,
  markEvidence,
  runShadowBoard,
} from "@/lib/api";
import { onErebusEvent } from "@/lib/ws";

type FullTheory = Theory & {
  connections: unknown[];
  predictions: unknown[];
  confidenceHistory: unknown[];
};

interface ConnectionRow {
  id?: number;
  a_id?: string;
  b_id?: string;
  relationship?: ConnectionRelationship | string;
  strength?: number;
  rationale?: string | null;
}

const REL_COLOR: Record<string, string> = {
  supports: "var(--nx-accent-green)",
  explains: "var(--nx-accent-cyan)",
  deepens: "var(--nx-accent-indigo)",
  predicts: "var(--nx-accent-purple)",
  tension: "var(--nx-accent-amber)",
  contradicts: "var(--nx-accent-red)",
};

function confColor(c: Confidence | undefined): string {
  return (c && CONFIDENCE_COLORS[c]) || "var(--nx-text-muted)";
}

function isConnectionRow(x: unknown): x is ConnectionRow {
  return typeof x === "object" && x !== null;
}

export default function TheoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [theory, setTheory] = useState<FullTheory | null>(null);
  const [tree, setTree] = useState<TheoryNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Per-action loading flags.
  const [expandingQ, setExpandingQ] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [boardRunning, setBoardRunning] = useState(false);
  const [checkAllRunning, setCheckAllRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<"board" | "connections">("board");

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const res = await fetchTree(id);
      const nodes = Array.isArray(res.data) ? res.data : [];
      setTree(nodes);
      // Auto-select the root if nothing is selected yet.
      setSelectedId((cur) => {
        if (cur && nodes.some((n) => n.id === cur)) return cur;
        const root = nodes.find((n) => n.parent_id === null) ?? nodes[0];
        return root ? root.id : null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tree");
    }
  }, [id]);

  const loadTheory = useCallback(async () => {
    try {
      const res = await fetchTheory(id);
      setTheory(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load theory");
    }
  }, [id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      await Promise.all([loadTheory(), loadTree()]);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [loadTheory, loadTree]);

  // Live updates: refetch tree/theory when events for this theory arrive.
  const loadTreeRef = useRef(loadTree);
  const loadTheoryRef = useRef(loadTheory);
  loadTreeRef.current = loadTree;
  loadTheoryRef.current = loadTheory;
  useEffect(() => {
    return onErebusEvent((type, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const relates = p.theoryId === id || p.theory_id === id || p.id === id;
      if (!relates) return;
      if (type.includes("node") || type.includes("tree") || type.includes("evidence")) {
        void loadTreeRef.current();
      }
      if (type.includes("theory") || type.includes("shadow") || type.includes("score")) {
        void loadTheoryRef.current();
      }
    });
  }, [id]);

  const selectedNode = useMemo(
    () => tree.find((n) => n.id === selectedId) ?? null,
    [tree, selectedId]
  );

  // --- Actions ---
  const handleExpand = useCallback(
    async (nodeId: string, question: string) => {
      setExpandingQ(`${nodeId}::${question}`);
      try {
        await expandNode(nodeId, question);
        await loadTree();
        flash("Branch expanded.");
      } catch (e) {
        flash(e instanceof Error ? e.message : "Expand failed");
      } finally {
        setExpandingQ(null);
      }
    },
    [loadTree, flash]
  );

  const handleCheckEvidence = useCallback(async () => {
    if (!selectedNode) return;
    setEvidenceLoading(true);
    try {
      const res = await checkNodeEvidence(selectedNode.id);
      await loadTree();
      flash(`Evidence checked → ${res.data?.status ?? "updated"}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Evidence check failed");
    } finally {
      setEvidenceLoading(false);
    }
  }, [selectedNode, loadTree, flash]);

  const handleMark = useCallback(
    async (status: EvidenceStatus) => {
      if (!selectedNode) return;
      setEvidenceLoading(true);
      try {
        await markEvidence(selectedNode.id, status);
        await loadTree();
        flash(`Marked ${status}.`);
      } catch (e) {
        flash(e instanceof Error ? e.message : "Mark failed");
      } finally {
        setEvidenceLoading(false);
      }
    },
    [selectedNode, loadTree, flash]
  );

  const handleRunBoard = useCallback(async () => {
    setBoardRunning(true);
    try {
      const res = await runShadowBoard(id);
      await loadTheory();
      setTab("board");
      const o = res.data?.overall;
      flash(o ? `Shadow Board: ${o.verdict} — ${o.summary?.slice(0, 80) ?? ""}` : "Shadow Board complete.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Shadow Board failed");
    } finally {
      setBoardRunning(false);
    }
  }, [id, loadTheory, flash]);

  const handleCheckAll = useCallback(async () => {
    setCheckAllRunning(true);
    try {
      const res = await checkAllEvidence(id);
      await loadTree();
      flash(`Checked ${res.data?.checked ?? 0} nodes · $${(res.data?.totalCost ?? 0).toFixed(4)}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Check-all failed");
    } finally {
      setCheckAllRunning(false);
    }
  }, [id, loadTree, flash]);

  // --- Connections (defensively narrowed) ---
  const connections: ConnectionRow[] = useMemo(() => {
    const raw = theory?.connections;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isConnectionRow);
  }, [theory]);

  // --- Render ---
  if (loading) {
    return (
      <div className="p-6">
        <div className="nx-card animate-pulse" style={{ height: 64, marginBottom: 16 }} />
        <div className="grid grid-cols-1 gap-4" style={{ gridTemplateColumns: "1fr 360px" }}>
          <div className="nx-card animate-pulse" style={{ height: 420 }} />
          <div className="nx-card animate-pulse" style={{ height: 420 }} />
        </div>
      </div>
    );
  }

  if (error && !theory) {
    return (
      <div className="p-6">
        <Link href="/" className="text-xs" style={{ color: "var(--nx-accent-indigo)" }}>
          ← Back to dashboard
        </Link>
        <div
          className="nx-card mt-4 text-sm"
          style={{ borderColor: "var(--nx-accent-red)", color: "var(--nx-accent-red)" }}
        >
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="px-6 pt-5 pb-4 border-b" style={{ borderColor: "var(--nx-border)" }}>
        <Link
          href="/"
          className="text-[11px] inline-flex items-center gap-1 mb-2 transition-colors"
          style={{ color: "var(--nx-accent-indigo)" }}
        >
          ← Back to dashboard
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold leading-tight" style={{ color: "var(--nx-text-primary)" }}>
                {theory?.title || "Untitled theory"}
              </h1>
              {theory?.is_shadow && (
                <span
                  className="nx-badge"
                  style={{ background: "var(--nx-accent-purple)22", color: "var(--nx-accent-purple)" }}
                >
                  Shadow
                </span>
              )}
            </div>
            {theory?.summary && (
              <p className="text-xs mt-1 max-w-3xl leading-relaxed" style={{ color: "var(--nx-text-secondary)" }}>
                {theory.summary}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span
                className="nx-badge"
                style={{
                  background: `${confColor(theory?.confidence)}22`,
                  color: confColor(theory?.confidence),
                  border: `1px solid ${confColor(theory?.confidence)}66`,
                }}
              >
                <span className="nx-dot" style={{ background: confColor(theory?.confidence) }} />
                {theory?.confidence ?? "—"}
              </span>
              <span
                className="nx-badge"
                style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-secondary)" }}
              >
                Score {typeof theory?.score === "number" ? theory.score.toFixed(2) : "—"}
              </span>
              <span
                className="nx-badge"
                style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-secondary)" }}
              >
                {theory?.status ?? "—"}
              </span>
              {(theory?.domains ?? []).map((d) => (
                <span
                  key={d}
                  className="nx-badge"
                  style={{ background: "var(--nx-bg-card)", color: "var(--nx-text-muted)" }}
                >
                  {d}
                </span>
              ))}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleRunBoard}
              disabled={boardRunning}
              className="text-[11px] font-semibold px-3 py-2 rounded transition-colors disabled:opacity-50"
              style={{ background: "var(--nx-accent-purple)", color: "#fff" }}
            >
              {boardRunning ? "Running…" : "Run Shadow Board"}
            </button>
            <button
              onClick={handleCheckAll}
              disabled={checkAllRunning}
              className="text-[11px] font-semibold px-3 py-2 rounded transition-colors disabled:opacity-50"
              style={{ background: "var(--nx-accent-cyan)", color: "#04141a" }}
            >
              {checkAllRunning ? "Checking…" : "Check All Evidence"}
            </button>
          </div>
        </div>
      </header>

      {/* Body: tree + side panel */}
      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: "1fr 380px" }}>
        {/* Tree */}
        <div className="min-w-0 border-r" style={{ borderColor: "var(--nx-border)" }}>
          {tree.length === 0 ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div>
                <div className="text-3xl mb-2" style={{ color: "var(--nx-text-muted)" }}>
                  ◌
                </div>
                <p className="text-sm" style={{ color: "var(--nx-text-secondary)" }}>
                  No tree nodes yet.
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--nx-text-muted)" }}>
                  Expand a question once a root node exists.
                </p>
              </div>
            </div>
          ) : (
            <TheoryTree nodes={tree} selectedId={selectedId} onSelect={setSelectedId} />
          )}
        </div>

        {/* Right panel */}
        <aside className="overflow-y-auto p-4 space-y-4" style={{ background: "var(--nx-bg-secondary)" }}>
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              expandingQ={expandingQ}
              onExpand={handleExpand}
              onCheckEvidence={handleCheckEvidence}
              onMark={handleMark}
              evidenceLoading={evidenceLoading}
            />
          ) : (
            <div className="nx-card text-center text-xs" style={{ color: "var(--nx-text-muted)" }}>
              Select a node to inspect it.
            </div>
          )}

          {/* Tabs: Shadow Board / Connections */}
          <div>
            <div className="flex items-center gap-1 mb-2">
              <TabButton active={tab === "board"} onClick={() => setTab("board")}>
                Shadow Board
              </TabButton>
              <TabButton active={tab === "connections"} onClick={() => setTab("connections")}>
                Connections ({connections.length})
              </TabButton>
            </div>
            {tab === "board" ? (
              <ShadowBoard theoryId={id} />
            ) : (
              <ConnectionsList connections={connections} />
            )}
          </div>
        </aside>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-4 right-4 z-50 px-3.5 py-2.5 rounded-md text-xs max-w-sm shadow-lg"
          style={{
            background: "var(--nx-bg-elevated)",
            border: "1px solid var(--nx-border-bright)",
            color: "var(--nx-text-primary)",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors"
      style={{
        background: active ? "var(--nx-bg-elevated)" : "transparent",
        color: active ? "var(--nx-text-primary)" : "var(--nx-text-muted)",
        border: `1px solid ${active ? "var(--nx-border-bright)" : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}

function NodeDetail({
  node,
  expandingQ,
  onExpand,
  onCheckEvidence,
  onMark,
  evidenceLoading,
}: {
  node: TheoryNode;
  expandingQ: string | null;
  onExpand: (nodeId: string, question: string) => void;
  onCheckEvidence: () => void;
  onMark: (status: EvidenceStatus) => void;
  evidenceLoading: boolean;
}) {
  const exploredColor =
    node.parent_id === null
      ? "var(--nx-accent-indigo)"
      : node.explored_by === "erebus"
        ? "var(--nx-accent-amber)"
        : "var(--nx-accent-indigo)";
  const questions = Array.isArray(node.questions) ? node.questions.filter(Boolean) : [];

  return (
    <div className="space-y-3">
      {/* Node header */}
      <div className="nx-card">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span
            className="nx-badge"
            style={{ background: `${exploredColor}22`, color: exploredColor }}
          >
            {node.parent_id === null ? "Root" : node.explored_by === "erebus" ? "EREBUS" : "User"}
          </span>
          <span className="nx-badge" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-muted)" }}>
            Depth {node.depth ?? 0}
          </span>
          {node.shadow_tagged && (
            <span className="nx-badge" style={{ background: "var(--nx-accent-purple)22", color: "var(--nx-accent-purple)" }}>
              Shadow-tagged
            </span>
          )}
          {node.financial_signal && (
            <span className="nx-badge" style={{ background: "var(--nx-accent-green)22", color: "var(--nx-accent-green)" }}>
              Financial
            </span>
          )}
        </div>

        <h3 className="text-sm font-bold leading-snug" style={{ color: "var(--nx-text-primary)" }}>
          {node.hypothesis || "Untitled hypothesis"}
        </h3>

        {node.content && (
          <p className="text-xs leading-relaxed mt-2 whitespace-pre-wrap" style={{ color: "var(--nx-text-secondary)" }}>
            {node.content}
          </p>
        )}

        {node.key_insight && (
          <div
            className="rounded-md px-2.5 py-2 mt-3 text-[11px]"
            style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-accent-indigo)44" }}
          >
            <span className="font-bold uppercase tracking-wide mr-1.5" style={{ color: "var(--nx-accent-indigo)" }}>
              Key Insight
            </span>
            <span style={{ color: "var(--nx-text-secondary)" }}>{node.key_insight}</span>
          </div>
        )}

        {node.wildcard && (
          <div
            className="rounded-md px-2.5 py-2 mt-2 text-[11px]"
            style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-accent-amber)44" }}
          >
            <span className="font-bold uppercase tracking-wide mr-1.5" style={{ color: "var(--nx-accent-amber)" }}>
              Wildcard
            </span>
            <span style={{ color: "var(--nx-text-secondary)" }}>{node.wildcard}</span>
          </div>
        )}
      </div>

      {/* Questions → expand */}
      <div className="nx-card">
        <div className="text-[11px] font-bold tracking-widest uppercase mb-2" style={{ color: "var(--nx-text-muted)" }}>
          Questions
        </div>
        {questions.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--nx-text-muted)" }}>
            No open questions on this node.
          </p>
        ) : (
          <ul className="space-y-2">
            {questions.map((q, i) => {
              const busy = expandingQ === `${node.id}::${q}`;
              return (
                <li
                  key={`${i}-${q.slice(0, 24)}`}
                  className="flex items-start justify-between gap-2 rounded-md px-2.5 py-2"
                  style={{ background: "var(--nx-bg-elevated)" }}
                >
                  <span className="text-[11px] leading-relaxed" style={{ color: "var(--nx-text-secondary)" }}>
                    {q}
                  </span>
                  <button
                    onClick={() => onExpand(node.id, q)}
                    disabled={busy || !!expandingQ}
                    className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded transition-colors disabled:opacity-40"
                    style={{ background: "var(--nx-accent-indigo)", color: "#fff" }}
                  >
                    {busy ? "Expanding…" : "Expand"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Evidence */}
      <EvidencePanel
        status={node.evidence_status}
        evidence={node.evidence}
        onCheck={onCheckEvidence}
        onMark={onMark}
        loading={evidenceLoading}
      />
    </div>
  );
}

function ConnectionsList({ connections }: { connections: ConnectionRow[] }) {
  if (connections.length === 0) {
    return (
      <div className="nx-card text-center text-xs" style={{ color: "var(--nx-text-muted)" }}>
        No connections to other theories yet.
      </div>
    );
  }
  return (
    <div className="nx-card space-y-2">
      {connections.map((c, i) => {
        const rel = String(c.relationship ?? "related");
        const color = REL_COLOR[rel] ?? "var(--nx-text-muted)";
        const strength = typeof c.strength === "number" ? c.strength : null;
        return (
          <div
            key={c.id ?? i}
            className="rounded-md px-3 py-2.5"
            style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)" }}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="nx-badge" style={{ background: `${color}22`, color, border: `1px solid ${color}66` }}>
                {rel}
              </span>
              {strength !== null && (
                <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                  strength {Math.round((strength <= 1 ? strength * 100 : strength))}%
                </span>
              )}
            </div>
            {c.rationale && (
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--nx-text-secondary)" }}>
                {c.rationale}
              </p>
            )}
            <div className="nx-mono text-[9px] mt-1" style={{ color: "var(--nx-text-muted)" }}>
              {c.a_id ? `${c.a_id.slice(0, 8)} → ${(c.b_id ?? "").slice(0, 8)}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
