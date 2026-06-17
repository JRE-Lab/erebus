"use client";

import { useEffect, useState } from "react";
import { fetchHealth, fetchCost } from "@/lib/api";

// Defensive shapes — the api layer is owned elsewhere; we read loosely so an
// offline / partial response never crashes the chrome.
type HealthLike = { ok?: boolean; db?: boolean; status?: string; healthy?: boolean } | null;
type CostLike =
  | { today?: number; todayUsd?: number; total?: number; budget?: number; daily?: number }
  | number
  | null;

function isHealthy(h: HealthLike): boolean {
  if (!h) return false;
  if (typeof h.ok === "boolean") return h.ok;
  if (typeof h.healthy === "boolean") return h.healthy;
  if (typeof h.db === "boolean") return h.db;
  if (typeof h.status === "string") return h.status.toLowerCase() === "ok";
  return true;
}

function costToday(c: CostLike): number | null {
  if (c == null) return null;
  if (typeof c === "number") return c;
  const v = c.today ?? c.todayUsd ?? c.daily ?? c.total;
  return typeof v === "number" ? v : null;
}

function costBudget(c: CostLike): number | null {
  if (c == null || typeof c === "number") return null;
  return typeof c.budget === "number" ? c.budget : null;
}

export function HealthBar() {
  const [health, setHealth] = useState<HealthLike>(null);
  const [cost, setCost] = useState<CostLike>(null);
  const [reached, setReached] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [h, c] = await Promise.all([
          fetchHealth().catch(() => null),
          fetchCost().catch(() => null),
        ]);
        if (!alive) return;
        setHealth(h as HealthLike);
        setCost(c as CostLike);
        setReached(true);
      } catch {
        if (alive) setReached(true);
      }
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const live = isHealthy(health);
  const today = costToday(cost);
  const budget = costBudget(cost);

  return (
    <div className="flex items-center gap-4 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`nx-dot ${!reached ? "nx-dot-idle" : live ? "nx-dot-live" : "nx-dot-down"}`}
        />
        <span className="text-nx-text-secondary">
          {!reached ? "connecting…" : live ? "live" : "offline"}
        </span>
      </div>
      <div className="hidden items-center gap-1.5 sm:flex">
        <span className="nx-label">today</span>
        <span className="nx-mono font-semibold text-nx-text-primary">
          {today == null ? "—" : `$${today.toFixed(2)}`}
        </span>
        {budget != null && (
          <span className="text-nx-text-muted">/ ${budget.toFixed(2)}</span>
        )}
      </div>
    </div>
  );
}
