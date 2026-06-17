"use client";

import { useEffect, useState } from "react";
import type { NodeRow, NodeState } from "@erebus/core/client";
import { STATE_COLORS } from "@erebus/core/client";
import {
  fetchNode,
  expandNode,
  debateNode,
  shadowNode,
  synthesize,
} from "@/lib/api";

// ----------------------------------------------------------------------------
// Defensive shapes for the enriched fetchNode() payload. The api layer owns the
// real types; we read loosely so missing relations never crash the panel.
// ----------------------------------------------------------------------------
interface MatchedSignal {
  id?: string;
  title?: string | null;
  source?: string | null;
  summary?: string | null;
  effect?: string | null;
  weight?: number | null;
  rationale?: string | null;
  createdAt?: string | null;
  url?: string | null;
}
interface DebateRow {
  id?: string;
  round?: number | null;
  verdict?: string | null;
  synthesis?: string | null;
  confidenceDelta?: number | null;
  createdAt?: string | null;
}
interface ShadowRead {
  revealedPreference?: string | null;
  cuiBono?: string | null;
  counterNarrative?: string | null;
  deceptionIndicators?: string[] | null;
  misdirection?: string | null;
  createdAt?: string | null;
}
interface EventRow {
  id?: string;
  kind?: string | null;
  causeType?: string | null;
  before?: unknown;
  after?: unknown;
  createdAt?: string | null;
}
interface NodeDetailData {
  node?: NodeRow;
  signals?: MatchedSignal[];
  matches?: MatchedSignal[];
  debates?: DebateRow[];
  shadowRead?: ShadowRead | null;
  shadowReads?: ShadowRead[];
  events?: EventRow[];
  provenance?: EventRow[];
}

interface Props {
  nodeId: string | null;
  selectedIds: string[];
  onRefresh: () => void;
  onClearSelection?: () => void;
}

type Busy = null | "expand" | "debate" | "shadow" | "synthesize";

export function NodeDetail({ nodeId, selectedIds, onRefresh, onClearSelection }: Props) {
  const [data, setData] = useState<NodeDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    if (!nodeId) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const d = (await fetchNode(nodeId)) as unknown;
      // fetchNode may return the bare node or an enriched wrapper.
      const wrapped =
        d && typeof d === "object" && "node" in (d as object)
          ? (d as NodeDetailData)
          : { node: d as NodeRow };
      setData(wrapped);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const run = async (which: Busy, fn: () => Promise<unknown>, label: string) => {
    setBusy(which);
    setNote(null);
    try {
      const r = (await fn()) as { blocked?: string; offline?: boolean } | undefined;
      if (r?.blocked) setNote(`${label} blocked: ${r.blocked}`);
      else if (r?.offline) setNote(`${label} ran offline (fallback).`);
      else setNote(`${label} complete.`);
      await load();
      onRefresh();
    } catch {
      setNote(`${label} failed.`);
    } finally {
      setBusy(null);
    }
  };

  if (!nodeId) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-xs">
          <div className="mb-2 text-2xl opacity-30">◇</div>
          <p className="text-sm text-nx-text-secondary">Select a node</p>
          <p className="mt-1 text-xs text-nx-text-muted">
            Click any branch in the tree to read its forecast, its provenance, and act on it.
          </p>
        </div>
      </div>
    );
  }

  const node = data?.node;
  const signals = data?.signals ?? data?.matches ?? [];
  const debates = data?.debates ?? [];
  const shadow = data?.shadowRead ?? data?.shadowReads?.[0] ?? null;
  const events = data?.events ?? data?.provenance ?? [];
  const multi = selectedIds.length >= 2;

  return (
    <div className="flex h-full flex-col">
      {/* header / actions */}
      <div className="shrink-0 border-b border-nx-border p-4">
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            className="nx-btn"
            disabled={busy !== null}
            onClick={() => run("expand", () => expandNode(nodeId), "Expand")}
          >
            {busy === "expand" ? "Expanding…" : "Expand"}
          </button>
          <button
            className="nx-btn"
            disabled={busy !== null}
            onClick={() => run("debate", () => debateNode(nodeId), "Debate")}
          >
            {busy === "debate" ? "Debating…" : "Debate"}
          </button>
          <button
            className="nx-btn"
            disabled={busy !== null}
            onClick={() => run("shadow", () => shadowNode(nodeId), "Shadow read")}
          >
            {busy === "shadow" ? "Reading…" : "Shadow"}
          </button>
          {multi && (
            <button
              className="nx-btn nx-btn-primary"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "synthesize",
                  async () => {
                    const r = await synthesize(selectedIds);
                    onClearSelection?.();
                    return r;
                  },
                  "Synthesize"
                )
              }
            >
              {busy === "synthesize" ? "Synthesizing…" : `Synthesize (${selectedIds.length})`}
            </button>
          )}
        </div>
        {note && <div className="text-xs text-nx-text-secondary">{note}</div>}
      </div>

      <div className="nx-scroll min-h-0 flex-1 space-y-5 p-4">
        {loading && !node ? (
          <div className="text-sm text-nx-text-muted">Loading node…</div>
        ) : !node ? (
          <div className="text-sm text-nx-text-muted">
            Node detail unavailable (offline or not found).
          </div>
        ) : (
          <>
            {/* identity + state */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="nx-mono text-xs text-nx-text-muted">{node.id}</span>
                <StateBadge state={node.state as NodeState} />
              </div>
              <h2 className="text-base font-semibold leading-snug text-nx-text-primary">
                {node.question}
              </h2>
            </div>

            {/* outcome */}
            <Section label="Forecast outcome">
              <p className="text-sm leading-relaxed text-nx-text-primary">{node.outcome}</p>
            </Section>

            {/* confirmation / confidence gradient */}
            <Section label="Confirmation — the green level">
              <GradientBar
                value={node.confirmation ?? 0}
                color={STATE_COLORS[node.state as NodeState] ?? STATE_COLORS.speculative}
              />
              <div className="mt-2 flex items-center justify-between text-[11px] text-nx-text-muted">
                <span>
                  confirmation{" "}
                  <span className="nx-mono text-nx-text-secondary">
                    {(node.confirmation ?? 0).toFixed(2)}
                  </span>
                </span>
                <span>
                  confidence{" "}
                  <span className="nx-mono text-nx-text-secondary">
                    {(node.confidence ?? 0).toFixed(2)}
                  </span>
                </span>
                {node.isLaunchPoint && <span className="nx-chip nx-chip-green">launch point</span>}
              </div>
            </Section>

            {node.rationale && (
              <Section label="Rationale">
                <p className="text-sm leading-relaxed text-nx-text-secondary">{node.rationale}</p>
              </Section>
            )}

            {/* indicators / falsifiers */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Section label="Indicators (confirm)">
                {node.indicators?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {node.indicators.map((ind, i) => (
                      <span key={i} className="nx-chip nx-chip-green">
                        {ind}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Empty>no indicators yet</Empty>
                )}
              </Section>
              <Section label="Falsifiers (refute)">
                {node.falsifiers?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {node.falsifiers.map((f, i) => (
                      <span key={i} className="nx-chip nx-chip-red">
                        {f}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Empty>no falsifiers yet</Empty>
                )}
              </Section>
            </div>

            {/* meta */}
            <div className="flex flex-wrap gap-2">
              {node.horizon && (
                <span className="nx-badge">horizon · {fmtDate(node.horizon)}</span>
              )}
              {(node.domains ?? []).map((d) => (
                <span key={d} className="nx-badge">
                  {d}
                </span>
              ))}
              {node.synthesizedFrom?.length ? (
                <span className="nx-badge nx-mono">synth ← {node.synthesizedFrom.join(", ")}</span>
              ) : null}
            </div>

            {/* matched signals */}
            <Section label={`Matched signals (${signals.length})`}>
              {signals.length ? (
                <ul className="space-y-2">
                  {signals.map((s, i) => (
                    <li key={s.id ?? i} className="nx-card-elevated p-2.5">
                      <div className="mb-0.5 flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-xs font-medium text-nx-text-primary">
                          {s.title ?? s.summary ?? "signal"}
                        </span>
                        <EffectTag effect={s.effect} />
                      </div>
                      {s.rationale && (
                        <p className="text-[11px] leading-snug text-nx-text-muted">{s.rationale}</p>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-nx-text-muted">
                        {s.source && <span>{s.source}</span>}
                        {s.weight != null && <span className="nx-mono">w {s.weight.toFixed(2)}</span>}
                        {s.createdAt && <span>{fmtAgo(s.createdAt)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>no reality has matched this branch yet</Empty>
              )}
            </Section>

            {/* shadow read */}
            <Section label="Shadow read">
              {shadow ? (
                <div className="nx-card-elevated space-y-2 border-l-2 border-l-nx-red p-3">
                  <Field k="Revealed preference" v={shadow.revealedPreference} />
                  <Field k="Cui bono" v={shadow.cuiBono} />
                  <Field k="Counter-narrative" v={shadow.counterNarrative} />
                  <Field k="Misdirection" v={shadow.misdirection} />
                  {shadow.deceptionIndicators?.length ? (
                    <div>
                      <div className="nx-label mb-1">Deception indicators</div>
                      <div className="flex flex-wrap gap-1.5">
                        {shadow.deceptionIndicators.map((d, i) => (
                          <span key={i} className="nx-chip nx-chip-red">
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Empty>no shadow read — run one to model deception</Empty>
              )}
            </Section>

            {/* debates */}
            <Section label={`Debates (${debates.length})`}>
              {debates.length ? (
                <ul className="space-y-2">
                  {debates.map((d, i) => (
                    <li key={d.id ?? i} className="nx-card-elevated p-2.5">
                      <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                        <span className="nx-badge">round {d.round ?? i + 1}</span>
                        {d.verdict && <span className="nx-chip nx-chip-indigo">{d.verdict}</span>}
                        {d.confidenceDelta != null && (
                          <span className="nx-mono text-nx-text-muted">
                            Δconf {d.confidenceDelta > 0 ? "+" : ""}
                            {d.confidenceDelta.toFixed(2)}
                          </span>
                        )}
                      </div>
                      {d.synthesis && (
                        <p className="text-[11px] leading-snug text-nx-text-secondary">
                          {d.synthesis}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>no debate yet — sharpen this forecast</Empty>
              )}
            </Section>

            {/* provenance chain */}
            <Section label={`Provenance — why this branch is where it is (${events.length})`}>
              {events.length ? (
                <ol className="relative space-y-2 border-l border-nx-border pl-4">
                  {events.map((e, i) => (
                    <li key={e.id ?? i} className="relative">
                      <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-nx-indigo" />
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-semibold text-nx-text-primary">{e.kind ?? "event"}</span>
                        {e.causeType && (
                          <span className="nx-mono text-nx-text-muted">{e.causeType}</span>
                        )}
                        {e.createdAt && (
                          <span className="text-nx-text-muted">{fmtAgo(e.createdAt)}</span>
                        )}
                      </div>
                      {(e.before != null || e.after != null) && (
                        <div className="nx-mono text-[10px] text-nx-text-muted">
                          {summarizeDelta(e.before, e.after)}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <Empty>no provenance events recorded</Empty>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// --- subcomponents ----------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="nx-label mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-nx-text-muted">{children}</p>;
}

function Field({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null;
  return (
    <div>
      <span className="nx-label">{k}</span>
      <p className="text-[12px] leading-snug text-nx-text-secondary">{v}</p>
    </div>
  );
}

function StateBadge({ state }: { state: NodeState }) {
  const color = STATE_COLORS[state] ?? STATE_COLORS.speculative;
  return (
    <span
      className="nx-badge"
      style={{ color, borderColor: color, background: `${color}1a` }}
    >
      <span className="nx-dot" style={{ background: color }} />
      {state.replace("_", " ")}
    </span>
  );
}

function EffectTag({ effect }: { effect?: string | null }) {
  if (!effect) return null;
  const cls =
    effect === "confirm" ? "nx-chip-green" : effect === "refute" ? "nx-chip-red" : "nx-chip-indigo";
  return <span className={`nx-chip ${cls}`}>{effect}</span>;
}

function GradientBar({ value, color }: { value: number; color: string }) {
  const v = Math.max(-1, Math.min(1, value));
  // map [-1,1] -> [0,100], 50% is neutral
  const pct = ((v + 1) / 2) * 100;
  const refuting = v < 0;
  return (
    <div className="relative h-3 w-full overflow-hidden rounded-full bg-nx-bg-primary">
      <div
        className="absolute top-0 h-full"
        style={
          refuting
            ? { right: "50%", width: `${50 - pct}%`, background: STATE_COLORS.contradicted }
            : { left: "50%", width: `${pct - 50}%`, background: color }
        }
      />
      {/* neutral midline */}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-nx-border-strong" />
    </div>
  );
}

// --- formatting -------------------------------------------------------------

function fmtDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtAgo(d: string): string {
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  const sec = (Date.now() - date.getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function summarizeDelta(before: unknown, after: unknown): string {
  const fmt = (o: unknown) => {
    if (o == null) return "";
    if (typeof o === "object") {
      return Object.entries(o as Record<string, unknown>)
        .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : String(v)}`)
        .join(" ");
    }
    return String(o);
  };
  const b = fmt(before);
  const a = fmt(after);
  if (b && a) return `${b} → ${a}`;
  return a || b;
}

export default NodeDetail;
