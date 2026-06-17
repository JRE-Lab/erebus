"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow } from "@erebus/core/client";
import { fetchNodes, fetchContent, makeContent } from "@/lib/api";

// ----------------------------------------------------------------------------
// Content Studio — the profit engine's front door. Corroborated / launch-point
// nodes are solid ground; convert them to short-form scripts and watch the
// queue fill. Resilient to empty / offline data.
// ----------------------------------------------------------------------------

interface ContentLike {
  id?: string;
  nodeId?: string | null;
  script?: string | null;
  title?: string | null;
  platform?: string | null;
  status?: string | null;
  videoUrl?: string | null;
  audioUrl?: string | null;
  createdAt?: string | null;
  publishedAt?: string | null;
}

const LAUNCHABLE = new Set(["corroborated", "resolved_true"]);

export default function StudioPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [content, setContent] = useState<ContentLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [n, c] = await Promise.all([
        fetchNodes().catch(() => []),
        fetchContent().catch(() => []),
      ]);
      setNodes(Array.isArray(n) ? (n as NodeRow[]) : []);
      setContent(Array.isArray(c) ? (c as ContentLike[]) : []);
    } catch {
      setNodes([]);
      setContent([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [load]);

  const launchPoints = useMemo(
    () => nodes.filter((n) => LAUNCHABLE.has(n.state) || n.isLaunchPoint),
    [nodes]
  );

  const generate = async (id: string) => {
    setBusyId(id);
    setNote(null);
    try {
      const r = (await makeContent(id)) as { offline?: boolean } | undefined;
      setNote(r?.offline ? "script generated (offline fallback)." : "script generated.");
      await load();
    } catch {
      setNote("could not generate content.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="nx-scroll h-full">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header>
          <h1 className="text-xl font-bold text-nx-text-primary">Content Studio</h1>
          <p className="mt-1 text-sm text-nx-text-secondary">
            Corroborated theses are solid ground. Convert the green to short-form scripts — the
            content that funds the system.
          </p>
        </header>

        {note && <div className="text-xs text-nx-text-secondary">{note}</div>}

        {/* launch points */}
        <section>
          <div className="mb-2 flex items-center gap-2">
            <span className="nx-dot" style={{ background: "var(--nx-green)" }} />
            <h2 className="text-sm font-semibold text-nx-text-primary">
              Launch points ({launchPoints.length})
            </h2>
          </div>
          {loading && nodes.length === 0 ? (
            <p className="text-sm text-nx-text-muted">Loading…</p>
          ) : launchPoints.length === 0 ? (
            <div className="nx-card p-6 text-center">
              <p className="text-sm text-nx-text-secondary">No corroborated nodes yet.</p>
              <p className="mt-1 text-xs text-nx-text-muted">
                As reality greens the tree, corroborated branches appear here ready to publish.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {launchPoints.map((n) => (
                <div
                  key={n.id}
                  className="nx-card flex flex-col gap-2 border-l-2 border-l-nx-green p-3 nx-green-glow"
                >
                  <div className="flex items-center justify-between">
                    <span className="nx-mono text-[11px] text-nx-text-muted">{n.id}</span>
                    <span className="nx-chip nx-chip-green">{n.state.replace("_", " ")}</span>
                  </div>
                  <p className="line-clamp-2 text-sm font-medium text-nx-text-primary">
                    {n.question}
                  </p>
                  <p className="line-clamp-3 text-xs leading-snug text-nx-text-secondary">
                    {n.outcome}
                  </p>
                  <button
                    className="nx-btn nx-btn-primary mt-auto"
                    disabled={busyId === n.id}
                    onClick={() => generate(n.id)}
                  >
                    {busyId === n.id ? "Generating…" : "Generate content"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* content queue */}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-nx-text-primary">
            Content queue ({content.length})
          </h2>
          {content.length === 0 ? (
            <div className="nx-card p-6 text-center text-xs text-nx-text-muted">
              The queue is empty. Generate a script from a launch point above.
            </div>
          ) : (
            <div className="nx-card overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-nx-border text-nx-text-muted">
                  <tr>
                    <th className="p-3 font-semibold">Node</th>
                    <th className="p-3 font-semibold">Title / Script</th>
                    <th className="p-3 font-semibold">Platform</th>
                    <th className="p-3 font-semibold">Status</th>
                    <th className="p-3 font-semibold">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {content.map((c, i) => (
                    <tr key={c.id ?? i} className="border-b border-nx-border last:border-0">
                      <td className="nx-mono p-3 text-nx-text-muted">{c.nodeId ?? "—"}</td>
                      <td className="p-3 text-nx-text-primary">
                        <span className="line-clamp-2">
                          {c.title ?? c.script ?? "untitled"}
                        </span>
                      </td>
                      <td className="p-3 text-nx-text-secondary">{c.platform ?? "—"}</td>
                      <td className="p-3">
                        <StatusChip status={c.status} />
                      </td>
                      <td className="p-3 text-nx-text-muted">{fmtDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status?: string | null }) {
  const s = status ?? "draft";
  const cls =
    s === "published" ? "nx-chip-green" : s === "failed" ? "nx-chip-red" : "nx-chip-indigo";
  return <span className={`nx-chip ${cls}`}>{s}</span>;
}

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
