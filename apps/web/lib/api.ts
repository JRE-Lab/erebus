// ============================================================================
// Typed fetch client for the EREBUS API. Same-origin (base "/api"), so no auth
// header is needed — Basic-auth (if enabled) rides on the browser session.
// Each function maps 1:1 to a route in app/api/[[...route]]/route.ts.
// ============================================================================
import type { NodeRow, SignalRow } from "@erebus/core";

const BASE = "/api";

// --- shared response shapes (mirror the locked contracts' return types) -----

export interface HealthResponse {
  status: string;
  llm: "live" | "offline";
}

export interface CreateForecastResponse {
  node: NodeRow;
  cost: number;
  offline: boolean;
}

export interface ExpandResponse {
  children: NodeRow[];
  cost: number;
  blocked?: string;
}

export interface SynthesizeResponse {
  node: NodeRow | null;
  cost: number;
}

export interface DebateResponse {
  rounds: number;
  verdict: string;
  confidenceBefore: number;
  confidenceAfter: number;
  revisedOutcome?: string;
  cost: number;
}

export interface ShadowResponse {
  shadowRead: unknown | null;
  spawnedNode: string | null;
  cost: number;
  offline: boolean;
}

export interface IngestResponse {
  signals: number;
  matches: number;
}

export interface SignalMatchWithSignal {
  id: string;
  signalId: string | null;
  nodeId: string | null;
  effect: string;
  weight: number;
  rationale: string | null;
  createdAt: string;
  signal: {
    id: string;
    source: string | null;
    url: string | null;
    title: string | null;
    summary: string | null;
    publishedAt: string | null;
  } | null;
}

export interface RelationshipRow {
  id: string;
  fromNode: string | null;
  toNode: string | null;
  type: string;
  strength: number;
  rationale: string;
  createdAt: string;
}

export interface NodeDetail {
  node: NodeRow;
  signal_matches: SignalMatchWithSignal[];
  debates: unknown[];
  shadow_reads: unknown[];
  events: unknown[];
  relationships: { from: RelationshipRow[]; to: RelationshipRow[] };
}

export interface SearchResponse {
  query: string;
  nodes: { distance: number; node: NodeRow }[];
  signals: { distance: number; signal: SignalRow }[];
}

export interface WorldviewSnapshot {
  id: string;
  summary: string | null;
  nodeCount: number | null;
  greenCount: number | null;
  calibrationScore: number | null;
  novelLinks: unknown;
  generatedAt: string;
}

export interface CostResponse {
  today: number;
  month: number;
  allTime: number;
  jobs: number;
}

export interface ContentItem {
  id: string;
  nodeId: string | null;
  script: string | null;
  audioUrl: string | null;
  videoUrl: string | null;
  platform: string | null;
  status: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface ChangedResponse {
  since: string;
  newNodes: number;
  greened: number;
  newSignals: number;
}

// --- transport --------------------------------------------------------------

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ? `: ${body.error}` : "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${init?.method || "GET"} ${path} -> ${res.status}${detail}`);
  }
  // 204 / empty bodies degrade to null.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- public surface (matches the spec list exactly) -------------------------

export const fetchHealth = () => req<HealthResponse>("/health");

export const fetchNodes = () => req<NodeRow[]>("/nodes");

export const fetchNode = (id: string) => req<NodeDetail>(`/nodes/${encodeURIComponent(id)}`);

export const fetchTree = (root?: string) =>
  req<NodeRow[]>(`/tree${root ? `?root=${encodeURIComponent(root)}` : ""}`);

export const createForecast = (context: string) =>
  post<CreateForecastResponse>("/nodes", { context });

export const expandNode = (id: string) =>
  post<ExpandResponse>(`/nodes/${encodeURIComponent(id)}/expand`);

export const debateNode = (id: string, rounds?: number) =>
  post<DebateResponse>(`/nodes/${encodeURIComponent(id)}/debate`, { rounds: rounds ?? 1 });

export const shadowNode = (id: string) =>
  post<ShadowResponse>(`/nodes/${encodeURIComponent(id)}/shadow`);

export const synthesize = (ids: string[]) => post<SynthesizeResponse>("/synthesize", { ids });

export const fetchSignals = (limit?: number) =>
  req<SignalRow[]>(`/signals${limit ? `?limit=${limit}` : ""}`);

export const triggerIngest = () => post<IngestResponse>("/ingest");

export const search = (q: string) => req<SearchResponse>(`/search?q=${encodeURIComponent(q)}`);

export const fetchWorldview = () => req<WorldviewSnapshot | null>("/worldview");

export const fetchCost = () => req<CostResponse>("/cost");

export const fetchContent = () => req<ContentItem[]>("/content");

export const makeContent = (id: string) =>
  post<ContentItem>(`/content/${encodeURIComponent(id)}`);

export const fetchChanged = (since?: string) =>
  req<ChangedResponse>(`/changed${since ? `?since=${encodeURIComponent(since)}` : ""}`);
