"use client";

// Reusable presentational panel for a single node's evidence object.
// Parent owns all data + async actions; this component is purely presentational.
import { EVIDENCE_COLORS } from "@erebus/core";
import type { EvidenceStatus, EvidenceDetail } from "@erebus/core";

const STATUSES: EvidenceStatus[] = ["confirmed", "partial", "disconfirmed", "pending"];

const STATUS_LABEL: Record<EvidenceStatus, string> = {
  confirmed: "Confirmed",
  partial: "Partial",
  disconfirmed: "Disconfirmed",
  pending: "Pending",
};

function colorFor(status: EvidenceStatus): string {
  return EVIDENCE_COLORS[status] ?? EVIDENCE_COLORS.pending;
}

export interface EvidencePanelProps {
  status: EvidenceStatus;
  evidence: EvidenceDetail | null | undefined;
  onCheck: () => void;
  onMark: (status: EvidenceStatus) => void;
  loading?: boolean;
}

export default function EvidencePanel({ status, evidence, onCheck, onMark, loading = false }: EvidencePanelProps) {
  const safeStatus: EvidenceStatus = STATUSES.includes(status) ? status : "pending";
  const accent = colorFor(safeStatus);
  const ev = evidence ?? {};

  const supporting = Array.isArray(ev.supporting) ? ev.supporting.filter(Boolean) : [];
  const contradicting = Array.isArray(ev.contradicting) ? ev.contradicting.filter(Boolean) : [];
  const confidencePct =
    typeof ev.confidence === "number" && isFinite(ev.confidence)
      ? Math.round((ev.confidence <= 1 ? ev.confidence * 100 : ev.confidence))
      : null;

  return (
    <section className="nx-card" style={{ background: "var(--nx-bg-elevated)" }}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold tracking-widest uppercase" style={{ color: "var(--nx-text-muted)" }}>
            Evidence
          </span>
          <span
            className="nx-badge"
            style={{ background: `${accent}22`, color: accent, border: `1px solid ${accent}55` }}
          >
            <span className="nx-dot" style={{ background: accent }} />
            {STATUS_LABEL[safeStatus]}
          </span>
        </div>
        <button
          onClick={onCheck}
          disabled={loading}
          className="text-[11px] font-semibold px-2.5 py-1 rounded transition-colors disabled:opacity-50"
          style={{ background: "var(--nx-accent-cyan)", color: "#04141a" }}
        >
          {loading ? "Checking…" : "Check Evidence"}
        </button>
      </div>

      {/* Confidence bar */}
      {confidencePct !== null && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--nx-text-muted)" }}>
              Confidence
            </span>
            <span className="nx-mono text-[10px]" style={{ color: "var(--nx-text-secondary)" }}>
              {confidencePct}%
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: "var(--nx-bg-primary)" }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(0, Math.min(100, confidencePct))}%`, background: accent }}
            />
          </div>
        </div>
      )}

      {/* Summary */}
      {ev.summary ? (
        <p className="text-xs leading-relaxed mb-3" style={{ color: "var(--nx-text-secondary)" }}>
          {ev.summary}
        </p>
      ) : (
        <p className="text-xs italic mb-3" style={{ color: "var(--nx-text-muted)" }}>
          No evidence assessment yet. Run a check or mark manually.
        </p>
      )}

      {/* Key indicator */}
      {ev.key_indicator && (
        <div
          className="rounded-md px-2.5 py-2 mb-3 text-[11px]"
          style={{ background: "var(--nx-bg-card)", border: `1px solid ${accent}44` }}
        >
          <span className="font-bold uppercase tracking-wide mr-1.5" style={{ color: accent }}>
            Key Indicator
          </span>
          <span style={{ color: "var(--nx-text-secondary)" }}>{ev.key_indicator}</span>
        </div>
      )}

      {/* Supporting / contradicting */}
      {(supporting.length > 0 || contradicting.length > 0) && (
        <div className="grid grid-cols-1 gap-3 mb-3">
          {supporting.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "var(--nx-confirmed)" }}>
                Supporting ({supporting.length})
              </div>
              <ul className="space-y-1">
                {supporting.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px]" style={{ color: "var(--nx-text-secondary)" }}>
                    <span style={{ color: "var(--nx-confirmed)" }}>+</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {contradicting.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: "var(--nx-disconfirmed)" }}>
                Contradicting ({contradicting.length})
              </div>
              <ul className="space-y-1">
                {contradicting.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px]" style={{ color: "var(--nx-text-secondary)" }}>
                    <span style={{ color: "var(--nx-disconfirmed)" }}>−</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {ev.checked_at && (
        <div className="nx-mono text-[10px] mb-3" style={{ color: "var(--nx-text-muted)" }}>
          Checked {new Date(ev.checked_at).toLocaleString()}
          {ev.manual ? " · manual" : ""}
        </div>
      )}

      {/* Manual mark buttons */}
      <div className="pt-2 border-t" style={{ borderColor: "var(--nx-border)" }}>
        <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color: "var(--nx-text-muted)" }}>
          Mark manually
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => {
            const c = colorFor(s);
            const active = s === safeStatus;
            return (
              <button
                key={s}
                onClick={() => onMark(s)}
                disabled={loading}
                className="text-[10px] font-semibold px-2 py-1 rounded transition-colors disabled:opacity-50"
                style={{
                  background: active ? c : "transparent",
                  color: active ? "#04141a" : c,
                  border: `1px solid ${c}${active ? "" : "66"}`,
                }}
              >
                {STATUS_LABEL[s]}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
