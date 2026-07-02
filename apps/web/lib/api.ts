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
  paused?: boolean;
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

export interface GamePlayer {
  name: string;
  type: string;
  payoffRanking: string;
  batna: string;
  dominantStrategy: string;
  patience: string;
}
export interface LeverageMove {
  actor: string;
  move: string;
  mechanism: string;
  expectedShift: string;
  reversibility: string;
}
export interface GameReadRow {
  id: string;
  nodeId: string | null;
  players: GamePlayer[];
  gameType: string | null;
  predictedEquilibrium: string | null;
  equilibriumType: string | null;
  outcomeIsEquilibrium: boolean | null;
  stability: number | null;
  fragilityDrivers: string[];
  focalPoint: string | null;
  leverageMoves: LeverageMove[];
  noRegretAction: string | null;
  reversalTripwire: string | null;
  model: string | null;
  createdAt: string;
}

export interface NodeDetail {
  node: NodeRow;
  signal_matches: SignalMatchWithSignal[];
  debates: unknown[];
  shadow_reads: unknown[];
  events: unknown[];
  relationships: { from: RelationshipRow[]; to: RelationshipRow[] };
  game_read?: GameReadRow | null;
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

export interface ContentScene {
  narration: string;
  imagePrompt: string;
  image?: string | null;
}

export interface ContentItem {
  id: string;
  nodeId: string | null;
  title: string | null;
  script: string | null;
  caption: string | null;
  data: { hook?: string; scenes?: ContentScene[] } | null;
  audioUrl: string | null;
  videoUrl: string | null;
  platform: string | null;
  status: string; // draft|scripted|visualized|voiced|rendered|published
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

function put<T>(path: string, body?: unknown): Promise<T> {
  return req<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// --- interactive recursion + autonomy shapes --------------------------------

export interface Direction {
  label: string;
  angle: "consequence" | "actor" | "failure" | "wildcard" | string;
  text: string;
}

export interface DirectionsResponse {
  directions: Direction[];
  cost: number;
}

export interface PursueResponse {
  node: NodeRow | null;
  analysis: string;
  cost: number;
  blocked?: string;
}

export interface RoamResponse {
  status: "expanded" | "idle" | "blocked";
  nodeId?: string;
  expanded: number;
  childIds?: string[];
  cost: number;
  blocked?: string;
}

// --- market correlation -----------------------------------------------------
export interface OverviewInstrument {
  symbol: string;
  name: string;
  kind: string;
  price: number | null;
  asOf: string;
  source: string;
  d1: number | null;
  d5: number | null;
  d30: number | null;
}
export interface TheoryLink {
  symbol: string;
  name: string;
  expectation: "up" | "down" | string;
  rationale: string | null;
  move: number | null;
  verdict: "confirms" | "contradicts" | "neutral";
}
export interface TheoryCorrelation {
  nodeId: string;
  question: string;
  state: string;
  origin: string;
  links: TheoryLink[];
}
export interface MarketOverview {
  instruments: OverviewInstrument[];
  theories: TheoryCorrelation[];
  window: number;
  threshold: number;
}

export interface AutonomousState {
  enabled: boolean;
  erebus_nodes?: number;
  launch_points?: number;
  greens?: number;
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

// Game-theory read + decision layer.
export const gameRead = (id: string) =>
  post<{ gameRead: GameReadRow | null; cost: number; offline: boolean }>(
    `/nodes/${encodeURIComponent(id)}/game`
  );

// Analysis of Competing Hypotheses (rival outcomes + posterior distribution).
export interface Hypothesis {
  label: string;
  probability: number;
  isOutcome?: boolean;
}
export interface AchResult {
  hypotheses: Hypothesis[];
  outcomeProbability: number | null;
  leaderIsOutcome: boolean;
  note: string;
  cost: number;
  offline: boolean;
}
export const runACH = (id: string) => post<AchResult>(`/nodes/${encodeURIComponent(id)}/ach`);

// Operator adjudication (external truth) — resolves a forecast + scores Brier.
export const resolveNode = (id: string, happened: boolean) =>
  put<{ resolved: true; outcome: boolean; brier: number }>(`/nodes/${encodeURIComponent(id)}/resolve`, {
    happened,
  });

// Genesis — EREBUS births new root theories from the signal stream.
export interface GenesisResult {
  created: Array<{ id: string; question: string; dark: boolean }>;
  cost: number;
  offline: boolean;
}
export const runGenesis = (dark: boolean, count = 2) =>
  post<GenesisResult>("/genesis", { dark, count });

// Alerts — greened / tipping / contradicted / tripwire / newborn theories.
export interface AlertRow {
  id: string;
  kind: string;
  nodeId: string | null;
  title: string;
  detail: string | null;
  createdAt: string;
  seenAt: string | null;
}
export const fetchAlerts = (limit = 40) =>
  req<{ alerts: AlertRow[]; unseen: number }>(`/alerts?limit=${limit}`);
export const markAlertsSeen = () => put<{ ok: boolean }>("/alerts/seen");

// Operating hours (worker autonomous window, UTC).
export interface OperatingHours {
  on: boolean;
  startHour: number;
  endHour: number;
}
export const fetchHours = () => req<OperatingHours>("/hours");
export const setHours = (h: OperatingHours) => put<OperatingHours>("/hours", h);

// Real-world calibration.
export interface CalibrationStats {
  resolved: number;
  meanBrier: number | null;
  trueRate: number | null;
  dueUnresolved: number;
}
export const fetchCalibration = () => req<CalibrationStats>("/calibration");

export const synthesize = (ids: string[]) => post<SynthesizeResponse>("/synthesize", { ids });

export const fetchSignals = (limit?: number) =>
  req<SignalRow[]>(`/signals${limit ? `?limit=${limit}` : ""}`);

export const triggerIngest = () => post<IngestResponse>("/ingest");

export const search = (q: string) => req<SearchResponse>(`/search?q=${encodeURIComponent(q)}`);

export const fetchWorldview = () => req<WorldviewSnapshot | null>("/worldview");

export const fetchCost = () => req<CostResponse>("/cost");

export const fetchContent = () => req<ContentItem[]>("/content");

// Content Studio — granular pipeline steps the UI drives one at a time.
export interface ScriptShape {
  title: string;
  hook: string;
  script: string;
  caption: string;
  scenes: ContentScene[];
}
export const generateContentScript = (nodeId: string) =>
  post<{ contentId: string; script: ScriptShape; cost: number; offline: boolean }>("/content/script", { nodeId });

export const generateContentImages = (id: string) =>
  post<{ images: number; cost: number }>(`/content/${encodeURIComponent(id)}/images`);

export const generateContentVoice = (id: string) =>
  post<{ audioUrl: string | null }>(`/content/${encodeURIComponent(id)}/voice`);

export const generateContentVideo = (id: string) =>
  post<{ videoUrl: string | null; note?: string }>(`/content/${encodeURIComponent(id)}/video`);

// Full pipeline in one shot (script -> images -> voice -> video, best-effort).
export const makeContent = (nodeId: string) =>
  post<ContentItem>(`/content/${encodeURIComponent(nodeId)}/full`);

export const fetchChanged = (since?: string) =>
  req<ChangedResponse>(`/changed${since ? `?since=${encodeURIComponent(since)}` : ""}`);

// Interactive recursion: suggested directions + pursue a direction/response.
export const fetchDirections = (id: string) =>
  req<DirectionsResponse>(`/nodes/${encodeURIComponent(id)}/directions`);

export const pursueDirection = (id: string, direction: string) =>
  post<PursueResponse>(`/nodes/${encodeURIComponent(id)}/pursue`, { direction });

// Global pause kill-switch (stops ALL spend: LLM + embeddings + worker).
export const fetchPaused = () => req<{ paused: boolean }>("/paused");
export const setPausedState = (paused: boolean) => put<{ paused: boolean }>("/paused", { paused });

// Autonomous roam mode.
export const roam = () => post<RoamResponse>("/roam");
export const fetchAutonomous = () => req<AutonomousState>("/autonomous");
export const setAutonomous = (enabled: boolean) => put<AutonomousState>("/autonomous", { enabled });

// Continuous roam: worker branches back-to-back while on (budget-capped).
export const fetchContinuousRoam = () => req<{ continuous: boolean }>("/roam/continuous");
export const setContinuousRoam = (continuous: boolean) =>
  put<{ continuous: boolean }>("/roam/continuous", { continuous });

// Market correlation tab.
export const fetchMarket = () => req<MarketOverview>("/market");
export const mapMarket = (nodeId?: string) =>
  post<{ mapped?: number; created: number; cost: number }>("/market/map", nodeId ? { nodeId } : {});
export const refreshMarket = () =>
  post<{ checked: number; signals: number; matches: number }>("/market/refresh");
