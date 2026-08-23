"use client";

import { useEffect, useRef, useState } from "react";
import type { NodeRow, NodeState } from "@erebus/core/client";
import { STATE_COLORS } from "@erebus/core/client";
import {
  fetchNode,
  expandNode,
  debateNode,
  shadowNode,
  synthesize,
  fetchDirections,
  pursueDirection,
  gameRead,
  runACH,
  resolveNode,
  type Direction,
  type GameReadRow,
  type RelationshipRow,
  type Hypothesis,
} from "@/lib/api";

// Angle accent colors for the four tailored directions.
const ANGLE: Record<string, { name: string; color: string }> = {
  consequence: { name: "Consequence", color: "#6366f1" },
  actor: { name: "Actor response", color: "#06b6d4" },
  failure: { name: "Failure mode", color: "#ef4444" },
  wildcard: { name: "Wildcard", color: "#f59e0b" },
};

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
// Row shape of the API's signal_matches join (match metadata + nested signal).
interface SignalMatchRow {
  id?: string;
  effect?: string | null;
  weight?: number | null;
  rationale?: string | null;
  createdAt?: string | null;
  signal?: {
    title?: string | null;
    source?: string | null;
    summary?: string | null;
    url?: string | null;
  } | null;
}

interface NodeDetailData {
  node?: NodeRow;
  // Deep-review fix: the API returns `signal_matches` and `shadow_reads` —
  // the old `signals`/`shadowRead` keys never existed, so matched evidence and
  // shadow reads were permanently invisible in the panel.
  signal_matches?: SignalMatchRow[];
  debates?: DebateRow[];
  shadow_reads?: ShadowRead[];
  events?: EventRow[];
  game_read?: GameReadRow | null;
  relationships?: { from?: RelationshipRow[]; to?: RelationshipRow[] };
}

interface Props {
  nodeId: string | null;
  selectedIds: string[];
  onRefresh: () => void;
  onClearSelection?: () => void;
  /** Called after a direction is pursued into a new child node, with its id. */
  onPursued?: (id: string) => void;
}

type Busy = null | "expand" | "debate" | "shadow" | "synthesize" | "game" | "ach" | "resolve";

export function NodeDetail({ nodeId, selectedIds, onRefresh, onClearSelection, onPursued }: Props) {
  const [data, setData] = useState<NodeDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);

  // --- interactive recursion: suggested directions + pursue ---------------
  const [directions, setDirections] = useState<Direction[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirText, setDirText] = useState("");
  const [pursuing, setPursuing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [pursueNote, setPursueNote] = useState<string | null>(null);

  const loadDirections = async (id: string) => {
    setDirLoading(true);
    try {
      const r = await fetchDirections(id);
      setDirections(r?.directions ?? []);
    } catch {
      setDirections([]);
    } finally {
      setDirLoading(false);
    }
  };

  const pursue = async (text: string) => {
    const trimmed = text.trim();
    if (!nodeId || !trimmed || pursuing) return;
    setPursuing(true);
    setAnalysis(null);
    setPursueNote(null);
    try {
      const r = await pursueDirection(nodeId, trimmed);
      if (r?.blocked) {
        setPursueNote(`Blocked: ${r.blocked}`);
        if (r.analysis) setAnalysis(r.analysis);
        return;
      }
      if (r?.analysis) setAnalysis(r.analysis);
      onRefresh();
      if (r?.node?.id) {
        setDirText("");
        onPursued?.(r.node.id);
      } else {
        setPursueNote("Pursued — no new branch was created.");
      }
    } catch {
      setPursueNote("Pursue failed.");
    } finally {
      setPursuing(false);
    }
  };

  // Stale-response guard: rapid node switches must not render the previous
  // node's slow response over the current selection (deep-review UI finding).
  const activeNodeRef = useRef<string | null>(null);
  activeNodeRef.current = nodeId;

  const load = async () => {
    if (!nodeId) {
      setData(null);
      return;
    }
    const requested = nodeId;
    setLoading(true);
    try {
      const d = (await fetchNode(requested)) as unknown;
      if (activeNodeRef.current !== requested) return; // user moved on — drop it
      // fetchNode may return the bare node or an enriched wrapper.
      const wrapped =
        d && typeof d === "object" && "node" in (d as object)
          ? (d as NodeDetailData)
          : { node: d as NodeRow };
      setData(wrapped);
    } catch {
      if (activeNodeRef.current === requested) setData(null);
    } finally {
      if (activeNodeRef.current === requested) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // reset interactive-recursion state for the newly selected node
    setDirections([]);
    setDirText("");
    setAnalysis(null);
    setPursueNote(null);
    if (nodeId) loadDirections(nodeId);
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
  // Flatten signal_matches into the display shape (signal fields + judgment).
  const signals: MatchedSignal[] = (data?.signal_matches ?? []).map((m) => ({
    id: m.id,
    title: m.signal?.title ?? null,
    source: m.signal?.source ?? null,
    summary: m.signal?.summary ?? null,
    url: m.signal?.url ?? null,
    effect: m.effect ?? null,
    weight: m.weight ?? null,
    rationale: m.rationale ?? null,
    createdAt: m.createdAt ?? null,
  }));
  const debates = data?.debates ?? [];
  const shadow = data?.shadow_reads?.[0] ?? null;
  const events = data?.events ?? [];
  const game = data?.game_read ?? null;
  const rels: Array<RelationshipRow & { dir: "out" | "in" }> = [
    ...(data?.relationships?.from ?? []).map((r) => ({ ...r, dir: "out" as const })),
    ...(data?.relationships?.to ?? []).map((r) => ({ ...r, dir: "in" as const })),
  ];
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
          <button
            className="nx-btn"
            disabled={busy !== null}
            onClick={() => run("game", () => gameRead(nodeId), "Game read")}
            title="Game-theory read: players, equilibrium, stability + the decision"
          >
            {busy === "game" ? "Reading…" : "Game read"}
          </button>
          <button
            className="nx-btn"
            disabled={busy !== null}
            onClick={() => run("ach", () => runACH(nodeId), "ACH")}
            title="Analysis of Competing Hypotheses — rival outcomes + posteriors"
          >
            {busy === "ach" ? "Analyzing…" : "ACH"}
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
                <div className="flex items-center gap-1.5">
                  <OriginBadge origin={node.origin} />
                  <StateBadge state={node.state as NodeState} />
                </div>
              </div>
              <h2 className="text-base font-semibold leading-snug text-nx-text-primary">
                {node.question}
              </h2>
            </div>

            {/* outcome */}
            <Section label="Forecast outcome">
              <p className="text-sm leading-relaxed text-nx-text-primary">{node.outcome}</p>
            </Section>

            {/* DIRECTIONS TO PURSUE — interactive recursion driver */}
            <div className="nx-card-elevated border-l-2 border-l-nx-indigo p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="nx-label text-nx-indigo">Directions to pursue</span>
                <button
                  type="button"
                  className="text-[11px] text-nx-text-muted transition-colors hover:text-nx-indigo disabled:opacity-50"
                  disabled={dirLoading || !nodeId}
                  onClick={() => nodeId && loadDirections(nodeId)}
                  title="Suggest directions"
                >
                  {dirLoading ? (
                    <span className="inline-flex items-center gap-1">
                      <Spinner /> suggesting…
                    </span>
                  ) : (
                    "↻ Suggest directions"
                  )}
                </button>
              </div>

              {/* four tailored directions — click one to pursue it ▸ */}
              {dirLoading && directions.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-nx-text-muted">
                  <Spinner /> tailoring four directions to this branch…
                </div>
              ) : directions.length ? (
                <div className="mb-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {directions.map((d, i) => {
                    const ac = ANGLE[d.angle] ?? ANGLE.consequence!;
                    return (
                      <button
                        key={i}
                        type="button"
                        disabled={pursuing}
                        onClick={() => pursue(d.text)}
                        title="Pursue this direction ▸"
                        className="group rounded-lg border p-2.5 text-left transition-colors hover:bg-[rgba(255,255,255,0.03)] disabled:opacity-50"
                        style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-primary)" }}
                      >
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className="nx-dot" style={{ background: ac.color }} />
                          <span
                            className="text-[10px] font-bold uppercase tracking-wide"
                            style={{ color: ac.color }}
                          >
                            {d.label || ac.name}
                          </span>
                        </div>
                        <p className="text-[12px] leading-snug text-nx-text-secondary group-hover:text-nx-text-primary">
                          {d.text}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mb-3 text-xs italic text-nx-text-muted">
                  no directions yet — write your own below
                </p>
              )}

              {/* operator's own direction / response */}
              <div className="nx-label mb-1.5">Your direction or response</div>
              <textarea
                className="nx-input min-h-[68px] resize-y text-sm"
                placeholder="Pick a direction above, or write your own reasoning — EREBUS will game-theory it into the next branch."
                value={dirText}
                disabled={pursuing}
                onChange={(e) => setDirText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") pursue(dirText);
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                {pursueNote ? (
                  <span className="text-[11px] text-nx-text-secondary">{pursueNote}</span>
                ) : (
                  <span className="text-[11px] text-nx-text-muted">⌘/Ctrl + Enter to pursue</span>
                )}
                <button
                  type="button"
                  className="nx-btn nx-btn-primary"
                  disabled={pursuing || !dirText.trim()}
                  onClick={() => pursue(dirText)}
                >
                  {pursuing ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner /> Pursuing…
                    </span>
                  ) : (
                    "Pursue ▸"
                  )}
                </button>
              </div>

              {/* game-theoretic analysis of the pursued direction */}
              {analysis && (
                <div className="mt-3 rounded-lg border border-nx-indigo/40 bg-[rgba(99,102,241,0.06)] p-3">
                  <div className="nx-label mb-1 text-nx-indigo">Game-theoretic analysis</div>
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-nx-text-secondary">
                    {analysis}
                  </p>
                </div>
              )}
            </div>

            {/* confirmation / probability gradient */}
            <Section label="P(outcome) — the Bayesian green level">
              <GradientBar
                value={node.confirmation ?? 0}
                color={STATE_COLORS[node.state as NodeState] ?? STATE_COLORS.speculative}
              />
              <div className="mt-2 flex items-center justify-between text-[11px] text-nx-text-muted">
                <span>
                  P(outcome){" "}
                  <span className="nx-mono text-nx-text-secondary">
                    {(((node as { probability?: number }).probability ?? (node.confirmation + 1) / 2) * 100).toFixed(0)}%
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

            {/* ACH — rival hypotheses + posteriors */}
            <AchPanel hypotheses={(node as { hypotheses?: unknown }).hypotheses} outcome={node.outcome} />

            {/* resolution — external truth + Brier */}
            <ResolutionPanel
              node={node}
              busy={busy}
              onResolve={(happened) => run("resolve", () => resolveNode(nodeId, happened), "Resolve")}
            />

            {/* GAME READ — strategic depth: players, equilibrium, stability, decision */}
            <GameReadPanel game={game} />

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

            {/* strategic relationship graph */}
            <Section label={`Strategic links (${rels.length})`}>
              {rels.length ? (
                <ul className="space-y-1.5">
                  {rels.map((r, i) => (
                    <li key={r.id ?? i} className="nx-card-elevated p-2.5">
                      <div className="flex items-center gap-2 text-[11px]">
                        <RelTag type={r.type} />
                        <span className="nx-mono text-nx-text-muted">
                          {r.dir === "out" ? `→ ${r.toNode ?? "?"}` : `← ${r.fromNode ?? "?"}`}
                        </span>
                      </div>
                      {r.rationale && (
                        <p className="mt-1 text-[11px] leading-snug text-nx-text-secondary">{r.rationale}</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>no strategic links yet — a shadow read or game read can draw them</Empty>
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

function RelTag({ type }: { type?: string | null }) {
  const t = type ?? "link";
  const red = ["contradicts", "tension", "deters"].includes(t);
  const cls = red ? "nx-chip-red" : t === "supports" || t === "validates" ? "nx-chip-green" : "nx-chip-indigo";
  return <span className={`nx-chip ${cls}`}>{t.replace(/_/g, " ")}</span>;
}

function AchPanel({ hypotheses, outcome }: { hypotheses?: unknown; outcome?: string }) {
  const hyps = Array.isArray(hypotheses) ? (hypotheses as Hypothesis[]) : [];
  if (!hyps.length) {
    return (
      <Section label="Competing hypotheses (ACH)">
        <Empty>no ACH yet — run one to track the rival outcomes reality is choosing between</Empty>
      </Section>
    );
  }
  const sorted = [...hyps].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  const leader = sorted[0];
  // best-effort: is the stated outcome the leader?
  const leaderIsOutcome = !!(outcome && leader && outcome.toLowerCase().includes((leader.label ?? "").toLowerCase().slice(0, 12)));
  return (
    <Section label="Competing hypotheses (ACH)">
      <div className="space-y-1.5">
        {sorted.map((h, i) => {
          const pct = Math.round(Math.max(0, Math.min(1, h.probability ?? 0)) * 100);
          const lead = i === 0;
          return (
            <div key={i}>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px]">
                <span className={lead ? "font-semibold text-nx-text-primary" : "text-nx-text-secondary"}>
                  {lead ? "▸ " : ""}
                  {h.label}
                </span>
                <span className="nx-mono text-nx-text-muted">{pct}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-nx-bg-primary">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: lead ? "var(--nx-indigo)" : "var(--nx-border-strong)" }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {!leaderIsOutcome && leader && (
        <p className="mt-2 text-[11px]" style={{ color: "#a855f7" }}>
          ⚡ reality may be selecting a different equilibrium than the stated outcome
        </p>
      )}
    </Section>
  );
}

function ResolutionPanel({
  node,
  busy,
  onResolve,
}: {
  node: NodeRow;
  busy: Busy;
  onResolve: (happened: boolean) => void;
}) {
  const resolved = (node as { resolved?: boolean | null }).resolved;
  const outcome = (node as { resolvedOutcome?: boolean | null }).resolvedOutcome;
  const brier = (node as { brier?: number | null }).brier;
  const source = (node as { resolvedSource?: string | null }).resolvedSource;
  const horizonPassed = node.horizon ? new Date(node.horizon).getTime() < Date.now() : false;
  if (resolved) {
    return (
      <Section label="Resolution">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span
            className="nx-chip"
            style={{
              color: outcome ? "var(--nx-green)" : "var(--nx-red)",
              borderColor: outcome ? "var(--nx-green)" : "var(--nx-red)",
            }}
          >
            {outcome ? "happened ✓" : "did not happen ✕"}
          </span>
          {typeof brier === "number" && (
            <span className="text-nx-text-muted">
              Brier <span className="nx-mono text-nx-text-secondary">{brier.toFixed(3)}</span>{" "}
              {brier < 0.25 ? "(beat a coin flip)" : "(worse than 50/50)"}
            </span>
          )}
          {source && <span className="nx-badge">{source}</span>}
        </div>
      </Section>
    );
  }
  return (
    <Section label="Resolution">
      <p className="mb-2 text-[11px] text-nx-text-muted">
        {horizonPassed ? "Horizon passed — did reality bear this out?" : "Adjudicate against external truth when known."}
      </p>
      <div className="flex gap-2">
        <button
          className="nx-btn"
          style={{ borderColor: "var(--nx-green)", color: "var(--nx-green)" }}
          disabled={busy !== null}
          onClick={() => onResolve(true)}
        >
          {busy === "resolve" ? "…" : "It happened"}
        </button>
        <button
          className="nx-btn"
          style={{ borderColor: "var(--nx-red)", color: "var(--nx-red)" }}
          disabled={busy !== null}
          onClick={() => onResolve(false)}
        >
          {busy === "resolve" ? "…" : "It didn't"}
        </button>
      </div>
    </Section>
  );
}

function GameReadPanel({ game }: { game?: GameReadRow | null }) {
  if (!game) {
    return (
      <Section label="Game read — the strategic equilibrium">
        <Empty>no game read yet — run one to model players, payoffs, the equilibrium & its stability</Empty>
      </Section>
    );
  }
  const stability = typeof game.stability === "number" ? game.stability : 0.5;
  const fragile = stability < 0.35;
  const stColor = stability >= 0.66 ? "var(--nx-green)" : fragile ? "#a855f7" : "var(--nx-amber)";
  const players = Array.isArray(game.players) ? game.players : [];
  const moves = Array.isArray(game.leverageMoves) ? game.leverageMoves : [];
  return (
    <Section label="Game read — the strategic equilibrium">
      <div className="nx-card-elevated space-y-3 border-l-2 p-3" style={{ borderLeftColor: stColor }}>
        {/* equilibrium headline */}
        <div className="flex flex-wrap items-center gap-2">
          {game.equilibriumType && (
            <span className="nx-chip nx-chip-indigo">{game.equilibriumType.replace(/_/g, " ")}</span>
          )}
          {game.gameType && <span className="nx-badge">{game.gameType.replace(/_/g, " ")}</span>}
          <span
            className="nx-chip"
            style={{
              color: game.outcomeIsEquilibrium ? "var(--nx-green)" : "var(--nx-red)",
              borderColor: game.outcomeIsEquilibrium ? "var(--nx-green)" : "var(--nx-red)",
            }}
          >
            {game.outcomeIsEquilibrium ? "outcome IS the equilibrium" : "outcome is NOT the equilibrium"}
          </span>
        </div>
        {game.predictedEquilibrium && (
          <p className="text-[12px] leading-snug text-nx-text-secondary">{game.predictedEquilibrium}</p>
        )}

        {/* stability axis */}
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="nx-label">Equilibrium stability</span>
            <span className="nx-mono" style={{ color: stColor }}>
              {stability.toFixed(2)} {fragile ? "· FRAGILE ⚡" : stability >= 0.66 ? "· robust" : "· contested"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-nx-bg-primary">
            <div className="h-full rounded-full" style={{ width: `${stability * 100}%`, background: stColor }} />
          </div>
          {game.fragilityDrivers?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {game.fragilityDrivers.map((f, i) => (
                <span key={i} className="nx-chip" style={{ color: "#a855f7", borderColor: "#a855f7" }}>
                  {f}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* players */}
        {players.length ? (
          <div>
            <div className="nx-label mb-1">Players</div>
            <ul className="space-y-1.5">
              {players.map((p, i) => (
                <li key={i} className="rounded-md border border-nx-border p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-nx-text-primary">{p.name}</span>
                    {p.type && <span className="nx-badge">{p.type}</span>}
                    {p.patience && <span className="nx-mono text-[10px] text-nx-text-muted">patience {p.patience}</span>}
                  </div>
                  {p.dominantStrategy && (
                    <p className="text-[11px] leading-snug text-nx-text-secondary">▸ {p.dominantStrategy}</p>
                  )}
                  {p.batna && <p className="text-[10px] text-nx-text-muted">BATNA: {p.batna}</p>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* decision layer */}
        {(game.focalPoint || moves.length || game.noRegretAction || game.reversalTripwire) && (
          <div className="rounded-lg border border-nx-indigo/40 bg-[rgba(99,102,241,0.06)] p-2.5">
            <div className="nx-label mb-1 text-nx-indigo">Decision</div>
            <Field k="Focal point" v={game.focalPoint} />
            {moves.length ? (
              <div className="mt-1">
                <span className="nx-label">Leverage moves</span>
                <ul className="mt-1 space-y-1">
                  {moves.map((m, i) => (
                    <li key={i} className="text-[11px] leading-snug text-nx-text-secondary">
                      <span className="font-semibold text-nx-text-primary">{m.actor}</span>: {m.move}
                      {m.mechanism && <span className="nx-mono text-[10px] text-nx-text-muted"> [{m.mechanism}]</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {game.noRegretAction && (
              <div className="mt-1.5 rounded-md p-2" style={{ background: "rgba(34,197,94,0.08)" }}>
                <span className="nx-label" style={{ color: "var(--nx-green)" }}>No-regret action</span>
                <p className="text-[12px] leading-snug text-nx-text-primary">{game.noRegretAction}</p>
              </div>
            )}
            {game.reversalTripwire && (
              <div className="mt-1.5 rounded-md p-2" style={{ background: "rgba(239,68,68,0.08)" }}>
                <span className="nx-label" style={{ color: "var(--nx-red)" }}>Reversal tripwire</span>
                <p className="text-[12px] leading-snug text-nx-text-primary">{game.reversalTripwire}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function OriginBadge({ origin }: { origin?: NodeRow["origin"] }) {
  const erebus = origin === "erebus";
  const shadow = origin === "shadow";
  const color = shadow ? "#a855f7" : erebus ? "var(--nx-amber)" : "var(--nx-indigo)";
  const bg = shadow ? "#a855f7" : erebus ? "#f59e0b" : "#6366f1";
  return (
    <span
      className="nx-badge"
      style={{ color, borderColor: color, background: `${bg}1a` }}
      title={
        shadow
          ? "Autonomously created — the shadow layer (dark theory)"
          : erebus
            ? "Autonomously created by EREBUS"
            : "Created by you"
      }
    >
      <span className="nx-dot" style={{ background: color }} />
      {shadow ? "⚡ dark" : erebus ? "EREBUS" : "you"}
    </span>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px]"
      style={{
        borderColor: "var(--nx-border-strong)",
        borderTopColor: "var(--nx-indigo)",
      }}
      aria-hidden
    />
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
