"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchMarket,
  mapMarket,
  refreshMarket,
  type MarketOverview,
  type OverviewInstrument,
  type TheoryLink,
} from "@/lib/api";

// ----------------------------------------------------------------------------
// Market — stock/commodity correlation. Each theory is mapped to the instruments
// that should move if it comes true; significant aligned/opposed moves green or
// contradict it. Data: free, no-key feeds (Stooq -> Yahoo), daily closes.
// ----------------------------------------------------------------------------

export default function MarketPage() {
  const [data, setData] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"map" | "refresh" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchMarket());
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  const onMap = async () => {
    setBusy("map");
    setNote(null);
    try {
      const r = await mapMarket();
      setNote(`Mapped theories → ${r.created} new instrument links.`);
      await load();
    } catch (e) {
      setNote(`Map failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onRefresh = async () => {
    setBusy("refresh");
    setNote(null);
    try {
      const r = await refreshMarket();
      setNote(`Checked ${r.checked} links → ${r.signals} new market signal(s), ${r.matches} applied.`);
      await load();
    } catch (e) {
      setNote(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const instruments = data?.instruments ?? [];
  const theories = data?.theories ?? [];

  return (
    <div className="nx-scroll h-full">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-nx-text-primary">Market correlation</h1>
            <p className="mt-1 text-sm text-nx-text-secondary">
              Theories mapped to instruments. A move ≥ {data?.threshold ?? 4}% over {data?.window ?? 5} trading days
              greens (aligned) or contradicts (opposed) the forecast.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="nx-btn text-xs" disabled={busy !== null} onClick={onMap}>
              {busy === "map" ? "Mapping…" : "Map theories"}
            </button>
            <button className="nx-btn nx-btn-primary text-xs" disabled={busy !== null} onClick={onRefresh}>
              {busy === "refresh" ? "Grading…" : "Refresh + grade"}
            </button>
          </div>
        </header>

        {note && <div className="text-xs text-nx-text-secondary">{note}</div>}

        {/* instrument board */}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-nx-text-primary">Watchlist</h2>
          {loading && !data ? (
            <p className="text-sm text-nx-text-muted">Loading quotes…</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {instruments.map((i) => (
                <InstrumentCard key={i.symbol} i={i} />
              ))}
            </div>
          )}
        </section>

        {/* per-theory correlation */}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-nx-text-primary">
            Theory ↔ market ({theories.length})
          </h2>
          {theories.length === 0 ? (
            <div className="nx-card p-6 text-center">
              <p className="text-sm text-nx-text-secondary">No theories mapped to instruments yet.</p>
              <p className="mt-1 text-xs text-nx-text-muted">
                Hit “Map theories” to link your forecasts to the instruments that should move with them.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {theories.map((t) => (
                <div key={t.nodeId} className="nx-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Link
                      href={`/?node=${encodeURIComponent(t.nodeId)}`}
                      className="line-clamp-1 text-sm font-medium text-nx-text-primary hover:underline"
                    >
                      <span className="nx-mono text-[10px] text-nx-text-muted">{t.nodeId}</span> {t.question}
                    </Link>
                    {t.origin === "erebus" && <span className="nx-chip" style={{ color: "var(--nx-amber)", borderColor: "var(--nx-amber)" }}>erebus</span>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {t.links.map((l) => (
                      <LinkChip key={l.symbol} l={l} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function pctColor(v: number | null): string {
  if (v === null) return "var(--nx-text-muted)";
  if (v > 0.05) return "var(--nx-green)";
  if (v < -0.05) return "var(--nx-red)";
  return "var(--nx-text-secondary)";
}
function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function InstrumentCard({ i }: { i: OverviewInstrument }) {
  return (
    <div className="nx-card p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-nx-text-primary">{i.symbol}</span>
        <span className="nx-mono text-[11px] text-nx-text-secondary">
          {i.price !== null ? i.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
        </span>
      </div>
      <div className="line-clamp-1 text-[10px] text-nx-text-muted">{i.name}</div>
      <div className="mt-1.5 flex items-center justify-between text-[10px]">
        <Span label="1d" v={i.d1} />
        <Span label="1w" v={i.d5} />
        <Span label="1mo" v={i.d30} />
      </div>
    </div>
  );
}

function Span({ label, v }: { label: string; v: number | null }) {
  return (
    <span className="flex flex-col items-center">
      <span className="text-nx-text-muted">{label}</span>
      <span className="nx-mono font-semibold" style={{ color: pctColor(v) }}>
        {fmtPct(v)}
      </span>
    </span>
  );
}

function LinkChip({ l }: { l: TheoryLink }) {
  const vColor =
    l.verdict === "confirms" ? "var(--nx-green)" : l.verdict === "contradicts" ? "var(--nx-red)" : "var(--nx-border-strong)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
      style={{ borderColor: vColor }}
      title={l.rationale ?? undefined}
    >
      <span className="font-semibold text-nx-text-primary">{l.symbol}</span>
      <span className="text-nx-text-muted">{l.expectation === "down" ? "↓ if true" : "↑ if true"}</span>
      <span className="nx-mono" style={{ color: pctColor(l.move) }}>
        {fmtPct(l.move)}
      </span>
      {l.verdict !== "neutral" && (
        <span style={{ color: vColor }}>{l.verdict === "confirms" ? "✓" : "✕"}</span>
      )}
    </span>
  );
}
