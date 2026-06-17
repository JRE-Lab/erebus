"use client";

// Shadow Board — the seven adversarial intelligence lenses rendered for a theory.
import { useCallback, useEffect, useState } from "react";
import { LENSES, LENS_KEYS } from "@erebus/core";
import type { LensKey, LensVerdict, LensVerdictValue, ShadowBoardResult } from "@erebus/core";
import { fetchLenses, fetchVerdicts, runShadowBoard } from "@/lib/api";

interface VerdictView {
  lens: LensKey;
  verdict: LensVerdictValue;
  severity: number;
  confidence: number;
  rationale: string;
}

const VERDICT_COLOR: Record<LensVerdictValue, string> = {
  pass: "var(--nx-accent-green)",
  warn: "var(--nx-accent-amber)",
  fail: "var(--nx-accent-red)",
};

const VERDICT_LABEL: Record<LensVerdictValue, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

function pct(n: number | undefined): number {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  const v = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export default function ShadowBoard({ theoryId }: { theoryId: string }) {
  const [meta, setMeta] = useState<Record<string, { title: string; short: string }>>({});
  const [verdicts, setVerdicts] = useState<VerdictView[]>([]);
  const [overall, setOverall] = useState<ShadowBoardResult["overall"] | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [lensesRes, verdictsRes] = await Promise.all([
        fetchLenses().catch(() => ({ data: {} })),
        fetchVerdicts(theoryId).catch(() => ({ data: [] as LensVerdict[] })),
      ]);
      setMeta(lensesRes.data ?? {});
      const rows = Array.isArray(verdictsRes.data) ? verdictsRes.data : [];
      setVerdicts(
        rows.map((r) => ({
          lens: r.lens,
          verdict: r.verdict,
          severity: r.severity,
          confidence: r.confidence,
          rationale: r.rationale,
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Shadow Board");
    } finally {
      setLoading(false);
    }
  }, [theoryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await runShadowBoard(theoryId);
      const result = res.data;
      if (result?.verdicts) {
        setVerdicts(
          result.verdicts.map((v) => ({
            lens: v.lens,
            verdict: v.verdict,
            severity: v.severity,
            confidence: v.confidence,
            rationale: v.rationale,
          }))
        );
      }
      if (result?.overall) setOverall(result.overall);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Shadow Board run failed");
    } finally {
      setRunning(false);
    }
  }, [theoryId]);

  const byLens = new Map<LensKey, VerdictView>();
  verdicts.forEach((v) => byLens.set(v.lens, v));

  return (
    <section className="nx-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-bold tracking-wide" style={{ color: "var(--nx-text-primary)" }}>
            Shadow Board
          </h3>
          <p className="text-[11px]" style={{ color: "var(--nx-text-muted)" }}>
            Seven adversarial lenses interrogate the theory.
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="text-[11px] font-semibold px-3 py-1.5 rounded transition-colors disabled:opacity-50"
          style={{ background: "var(--nx-accent-purple)", color: "#fff" }}
        >
          {running ? "Convening…" : "Run Shadow Board"}
        </button>
      </div>

      {error && (
        <div
          className="text-[11px] rounded px-2.5 py-1.5 mb-3"
          style={{ background: "var(--nx-accent-red)22", color: "var(--nx-accent-red)" }}
        >
          {error}
        </div>
      )}

      {overall && (
        <div
          className="rounded-md px-3 py-2.5 mb-3"
          style={{
            background: "var(--nx-bg-elevated)",
            border: `1px solid ${VERDICT_COLOR[overall.verdict] ?? "var(--nx-border)"}55`,
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span
              className="nx-badge"
              style={{
                background: `${VERDICT_COLOR[overall.verdict]}22`,
                color: VERDICT_COLOR[overall.verdict],
                border: `1px solid ${VERDICT_COLOR[overall.verdict]}66`,
              }}
            >
              Overall · {VERDICT_LABEL[overall.verdict] ?? overall.verdict}
            </span>
            <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-muted)" }}>
              severity {pct(overall.severity)}%
            </span>
          </div>
          {overall.summary && (
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--nx-text-secondary)" }}>
              {overall.summary}
            </p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {LENS_KEYS.map((key) => {
          const lensMeta = LENSES[key];
          const title = meta[key]?.title ?? lensMeta?.title ?? key;
          const short = meta[key]?.short ?? lensMeta?.short ?? "";
          const v = byLens.get(key);
          const color = v ? VERDICT_COLOR[v.verdict] : "var(--nx-text-muted)";

          return (
            <div
              key={key}
              className="rounded-md px-3 py-2.5"
              style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)" }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="nx-dot" style={{ background: color }} />
                    <span className="text-xs font-semibold" style={{ color: "var(--nx-text-primary)" }}>
                      {title}
                    </span>
                  </div>
                  <p className="text-[10px] mt-0.5" style={{ color: "var(--nx-text-muted)" }}>
                    {short}
                  </p>
                </div>
                {v ? (
                  <span
                    className="nx-badge shrink-0"
                    style={{ background: `${color}22`, color, border: `1px solid ${color}66` }}
                  >
                    {VERDICT_LABEL[v.verdict] ?? v.verdict}
                  </span>
                ) : (
                  <span
                    className="nx-badge shrink-0"
                    style={{ background: "var(--nx-bg-card)", color: "var(--nx-text-muted)" }}
                  >
                    {loading ? "…" : "Not run"}
                  </span>
                )}
              </div>

              {v && (
                <>
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] uppercase tracking-wide" style={{ color: "var(--nx-text-muted)" }}>
                          Severity
                        </span>
                        <span className="nx-mono text-[9px]" style={{ color: "var(--nx-text-secondary)" }}>
                          {pct(v.severity)}%
                        </span>
                      </div>
                      <div className="h-1 w-full rounded-full overflow-hidden" style={{ background: "var(--nx-bg-primary)" }}>
                        <div className="h-full rounded-full" style={{ width: `${pct(v.severity)}%`, background: color }} />
                      </div>
                    </div>
                    <div className="nx-mono text-[10px] shrink-0" style={{ color: "var(--nx-text-muted)" }}>
                      conf {pct(v.confidence)}%
                    </div>
                  </div>
                  {v.rationale && (
                    <p className="text-[11px] leading-relaxed mt-2" style={{ color: "var(--nx-text-secondary)" }}>
                      {v.rationale}
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
