// ============================================================================
// EREBUS API — Hono server. Auth, CORS, cost middleware, WebSocket, routes,
// and (optionally) the in-process autonomous worker scheduler.
// ============================================================================
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { healthcheck } from "@erebus/db";
import { isLive } from "./llm/claude.js";

import theories from "./routes/theories.js";
import events from "./routes/events.js";
import shadowboard from "./routes/shadowboard.js";
import evidence from "./routes/evidence.js";
import ingestion from "./routes/ingestion.js";
import feed from "./routes/feed.js";
import search from "./routes/search.js";
import settings from "./routes/settings.js";

const app = new Hono();
const PORT = parseInt(process.env.API_PORT || "8787", 10);

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// --- Basic auth (only when EREBUS_PASS is set). /health stays open. ---
const USER = process.env.EREBUS_USER || "erebus";
const PASS = process.env.EREBUS_PASS;
if (PASS) {
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.method === "OPTIONS") return next();
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Basic ")) {
      try {
        const [u, p] = Buffer.from(auth.slice(6), "base64").toString("utf-8").split(":");
        if (u === USER && p === PASS) return next();
      } catch {
        /* fallthrough */
      }
    }
    return c.text("Authentication required", 401, {
      "WWW-Authenticate": 'Basic realm="EREBUS"',
    });
  });
}

app.use("*", logger());

app.get("/health", async (c) => {
  const db = await healthcheck();
  return c.json({
    status: db ? "healthy" : "degraded",
    db,
    llm: isLive() ? "live" : "offline",
    ts: new Date().toISOString(),
  });
});

app.route("/theories", theories);
app.route("/events", events);
app.route("/shadowboard", shadowboard);
app.route("/evidence", evidence);
app.route("/ingestion", ingestion);
app.route("/feed", feed);
app.route("/search", search);
app.route("/settings", settings);

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404));
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "Internal error", message: err.message }, 500);
});

async function start() {
  const server = serve({ fetch: app.fetch, port: PORT, createServer });

  // WebSocket for live dashboard updates.
  const wss = new WebSocketServer({ server: server as never, path: "/ws" });
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  (globalThis as Record<string, unknown>).broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload, ts: new Date().toISOString() });
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  };

  // Optional in-process autonomous scheduler (single-VPS convenience).
  if (process.env.WORKERS_ENABLED === "true") {
    try {
      const { startScheduler } = await import("./workers/scheduler.js");
      startScheduler();
      console.log("[api] autonomous scheduler started");
    } catch (err) {
      console.warn("[api] scheduler not started:", (err as Error).message);
    }
  }

  console.log(`\n  EREBUS API :${PORT}  |  LLM ${isLive() ? "LIVE" : "OFFLINE"}\n`);
}

start().catch((err) => {
  console.error("[api] fatal:", err);
  process.exit(1);
});

export default app;
