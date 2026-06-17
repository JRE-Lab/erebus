"use client";
// Tiny WebSocket helper for live dashboard updates. Auto-reconnects.
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787/ws";

type Handler = (type: string, payload: unknown) => void;

let ws: WebSocket | null = null;
let delay = 1000;
const handlers = new Set<Handler>();

function connect() {
  if (typeof window === "undefined") return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      delay = 1000;
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; payload: unknown };
        handlers.forEach((h) => h(msg.type, msg.payload));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      setTimeout(connect, (delay = Math.min(delay * 2, 30000)));
    };
    ws.onerror = () => ws?.close();
  } catch {
    setTimeout(connect, 5000);
  }
}

export function onErebusEvent(handler: Handler): () => void {
  handlers.add(handler);
  connect();
  return () => handlers.delete(handler);
}
