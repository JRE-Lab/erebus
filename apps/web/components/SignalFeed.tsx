"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchSignals, triggerIngest } from "@/lib/api";

interface SignalLike {
  id?: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  ingestedAt?: string | null;
}

interface Props {
  onIngested?: () => void;
}

export function SignalFeed({ onIngested }: Props) {
  const [signals, setSignals] = useState<SignalLike[]>([]);
  const [pulling, setPulling] = useState(false);
  const [reached, setReached] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = (await fetchSignals()) as unknown;
      const arr = Array.isArray(s) ? (s as SignalLike[]) : [];
      setSignals(arr);
    } catch {
      setSignals([]);
    } finally {
      setReached(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [load]);

  const pull = async () => {
    setPulling(true);
    setNote(null);
    try {
      const r = (await triggerIngest()) as { count?: number; offline?: boolean } | undefined;
      if (r?.offline) setNote("ingest ran offline.");
      else if (typeof r?.count === "number") setNote(`pulled ${r.count} signals.`);
      else setNote("ingest triggered.");
      await load();
      onIngested?.();
    } catch {
      setNote("ingest failed.");
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-nx-border p-3">
        <div className="flex items-center gap-2">
          <span className="nx-dot nx-dot-live" />
          <span className="text-sm font-semibold text-nx-text-primary">Incoming reality</span>
        </div>
        <button className="nx-btn" disabled={pulling} onClick={pull}>
          {pulling ? "Pulling…" : "Pull signals now"}
        </button>
      </div>
      {note && <div className="px-3 pt-2 text-[11px] text-nx-text-secondary">{note}</div>}
      <div className="nx-scroll min-h-0 flex-1 p-2">
        {!reached ? (
          <p className="p-3 text-xs text-nx-text-muted">connecting…</p>
        ) : signals.length === 0 ? (
          <div className="p-3 text-xs text-nx-text-muted">
            No signals yet. Pull the feeds — incoming news greens the branches it confirms.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {signals.map((s, i) => (
              <li key={s.id ?? i} className="nx-card-elevated nx-fade-in p-2.5">
                <p className="line-clamp-2 text-xs font-medium leading-snug text-nx-text-primary">
                  {s.title ?? s.summary ?? "untitled signal"}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-nx-text-muted">
                  {s.source && <span className="truncate">{s.source}</span>}
                  <span className="ml-auto shrink-0">{fmtAgo(s.publishedAt ?? s.ingestedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function fmtAgo(d?: string | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  const sec = (Date.now() - date.getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export default SignalFeed;
