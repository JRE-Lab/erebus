"use client";

// ============================================================================
// EREBUS v2 — TheoryTree
// A horizontal (left-to-right) SVG tree of TheoryNodes. Pure SVG, zero deps.
//   - Layout engine nests a flat node list by parent_id and lays leaves out in
//     a tidy vertical pack, centering parents over their children.
//   - Curved connector paths, color rules by state / evidence_status.
//   - Pan by dragging the canvas, zoom with the wheel (0.4x–2.5x), reset button.
//   - Clicking a node calls onSelect(id); the selected node gets a bright ring.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { TheoryNode } from "@erebus/core";
import { EVIDENCE_COLORS } from "@erebus/core";

interface TheoryTreeProps {
  nodes: TheoryNode[]; // flat list; nest via parent_id (root has parent_id === null)
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// ---- geometry constants ----------------------------------------------------
const NODE_W = 150;
const NODE_H = 44;
const COL_GAP = 90; // horizontal gap between depth columns
const ROW_GAP = 18; // vertical gap between sibling rows / packed leaves
const PAD = 60; // padding around the laid-out content
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

// ---- color palette (from design tokens / @erebus/core) ---------------------
const C = {
  bg: "var(--nx-bg-secondary)",
  card: "var(--nx-bg-card)",
  border: "var(--nx-border)",
  text: "var(--nx-text-primary)",
  muted: "var(--nx-text-muted)",
  indigo: "var(--nx-accent-indigo)", // #6366f1
  indigoLight: "#818cf8", // "user" — lighter indigo
  amber: "var(--nx-accent-amber)", // #f59e0b — erebus
  green: EVIDENCE_COLORS.confirmed, // #22c55e
  yellow: EVIDENCE_COLORS.partial, // #eab308
  red: EVIDENCE_COLORS.disconfirmed, // #ef4444
  pending: EVIDENCE_COLORS.pending, // #94a3b8
} as const;

interface Laid {
  node: TheoryNode;
  x: number; // top-left of card
  y: number;
  depth: number;
}

interface NodeStyle {
  fill: string;
  stroke: string;
  dashed: boolean;
  glow: boolean;
}

// Determine card colors. evidence_status overrides the explored_by/root rules.
function styleFor(node: TheoryNode, isRoot: boolean): NodeStyle {
  switch (node.evidence_status) {
    case "confirmed":
      return { fill: C.green, stroke: C.green, dashed: false, glow: true };
    case "partial":
      return { fill: C.yellow, stroke: C.yellow, dashed: false, glow: false };
    case "disconfirmed":
      return { fill: C.red, stroke: C.red, dashed: true, glow: false };
    default:
      break; // "pending" → fall through to state-based color
  }
  if (isRoot) return { fill: C.indigo, stroke: C.indigo, dashed: false, glow: false };
  if (node.explored_by === "erebus")
    return { fill: C.amber, stroke: C.amber, dashed: false, glow: false };
  // explored_by === "user" → lighter indigo
  return { fill: C.indigoLight, stroke: C.indigoLight, dashed: false, glow: false };
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ----------------------------------------------------------------------------
// Layout engine: flat list -> positioned cards.
// x by depth; y by a post-order tidy pack of leaves, parents centered on kids.
// Resilient to: empty input, missing parents (treated as roots), and cycles.
// ----------------------------------------------------------------------------
function layout(nodes: TheoryNode[]): { laid: Laid[]; width: number; height: number; rootIds: Set<string> } {
  if (!nodes || nodes.length === 0) {
    return { laid: [], width: 0, height: 0, rootIds: new Set() };
  }

  const byId = new Map<string, TheoryNode>();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);

  // Build children map. A node is a "root" if parent_id is null OR its parent
  // is not present in this list (orphan / partial slice).
  const childrenOf = new Map<string, TheoryNode[]>();
  const rootIds = new Set<string>();
  for (const n of byId.values()) {
    const pid = n.parent_id;
    if (pid && byId.has(pid)) {
      const arr = childrenOf.get(pid) ?? [];
      arr.push(n);
      childrenOf.set(pid, arr);
    } else {
      rootIds.add(n.id);
    }
  }

  // Stable child order: by score desc, then created_at, then id — keeps the
  // tree from reshuffling on re-render and surfaces stronger branches first.
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => {
      const s = (b.score ?? 0) - (a.score ?? 0);
      if (s !== 0) return s;
      const t = (a.created_at ?? "").localeCompare(b.created_at ?? "");
      if (t !== 0) return t;
      return a.id.localeCompare(b.id);
    });
  }

  const laid: Laid[] = [];
  const yOf = new Map<string, number>();
  const visited = new Set<string>(); // cycle guard
  let cursorY = 0; // running leaf cursor (in row units)

  const rowStride = NODE_H + ROW_GAP;
  const colStride = NODE_W + COL_GAP;

  // Post-order assignment: leaves stack downward; parents center on children.
  function place(node: TheoryNode, depth: number): number {
    if (visited.has(node.id)) {
      // Already placed (cycle / shared parent) — reuse its y.
      return yOf.get(node.id) ?? cursorY * rowStride;
    }
    visited.add(node.id);

    const kids = childrenOf.get(node.id) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = cursorY * rowStride;
      cursorY += 1;
    } else {
      const ys: number[] = [];
      for (const kid of kids) ys.push(place(kid, depth + 1));
      // Center parent vertically across the span of its children.
      const first = ys[0];
      const last = ys[ys.length - 1];
      y = (first + last) / 2;
    }
    yOf.set(node.id, y);
    laid.push({ node, x: depth * colStride, y, depth });
    return y;
  }

  // Roots in a stable order.
  const roots = [...rootIds]
    .map((id) => byId.get(id)!)
    .sort((a, b) => {
      const s = (b.score ?? 0) - (a.score ?? 0);
      if (s !== 0) return s;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);
    });
  for (const r of roots) place(r, 0);

  // Safety net: any node not reached (shouldn't happen, but guards cycles that
  // hid a node) gets appended as its own row so it's never dropped.
  for (const n of byId.values()) {
    if (!visited.has(n.id)) {
      const y = cursorY * rowStride;
      cursorY += 1;
      yOf.set(n.id, y);
      laid.push({ node: n, x: (n.depth ?? 0) * colStride, y, depth: n.depth ?? 0 });
    }
  }

  // Normalize so the content's min x/y is 0, then compute bounds.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of laid) {
    minX = Math.min(minX, l.x);
    minY = Math.min(minY, l.y);
    maxX = Math.max(maxX, l.x + NODE_W);
    maxY = Math.max(maxY, l.y + NODE_H);
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = NODE_W;
    maxY = NODE_H;
  }
  for (const l of laid) {
    l.x = l.x - minX + PAD;
    l.y = l.y - minY + PAD;
  }

  return {
    laid,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
    rootIds,
  };
}

// Curved connector from a parent's right edge to a child's left edge.
function connectorPath(px: number, py: number, cx: number, cy: number): string {
  const x1 = px + NODE_W;
  const y1 = py + NODE_H / 2;
  const x2 = cx;
  const y2 = cy + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

// ----------------------------------------------------------------------------
export default function TheoryTree({ nodes, selectedId, onSelect }: TheoryTreeProps) {
  const { laid, width, height } = useMemo(() => layout(nodes ?? []), [nodes]);

  const posById = useMemo(() => {
    const m = new Map<string, Laid>();
    for (const l of laid) m.set(l.node.id, l);
    return m;
  }, [laid]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 500 });
  const dragRef = useRef<{ active: boolean; sx: number; sy: number; ox: number; oy: number; moved: boolean }>({
    active: false,
    sx: 0,
    sy: 0,
    ox: 0,
    oy: 0,
    moved: false,
  });

  // Track container size for fit-to-view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        setSize({ w: Math.max(1, cr.width), h: Math.max(1, cr.height) });
      }
    });
    ro.observe(el);
    setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  // Fit the whole tree into view, centered. Reused by mount + reset button.
  const fit = useCallback(() => {
    if (width <= 0 || height <= 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const kRaw = Math.min(size.w / width, size.h / height);
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, kRaw || 1));
    const x = (size.w - width * k) / 2;
    const y = (size.h - height * k) / 2;
    setView({ x, y, k });
  }, [width, height, size.w, size.h]);

  // Auto-fit when the layout changes (new tree) but not on every pan.
  const fittedKey = useRef<string>("");
  useEffect(() => {
    const key = `${laid.length}:${Math.round(width)}:${Math.round(height)}`;
    if (key !== fittedKey.current && size.w > 1) {
      fittedKey.current = key;
      fit();
    }
  }, [laid.length, width, height, size.w, fit]);

  // ---- pan ----
  const onPointerDown = (e: React.PointerEvent) => {
    // Only the canvas background initiates a pan (nodes handle their own click).
    dragRef.current = {
      active: true,
      sx: e.clientX,
      sy: e.clientY,
      ox: view.x,
      oy: view.y,
      moved: false,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  };
  const endPan = (e: React.PointerEvent) => {
    dragRef.current.active = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  // ---- zoom (wheel, anchored at cursor) ----
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
        if (k === v.k) return v;
        // keep the point under the cursor fixed
        const x = mx - ((mx - v.x) * k) / v.k;
        const y = my - ((my - v.y) * k) / v.k;
        return { x, y, k };
      });
    },
    []
  );

  // Native non-passive wheel listener so preventDefault works (React's onWheel
  // is passive by default and can't block page scroll/zoom).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const handleNodeClick = (id: string) => {
    if (dragRef.current.moved) return; // ignore click that ended a drag
    onSelect(id);
  };

  const empty = laid.length === 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 360,
        overflow: "hidden",
        background:
          "radial-gradient(circle at 30% 20%, rgba(99,102,241,0.06), transparent 60%), var(--nx-bg-secondary)",
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        cursor: dragRef.current.active ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
      }}
      onPointerDown={empty ? undefined : onPointerDown}
      onPointerMove={empty ? undefined : onPointerMove}
      onPointerUp={empty ? undefined : endPan}
      onPointerLeave={empty ? undefined : endPan}
    >
      {/* Empty state */}
      {empty && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: C.muted,
            pointerEvents: "none",
          }}
        >
          <div
            className="nx-mono"
            style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}
          >
            No theory tree yet
          </div>
          <div style={{ fontSize: 12 }}>Expand a node to grow the hypothesis tree.</div>
        </div>
      )}

      {!empty && (
        <svg
          width="100%"
          height="100%"
          style={{ display: "block" }}
          role="img"
          aria-label="Theory hypothesis tree"
        >
          <defs>
            <filter id="erebus-node-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
            {/* connectors first so nodes paint on top */}
            <g fill="none">
              {laid.map((l) => {
                const parent = l.node.parent_id ? posById.get(l.node.parent_id) : undefined;
                if (!parent) return null;
                const sel = selectedId === l.node.id || selectedId === parent.node.id;
                const childStyle = styleFor(l.node, false);
                return (
                  <path
                    key={`edge-${l.node.id}`}
                    d={connectorPath(parent.x, parent.y, l.x, l.y)}
                    stroke={sel ? childStyle.stroke : C.border}
                    strokeOpacity={sel ? 0.9 : 0.55}
                    strokeWidth={sel ? 2 : 1.5}
                  />
                );
              })}
            </g>

            {/* nodes */}
            {laid.map((l) => {
              const isRoot = l.depth === 0 && !l.node.parent_id;
              const s = styleFor(l.node, isRoot);
              const selected = selectedId === l.node.id;
              const label = truncate(
                l.node.hypothesis || l.node.key_insight || l.node.content || "(untitled)",
                40
              );
              return (
                <g
                  key={l.node.id}
                  transform={`translate(${l.x}, ${l.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => handleNodeClick(l.node.id)}
                  role="button"
                  aria-label={l.node.hypothesis || "node"}
                  aria-pressed={selected}
                >
                  {/* selection ring */}
                  {selected && (
                    <rect
                      x={-4}
                      y={-4}
                      width={NODE_W + 8}
                      height={NODE_H + 8}
                      rx={12}
                      fill="none"
                      stroke={s.stroke}
                      strokeWidth={2.5}
                      opacity={0.95}
                    />
                  )}

                  {/* card body */}
                  <rect
                    x={0}
                    y={0}
                    width={NODE_W}
                    height={NODE_H}
                    rx={9}
                    fill={C.card}
                    stroke={s.stroke}
                    strokeWidth={selected ? 2 : 1.5}
                    strokeDasharray={s.dashed ? "5 4" : undefined}
                    filter={s.glow ? "url(#erebus-node-glow)" : undefined}
                    opacity={l.node.evidence_status === "disconfirmed" ? 0.85 : 1}
                  />

                  {/* left accent stripe = the node's primary color */}
                  <rect x={0} y={0} width={5} height={NODE_H} rx={2.5} fill={s.fill} />

                  {/* status dot top-right */}
                  <circle cx={NODE_W - 11} cy={11} r={3.5} fill={s.fill} />
                  {l.node.shadow_tagged && (
                    <circle cx={NODE_W - 22} cy={11} r={3} fill={C.muted} />
                  )}

                  {/* depth chip */}
                  <text
                    x={12}
                    y={15}
                    fontSize={8}
                    fontFamily="ui-monospace, monospace"
                    fill={C.muted}
                    letterSpacing="0.06em"
                  >
                    {isRoot ? "ROOT" : `D${l.node.depth ?? l.depth}`}
                    {l.node.explored_by === "erebus" ? " · EREBUS" : " · YOU"}
                  </text>

                  {/* hypothesis text */}
                  <text
                    x={12}
                    y={33}
                    fontSize={11}
                    fontWeight={600}
                    fill={C.text}
                    style={{ pointerEvents: "none" }}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {/* ---- overlay: zoom controls + reset ---- */}
      {!empty && (
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span
            className="nx-mono"
            style={{
              fontSize: 10,
              color: C.muted,
              padding: "3px 7px",
              borderRadius: 6,
              background: "var(--nx-bg-elevated)",
              border: `1px solid ${C.border}`,
            }}
          >
            {Math.round(view.k * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setView((v) => zoomCentered(v, size, 1.2))}
            style={ctrlBtnStyle}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setView((v) => zoomCentered(v, size, 1 / 1.2))}
            style={ctrlBtnStyle}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={fit}
            style={{ ...ctrlBtnStyle, width: "auto", padding: "0 10px", fontSize: 11 }}
            aria-label="Reset view"
          >
            Reset
          </button>
        </div>
      )}

      {/* ---- overlay: legend ---- */}
      {!empty && (
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: 10,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            padding: "7px 11px",
            borderRadius: 8,
            background: "rgba(21,21,31,0.82)",
            backdropFilter: "blur(6px)",
            border: `1px solid ${C.border}`,
            fontSize: 10,
            color: C.muted,
          }}
        >
          <LegendItem color={C.indigoLight} label="You" />
          <LegendItem color={C.amber} label="EREBUS" />
          <LegendItem color={C.green} label="Confirmed" />
          <LegendItem color={C.yellow} label="Partial" />
          <LegendItem color={C.red} label="Disconfirmed" dashed />
        </div>
      )}

      {/* ---- overlay: hint ---- */}
      {!empty && (
        <div
          style={{
            position: "absolute",
            bottom: 10,
            right: 10,
            fontSize: 10,
            color: C.muted,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span className="nx-kbd">drag</span>
          <span>pan</span>
          <span className="nx-kbd">scroll</span>
          <span>zoom</span>
        </div>
      )}
    </div>
  );
}

// Zoom toward the center of the viewport (for the +/− buttons).
function zoomCentered(
  v: { x: number; y: number; k: number },
  size: { w: number; h: number },
  factor: number
) {
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
  if (k === v.k) return v;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const x = cx - ((cx - v.x) * k) / v.k;
  const y = cy - ((cy - v.y) * k) / v.k;
  return { x, y, k };
}

const ctrlBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 6,
  background: "var(--nx-bg-elevated)",
  border: "1px solid var(--nx-border)",
  color: "var(--nx-text-secondary)",
  fontSize: 15,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: "ui-monospace, monospace",
};

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: dashed ? "transparent" : color,
          border: dashed ? `1.5px dashed ${color}` : `1px solid ${color}`,
          boxShadow: dashed ? "none" : `0 0 5px ${color}66`,
        }}
      />
      <span>{label}</span>
    </span>
  );
}
