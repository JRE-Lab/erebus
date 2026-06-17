// ============================================================================
// Live-update stub. No real WebSocket — polls /api/changed every 15s and fires
// the handler when anything moved (new nodes, greened branches, new signals).
// Keep simple: this is the seam where a real socket can drop in later.
// ============================================================================
import { fetchChanged, type ChangedResponse } from "./api.js";

export type ErebusEventHandler = (change: ChangedResponse) => void;

export interface OnErebusEventOptions {
  intervalMs?: number; // default 15s
  immediate?: boolean; // fire one poll right away (default false)
}

// Subscribe to change polls. Returns an unsubscribe function that stops the loop.
export function onErebusEvent(
  handler: ErebusEventHandler,
  opts: OnErebusEventOptions = {}
): () => void {
  const intervalMs = opts.intervalMs ?? 15_000;
  let last = new Date().toISOString();
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const change = await fetchChanged(last);
      last = change.since ? new Date().toISOString() : last;
      if (change.newNodes > 0 || change.greened > 0 || change.newSignals > 0) {
        handler(change);
      }
    } catch {
      // Network blips are non-fatal; the next tick retries.
    }
  }

  if (opts.immediate) void tick();
  const id = setInterval(() => void tick(), intervalMs);

  return () => {
    stopped = true;
    clearInterval(id);
  };
}
