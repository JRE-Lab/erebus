// Typed API client. Sends baked Basic Auth (cross-origin: web :4000 -> api :4001).
import type {
  Theory,
  TheoryNode,
  EventRecord,
  FeedItem,
  Source,
  ShadowBoardResult,
  LensVerdict,
  EvidenceStatus,
} from "@erebus/core";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
const USER = process.env.NEXT_PUBLIC_EREBUS_USER || "";
const PASS = process.env.NEXT_PUBLIC_EREBUS_PASS || "";

function authHeader(): Record<string, string> {
  if (!PASS) return {};
  const token =
    typeof window === "undefined"
      ? Buffer.from(`${USER}:${PASS}`).toString("base64")
      : btoa(`${USER}:${PASS}`);
  return { Authorization: `Basic ${token}` };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader(), ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

const get = <T>(p: string) => req<T>(p);
const post = <T>(p: string, body?: unknown) =>
  req<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined });
const patch = <T>(p: string, body?: unknown) =>
  req<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });

// --- Health ---
export const fetchHealth = () => get<{ status: string; db: boolean; llm: string }>("/health");

// --- Theories ---
export const fetchTheories = (status?: string) =>
  get<{ data: Theory[]; total: number }>(`/theories${status ? `?status=${status}` : ""}`);
export const fetchTheory = (id: string) =>
  get<{ data: Theory & { connections: unknown[]; predictions: unknown[]; confidenceHistory: unknown[] } }>(
    `/theories/${id}`
  );
export const fetchTheoryGraph = () =>
  get<{ nodes: unknown[]; edges: unknown[] }>("/theories/graph");
export const fetchTree = (id: string) => get<{ data: TheoryNode[] }>(`/theories/${id}/tree`);
export const createTheory = (body: { title?: string; context: string; isShadow?: boolean }) =>
  post<{ data: Theory }>("/theories", body);
export const expandNode = (nodeId: string, question?: string) =>
  post<{ data: TheoryNode }>(`/theories/node/${nodeId}/expand`, { question });
export const rescoreTheory = (id: string) => post<{ data: unknown }>(`/theories/${id}/rescore`);
export const deleteTheory = (id: string) => req(`/theories/${id}`, { method: "DELETE" });

// --- Events ---
export const fetchEvents = (limit = 50) => get<{ data: EventRecord[] }>(`/events?limit=${limit}`);
export const createEvent = (body: { title: string; body?: string; url?: string }) =>
  post<{ data: EventRecord }>("/events", body);

// --- Shadow Board ---
export const fetchLenses = () => get<{ data: Record<string, { title: string; short: string }> }>("/shadowboard/lenses");
export const fetchVerdicts = (theoryId: string) =>
  get<{ data: LensVerdict[] }>(`/shadowboard/${theoryId}`);
export const runShadowBoard = (theoryId: string) =>
  post<{ data: ShadowBoardResult }>(`/shadowboard/${theoryId}/run`);

// --- Evidence ---
export const checkNodeEvidence = (nodeId: string) =>
  post<{ data: { nodeId: string; status: EvidenceStatus; evidence: Record<string, unknown>; cost: number } }>(
    `/evidence/node/${nodeId}/check`
  );
export const checkAllEvidence = (theoryId: string) =>
  post<{ data: { checked: number; totalCost: number; results: { nodeId: string; status: EvidenceStatus }[] } }>(
    `/evidence/${theoryId}/check-all`
  );
export const markEvidence = (nodeId: string, status: EvidenceStatus, summary?: string) =>
  post<{ data: unknown }>(`/evidence/node/${nodeId}/mark`, { status, summary });

// --- Ingestion ---
export const fetchSources = () => get<{ data: Source[] }>("/ingestion/sources");
export const addSource = (body: { name: string; url: string; tier?: number }) =>
  post<{ data: Source }>("/ingestion/sources", body);
export const toggleSource = (id: number, enabled: boolean) =>
  patch<{ data: Source }>(`/ingestion/sources/${id}`, { enabled });
export const pollNow = () => post<{ data: { sources: number; inserted: number } }>("/ingestion/poll");

// --- Feed ---
export const fetchFeed = (limit = 100) => get<{ data: FeedItem[] }>(`/feed?limit=${limit}`);

// --- Search ---
export const search = (q: string) =>
  get<{ data: { events: unknown[]; theories: unknown[] } }>(`/search?q=${encodeURIComponent(q)}`);

// --- Settings / cost ---
export const fetchCost = () =>
  get<{ data: { today: number; month: number; budget: number; byAgent: unknown[] } }>("/settings/cost");

export { BASE as API_BASE };
