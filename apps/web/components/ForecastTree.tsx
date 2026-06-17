"use client";

import { useMemo, useRef, useState, useCallback } from "react";
import type { NodeRow, NodeState } from "@erebus/core/client";
import { STATE_COLORS } from "@erebus/core/client";

// ============================================================================
// ForecastTree — the marquee. A pure-SVG horizontal forecast tree that GREENS
// as reality confirms it. Nodes nest by parentId; each is colored by its
// state via STATE_COLORS (gray speculative, amber corroborating, GREEN
// corroborated with a glow, red contradicted dashed). Pan by drag, zoom by
// wheel. The whole point: watch the tree light up green.
// ============================================================================

interface Props {
  nodes: NodeRow[];
  selectedId?: string | null;
  selectedIds?: string[];
  onSelect?: (id: string, additive: boolean) => void;
}

interface Laid {
  node: NodeRow;
  x: number;
  y: number;
  depth: number;
}

const NODE_W = 188;
const NODE_H = 66;
const COL_GAP = 96;
const ROW_GAP = 22;

const GREEN_STATES: NodeState[] = ["corroborated", "resolved_true"];

function isGreen(state: string): boolean {
  return GREEN_STATES.includes(state as NodeState);
}
function isRed(state: string): boolean {
  return state === "contradicted" || state === "resolved_false";
}

// Layout: assign a column by depth (x), and pack leaves vertically (y), parents
// centered over their children. Classic tidy-ish horizontal tree.
function layout(nodes: NodeRow[]): { laid: Laid[]; width: number; height: number } {
  const byId = new Map<string, NodeRow>();
  nodes.forEach((n) => byId.set(n.id, n));

  const childrenOf = new Map<string, NodeRow[]>();
  const roots: NodeRow[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }
  // stable order within siblings
  const sortSibs = (a: NodeRow, b: NodeRow) =>
    (a.branchLabel ?? a.id).localeCompare(b.branchLabel ?? b.id);
  roots.sort(sortSibs);
  childrenOf.forEach((arr) => arr.sort(sortSibs));

  const laid: Laid[] = [];
  const pos = new Map<string, Laid>();
  let cursorY = 0;

  const rowStep = NODE_H + ROW_GAP;
  const colStep = NODE_W + COL_GAP;

  const visit = (node: NodeRow, depth: number): number => {
    const kids = childrenOf.get(node.id) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = cursorY;
      cursorY += rowStep;
    } else {
      const ys = kids.map((k) => visit(k, depth + 1));
      const first = ys[0] ?? cursorY;
      const last = ys[ys.length - 1] ?? first;
      y = (first + last) / 2;
    }
    const entry: Laid = { node, x: depth * colStep, y, depth };
    pos.set(node.id, entry);
    laid.push(entry);
    return y;
  };

  for (const r of roots) {
    visit(r, 0);
    cursorY += ROW_GAP; // breathing room between root subtrees
  }

  let maxX = 0;
  let maxY = 0;
  for (const l of laid) {
    maxX = Math.max(maxX, l.x + NODE_W);
    maxY = Math.max(maxY, l.y + NODE_H);
  }
  return { laid, width: maxX + 40, height: maxY + 40 };
}

const LEGEND: { state: NodeState; label: string }[] = [
  { state: "speculative", label: "speculative" },
  { state: "corroborating", label: "corroborating" },
  { state: "corroborated", label: "corroborated" },
  { state: "contradicted", label: "contradicted" },
];

export function ForecastTree({ nodes, selectedId, selectedIds, onSelect }: Props) {
  const { laid, width, height } = useMemo(() => layout(nodes), [nodes]);
  const posById = useMemo(() => {
    const m = new Map<string, Laid>();
    laid.forEach((l) => m.set(l.node.id, l));
    return m;
  }, [laid]);

  const selSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

  const [tx, setTx] = useState(24);
  const [ty, setTy] = useState(24);
  const [scale, setScale] = useState(1);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const moved = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    const cx = rect ? e.clientX - rect.left : 0;
    const cy = rect ? e.clientY - rect.top : 0;
    setScale((s) => {
      const next = Math.min(2.4, Math.max(0.25, s * (e.deltaY < 0 ? 1.12 : 0.89)));
      // zoom toward cursor
      setTx((px) => cx - ((cx - px) * next) / s);
      setTy((py) => cy - ((cy - py) * next) / s);
      return next;
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, tx, ty };
      moved.current = false;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [tx, ty]
  );
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
    setTx(drag.current.tx + dx);
    setTy(drag.current.ty + dy);
  }, []);
  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  const reset = useCallback(() => {
    setTx(24);
    setTy(24);
    setScale(1);
  }, []);

  if (nodes.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center">
        <div className="max-w-sm">
          <div className="mb-2 text-3xl opacity-30">◈</div>
          <p className="text-sm text-nx-text-secondary">The void is empty.</p>
          <p className="mt-1 text-xs text-nx-text-muted">
            Seed a root forecast above and the tree will branch forward — then green as
            reality arrives to confirm it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <filter id="nx-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g transform={`translate(${tx},${ty}) scale(${scale})`}>
          {/* edges */}
          <g>
            {laid.map((l) => {
              const p = l.node.parentId ? posById.get(l.node.parentId) : null;
              if (!p) return null;
              const x1 = p.x + NODE_W;
              const y1 = p.y + NODE_H / 2;
              const x2 = l.x;
              const y2 = l.y + NODE_H / 2;
              const mx = (x1 + x2) / 2;
              const childGreen = isGreen(l.node.state);
              return (
                <path
                  key={`e-${l.node.id}`}
                  d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={childGreen ? STATE_COLORS.corroborated : "var(--nx-border-strong)"}
                  strokeOpacity={childGreen ? 0.55 : 0.5}
                  strokeWidth={childGreen ? 2 : 1.4}
                />
              );
            })}
          </g>

          {/* nodes */}
          <g>
            {laid.map((l) => {
              const n = l.node;
              const color = STATE_COLORS[n.state as NodeState] ?? STATE_COLORS.speculative;
              const green = isGreen(n.state);
              const red = isRed(n.state);
              const isSel = selectedId === n.id || selSet.has(n.id);
              const conf = Math.max(0, Math.min(1, n.confirmation ?? 0));
              return (
                <g
                  key={n.id}
                  transform={`translate(${l.x},${l.y})`}
                  className={green ? "nx-green-glow" : undefined}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    if (moved.current) return;
                    onSelect?.(n.id, e.shiftKey || e.metaKey || e.ctrlKey);
                  }}
                >
                  {/* selected ring */}
                  {isSel && (
                    <rect
                      x={-4}
                      y={-4}
                      width={NODE_W + 8}
                      height={NODE_H + 8}
                      rx={14}
                      fill="none"
                      stroke="var(--nx-indigo)"
                      strokeWidth={2}
                    />
                  )}
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={11}
                    fill="var(--nx-bg-card)"
                    stroke={color}
                    strokeWidth={green ? 2 : 1.4}
                    strokeDasharray={red ? "5 4" : undefined}
                    filter={green ? "url(#nx-glow)" : undefined}
                  />
                  {/* launch-point flag */}
                  {n.isLaunchPoint && (
                    <circle cx={NODE_W - 12} cy={12} r={4} fill={STATE_COLORS.corroborated} />
                  )}
                  {/* id + branch label */}
                  <text
                    x={11}
                    y={17}
                    fontSize={9}
                    fontWeight={700}
                    fill="var(--nx-text-muted)"
                    style={{ letterSpacing: "0.04em" }}
                  >
                    {n.id}
                    {n.branchLabel ? ` · ${n.branchLabel}` : ""}
                  </text>
                  {/* question (truncated) */}
                  <text x={11} y={34} fontSize={11} fill="var(--nx-text-primary)">
                    {truncate(n.question || n.outcome, 26)}
                  </text>
                  {/* confirmation bar — the green level */}
                  <rect
                    x={11}
                    y={NODE_H - 16}
                    width={NODE_W - 22}
                    height={5}
                    rx={2.5}
                    fill="var(--nx-bg-primary)"
                  />
                  <rect
                    x={11}
                    y={NODE_H - 16}
                    width={(NODE_W - 22) * conf}
                    height={5}
                    rx={2.5}
                    fill={color}
                  />
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-nx-border bg-nx-bg-card/80 px-3 py-2 backdrop-blur">
        {LEGEND.map((l) => (
          <span key={l.state} className="flex items-center gap-1.5 text-[10px] text-nx-text-secondary">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{
                background: STATE_COLORS[l.state],
                boxShadow: l.state === "corroborated" ? `0 0 6px ${STATE_COLORS[l.state]}` : "none",
              }}
            />
            {l.label}
          </span>
        ))}
      </div>

      {/* zoom controls */}
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <button
          className="nx-btn h-8 w-8 !px-0 text-base"
          title="Zoom in"
          onClick={() => setScale((s) => Math.min(2.4, s * 1.18))}
        >
          +
        </button>
        <button
          className="nx-btn h-8 w-8 !px-0 text-base"
          title="Zoom out"
          onClick={() => setScale((s) => Math.max(0.25, s * 0.85))}
        >
          −
        </button>
        <button className="nx-btn h-8 w-8 !px-0 text-xs" title="Reset view" onClick={reset}>
          ⤢
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 text-[10px] text-nx-text-muted">
        drag to pan · scroll to zoom · shift-click to multi-select
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default ForecastTree;
