"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAlerts, markAlertsSeen, type AlertRow } from "@/lib/api";

// Alert bell — the "looking into the void pays off" moment. Polls for alerts
// (greened / tipping / contradicted / resolved / newborn theories) and shows a
// badge; opening the rail marks everything seen.

const KIND_COLOR: Record<string, string> = {
  greened: "var(--nx-green)",
  tipping: "#a855f7",
  contradicted: "var(--nx-red)",
  resolved: "var(--nx-indigo)",
  fragile: "#a855f7",
  genesis: "var(--nx-amber)",
  dark_genesis: "#a855f7",
};

export function AlertsBell({ onJump }: { onJump?: (nodeId: string) => void }) {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchAlerts(40);
      setRows(r.alerts ?? []);
      setUnseen(r.unseen ?? 0);
    } catch {
      /* offline-safe */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unseen > 0) {
      setUnseen(0);
      try {
        await markAlertsSeen();
      } catch {
        /* offline-safe */
      }
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        className="nx-btn relative"
        title="Alerts — what changed while you weren't looking"
      >
        🔔
        {unseen > 0 && (
          <span
            className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9px] font-bold"
            style={{ background: "var(--nx-red)", color: "#fff" }}
          >
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div
          className="nx-scroll absolute right-0 top-full z-50 mt-2 max-h-[60vh] w-[380px] overflow-y-auto rounded-xl border p-2 shadow-2xl"
          style={{ borderColor: "var(--nx-border-strong)", background: "var(--nx-bg-card)" }}
        >
          {rows.length === 0 ? (
            <p className="p-3 text-xs italic text-nx-text-muted">
              No alerts yet — they appear when theories green, tip, contradict, or are born.
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-transparent p-2 text-left transition hover:bg-nx-bg-elevated"
                    onClick={() => {
                      if (a.nodeId && onJump) {
                        onJump(a.nodeId);
                        setOpen(false);
                      }
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="nx-dot" style={{ background: KIND_COLOR[a.kind] ?? "var(--nx-border-strong)" }} />
                      <span className="line-clamp-1 text-xs font-medium text-nx-text-primary">{a.title}</span>
                    </div>
                    {a.detail && (
                      <p className="mt-0.5 line-clamp-2 pl-3.5 text-[11px] leading-snug text-nx-text-secondary">
                        {a.detail}
                      </p>
                    )}
                    <span className="pl-3.5 text-[10px] text-nx-text-muted">{ago(a.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ago(d: string): string {
  const t = new Date(d).getTime();
  if (isNaN(t)) return "";
  const sec = (Date.now() - t) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
