"use client";

import { useCallback, useEffect, useState } from "react";

// ----------------------------------------------------------------------------
// LOOM narratives (Phases 1-4, read-only) — the story stream clustered into
// narratives with lifecycle, framing, coordination, ACH intent (R2: the
// Intended-Reaction section renders ONLY from a judgment row, which the
// server guarantees carries a runner-up and falsifiers), market exposure,
// event studies, pre-positioning flags, and pre-registered forecasts.
// ----------------------------------------------------------------------------

interface NarrativeCard {
  id: string;
  label: string | null;
  summary: string | null;
  seedTitle: string | null;
  state: string;
  articleCount: number;
  outletCount: number;
  langCount: number;
  vel24: number;
  seededAt: string | null;
  lastSeenAt: string | null;
}

interface HeadScore {
  claimType: string;
  n: number;
  meanBrier: number;
  baseRate: number;
  climatologyBrier: number;
  status: "live" | "advisory";
}

interface LoomStatusShape {
  articlesTotal: number;
  articles24h: number;
  articlesEmbedded: number;
  articlesAssigned: number;
  narrativesPromoted: number;
  narrativesCandidates: number;
  narrativesUnlabeled: number;
}

interface Detail extends NarrativeCard {
  articles: Array<{ id: string; title: string | null; url: string; outlet: string | null; firstSeenAt: string | null }>;
  transitions: Array<{ fromState: string; toState: string; at: string }>;
  frame: Record<string, string> | null;
  coordination: { score: number; ciLow: number; ciHigh: number; wireSharePct: number; firstMover: string | null } | null;
  entities: Array<{ name: string; kind: string; ticker: string | null; salience: number }>;
  eventStudies: Array<{ symbol: string; carPre: number | null; carEvent: number | null; carPost: number | null }>;
  judgment: {
    topLabel: string; topBand: string; runnerLabel: string; runnerBand: string;
    confidence: string; falsifiers: string[];
  } | null;
  beneficiaries: Array<{ name: string; rationale: string | null; falsifier: string; rank: number }>;
  flags: Array<{ symbol: string; composite: number; placeboPctl: number }>;
  forecasts: Array<{
    id: string; claimType: string; direction: string | null; magnitudeBand: string | null;
    prob: number; windowEnd: string; outcome: boolean | null; brier: number | null;
  }>;
}

const STATE_META: Record<string, { color: string; hint: string }> = {
  seeding: { color: "#6b7280", hint: "promoted, low velocity" },
  amplifying: { color: "#f59e0b", hint: "velocity climbing" },
  peak: { color: "#ef4444", hint: "crested — maximum attention" },
  decaying: { color: "#3b82f6", hint: "attention fading" },
  dormant: { color: "#4b5563", hint: "gone quiet (can reignite)" },
};
const STATES = ["seeding", "amplifying", "peak", "decaying", "dormant"] as const;

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const pct = (v: number | null) => (v == null ? "…" : `${(100 * v).toFixed(1)}%`);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--nx-text-muted)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export default function NarrativesPage() {
  const [cards, setCards] = useState<NarrativeCard[]>([]);
  const [status, setStatus] = useState<LoomStatusShape | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [scores, setScores] = useState<HeadScore[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const q = filter ? `?state=${filter}` : "";
      const [n, s, sb] = await Promise.all([
        fetch(`/api/loom/narratives${q}`).then((r) => r.json()),
        fetch("/api/loom/status").then((r) => r.json()),
        fetch("/api/loom/scoreboard").then((r) => r.json()),
      ]);
      setCards(Array.isArray(n) ? n : []);
      if (s && typeof s === "object") setStatus(s as LoomStatusShape);
      setScores(Array.isArray(sb) ? (sb as HeadScore[]) : []);
    } catch {
      /* keep last good render */
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const d = await fetch(`/api/loom/narratives/${id}`).then((r) => r.json());
      if (d && !d.error) setOpen(d as Detail);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* list */}
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <div className="mb-1 flex items-baseline gap-3">
          <h1 className="text-lg font-bold" style={{ color: "var(--nx-text-primary)" }}>
            ∿ Narratives
          </h1>
          <span className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
            the story stream, clustered — how narratives move, who benefits, what reacts
          </span>
        </div>
        {status && (
          <div className="mb-4 text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
            {status.articlesTotal} articles ({status.articles24h} / 24h) · {status.articlesAssigned} clustered ·{" "}
            {status.narrativesPromoted} narratives · {status.narrativesCandidates} candidates
            {status.narrativesUnlabeled > 0 ? ` · ${status.narrativesUnlabeled} awaiting label` : ""}
          </div>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setFilter(null)}
            className="rounded-full border px-3 py-1 text-[11px] font-semibold"
            style={{
              borderColor: filter === null ? "var(--nx-indigo)" : "var(--nx-border)",
              color: filter === null ? "var(--nx-text-primary)" : "var(--nx-text-muted)",
            }}
          >
            all
          </button>
          {STATES.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(filter === s ? null : s)}
              title={STATE_META[s]?.hint}
              className="rounded-full border px-3 py-1 text-[11px] font-semibold"
              style={{
                borderColor: filter === s ? STATE_META[s]!.color : "var(--nx-border)",
                color: filter === s ? STATE_META[s]!.color : "var(--nx-text-muted)",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-sm" style={{ color: "var(--nx-text-muted)" }}>
            loading…
          </div>
        ) : cards.length === 0 ? (
          <div className="text-sm" style={{ color: "var(--nx-text-muted)" }}>
            No promoted narratives yet. Clusters promote once a story reaches enough articles across enough
            distinct outlets — the hourly loom-cluster tick is building them from the article stream.
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(340px,1fr))" }}>
            {cards.map((n) => {
              const meta = STATE_META[n.state] ?? STATE_META.seeding!;
              return (
                <button
                  key={n.id}
                  onClick={() => openDetail(n.id)}
                  className="rounded-xl border p-4 text-left transition hover:brightness-110"
                  style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-card)" }}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}55` }}
                    >
                      {n.state}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
                      {n.vel24}/24h · {n.articleCount} articles · {n.outletCount} outlets
                    </span>
                  </div>
                  <div className="mb-1 text-sm font-semibold leading-snug" style={{ color: "var(--nx-text-primary)" }}>
                    {n.label || n.seedTitle || "(unlabeled narrative)"}
                  </div>
                  {n.summary && (
                    <div className="mb-2 text-xs leading-relaxed" style={{ color: "var(--nx-text-muted)" }}>
                      {n.summary}
                    </div>
                  )}
                  <div className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                    seeded {ago(n.seededAt)} · last seen {ago(n.lastSeenAt)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* the card (spec M12) */}
      {open && (
        <div
          className="w-[460px] shrink-0 overflow-y-auto border-l p-5"
          style={{ borderColor: "var(--nx-border)", background: "var(--nx-bg-card)" }}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="text-sm font-bold leading-snug" style={{ color: "var(--nx-text-primary)" }}>
              {open.label || open.seedTitle || "(unlabeled narrative)"}
            </div>
            <button onClick={() => setOpen(null)} className="text-xs" style={{ color: "var(--nx-text-muted)" }}>
              ✕
            </button>
          </div>
          {open.summary && (
            <p className="mb-4 text-xs leading-relaxed" style={{ color: "var(--nx-text-muted)" }}>
              {open.summary}
            </p>
          )}

          {/* The Push — dominant frame chips */}
          {open.frame && Object.keys(open.frame).length > 0 && (
            <Section title="the push — dominant frame">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(open.frame).map(([slot, val]) => (
                  <span
                    key={slot}
                    className="rounded-full border px-2 py-0.5 text-[10px]"
                    style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-primary)" }}
                    title={slot}
                  >
                    <span style={{ color: "var(--nx-text-muted)" }}>{slot}:</span> {val}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Origin trace */}
          {open.coordination && (
            <Section title="origin trace">
              <div className="text-[11px] leading-relaxed" style={{ color: "var(--nx-text-primary)" }}>
                coordination <b>{open.coordination.score.toFixed(0)}</b>/100{" "}
                <span style={{ color: "var(--nx-text-muted)" }}>
                  (CI {open.coordination.ciLow.toFixed(0)}–{open.coordination.ciHigh.toFixed(0)})
                </span>
                {" · "}wire copy {open.coordination.wireSharePct.toFixed(0)}%
                {open.coordination.firstMover && (
                  <>
                    {" · "}first mover <b>{open.coordination.firstMover}</b>
                  </>
                )}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                syndication is labeled, not inferred: high wire share explains coordination organically (R5)
              </div>
            </Section>
          )}

          {/* Intended reaction — ACH judgment (renders only if R2-complete) */}
          {open.judgment && (
            <Section title="intended reaction & why (estimate, not finding)">
              <div className="rounded-lg border p-2" style={{ borderColor: "var(--nx-border)" }}>
                <div className="text-[11px]" style={{ color: "var(--nx-text-primary)" }}>
                  <b>{open.judgment.topLabel}</b> — {open.judgment.topBand}
                  <span style={{ color: "var(--nx-text-muted)" }}> · confidence {open.judgment.confidence}</span>
                </div>
                <div className="mt-1 text-[11px]" style={{ color: "var(--nx-text-primary)" }}>
                  runner-up: <b>{open.judgment.runnerLabel}</b> — {open.judgment.runnerBand}
                </div>
                <div className="mt-1.5 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                  falsifiers (watching):
                </div>
                {open.judgment.falsifiers.map((f, i) => (
                  <div key={i} className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                    ▸ {f}
                  </div>
                ))}
              </div>
              {open.beneficiaries.length > 0 && (
                <div className="mt-2">
                  {open.beneficiaries.map((b) => (
                    <div key={b.rank} className="mb-1 text-[11px]" style={{ color: "var(--nx-text-primary)" }}>
                      {b.rank}. <b>{b.name}</b>
                      {b.rationale && <span style={{ color: "var(--nx-text-muted)" }}> — {b.rationale}</span>}
                      <div className="text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                        clears if: {b.falsifier}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Exposure + event studies */}
          {open.entities.length > 0 && (
            <Section title="market exposure">
              <div className="flex flex-wrap gap-1.5">
                {open.entities.map((e, i) => (
                  <span
                    key={i}
                    className="rounded-full border px-2 py-0.5 text-[10px]"
                    style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-primary)" }}
                  >
                    {e.name}
                    {e.ticker && <b> ${e.ticker}</b>}
                  </span>
                ))}
              </div>
              {open.eventStudies.length > 0 && (
                <table className="mt-2 w-full text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                  <thead>
                    <tr className="text-left">
                      <th>instr</th><th>CAR pre</th><th>event</th><th>drift</th>
                    </tr>
                  </thead>
                  <tbody style={{ color: "var(--nx-text-primary)" }}>
                    {open.eventStudies.map((s, i) => (
                      <tr key={i}>
                        <td>{s.symbol}</td>
                        <td>{pct(s.carPre)}</td>
                        <td>{pct(s.carEvent)}</td>
                        <td>{pct(s.carPost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          )}

          {/* Pre-positioning flags (always with placebo percentile — R4) */}
          {open.flags.length > 0 && (
            <Section title="pre-positioning anomalies (public data, placebo-controlled)">
              {open.flags.map((f, i) => (
                <div key={i} className="text-[11px]" style={{ color: "var(--nx-text-primary)" }}>
                  ${f.symbol}: composite {f.composite.toFixed(2)} —{" "}
                  <b>{f.placeboPctl.toFixed(0)}th percentile</b> vs regime-matched placebo
                </div>
              ))}
              <div className="mt-1 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                describes anomalies in public data; 13F-class real flow is not public (stated limit)
              </div>
            </Section>
          )}

          {/* Predicted reaction — pre-registered forecasts + status strip.
              R6: a head whose rolling Brier lost to its own climatology is
              rendered ADVISORY (muted, no green/red), because greens and reds
              from a losing head are exactly the false confidence the rule
              exists to suppress. */}
          {open.forecasts.length > 0 && (
            <Section title="predicted reaction (pre-registered)">
              {open.forecasts.map((f) => {
                const head = scores.find((h) => h.claimType === f.claimType);
                const advisory = head?.status === "advisory";
                const bg = advisory
                  ? "rgba(107,114,128,0.2)"
                  : f.outcome == null
                    ? "rgba(107,114,128,0.2)"
                    : f.outcome
                      ? "rgba(34,197,94,0.2)"
                      : "rgba(239,68,68,0.2)";
                const fg = advisory ? "#9ca3af" : f.outcome == null ? "#9ca3af" : f.outcome ? "#22c55e" : "#ef4444";
                return (
                  <div key={f.id} className="mb-1 flex items-center gap-2 text-[11px]">
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                      style={{ background: bg, color: fg }}
                      title={advisory ? "head is advisory-only (R6): rolling Brier lost to base rate" : undefined}
                    >
                      {advisory ? "advisory" : f.outcome == null ? "open" : f.outcome ? "hit" : "miss"}
                    </span>
                    <span style={{ color: "var(--nx-text-primary)" }}>
                      {f.claimType}
                      {f.direction ? ` ${f.direction} ${f.magnitudeBand ?? ""}` : ""} · p={f.prob.toFixed(2)}
                      {f.brier != null && !advisory && (
                        <span style={{ color: "var(--nx-text-muted)" }}> · brier {f.brier.toFixed(3)}</span>
                      )}
                    </span>
                  </div>
                );
              })}
              {scores.length > 0 && (
                <div className="mt-1 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                  {scores.map((h) => (
                    <div key={h.claimType}>
                      {h.claimType}: brier {h.meanBrier.toFixed(3)} vs climatology {h.climatologyBrier.toFixed(3)} (n={h.n})
                      {h.status === "advisory" ? " — ADVISORY" : ""}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Lifecycle log */}
          {open.transitions.length > 0 && (
            <Section title="lifecycle">
              {open.transitions.map((t, i) => (
                <div key={i} className="text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
                  {t.fromState} → <span style={{ color: STATE_META[t.toState]?.color }}>{t.toState}</span> · {ago(t.at)}
                </div>
              ))}
            </Section>
          )}

          {/* Articles */}
          <Section title={`articles (${open.articleCount})`}>
            {open.articles.map((a) => (
              <a
                key={a.id}
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="mb-2 block rounded-lg border p-2 text-xs leading-snug transition hover:brightness-110"
                style={{ borderColor: "var(--nx-border)", color: "var(--nx-text-primary)" }}
              >
                {a.title || a.url}
                <div className="mt-0.5 text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
                  {a.outlet || "?"} · first seen {ago(a.firstSeenAt)}
                </div>
              </a>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}
