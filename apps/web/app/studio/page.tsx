"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NodeRow } from "@erebus/core/client";
import {
  fetchNodes,
  fetchContent,
  generateContentScript,
  generateContentImages,
  generateContentVoice,
  generateContentVideo,
  makeContent,
  type ContentItem,
} from "@/lib/api";

// ----------------------------------------------------------------------------
// Content Studio — the profit engine. Corroborated / launch-point nodes are
// solid ground; walk one through the pipeline step by step:
//   script (Opus) -> images (DALL·E) -> voice (ElevenLabs) -> video (ffmpeg)
// Each stage is independently runnable, pause-guarded server-side, and degrades
// gracefully when a key/tool is missing. Resilient to empty / offline data.
// ----------------------------------------------------------------------------

const LAUNCHABLE = new Set(["corroborated", "resolved_true"]);

// status -> how far down the pipeline an item has progressed.
const STAGE_ORDER = ["draft", "scripted", "visualized", "voiced", "rendered", "published"];
const stageIndex = (s?: string | null) => Math.max(0, STAGE_ORDER.indexOf(s ?? "draft"));

type Step = "script" | "images" | "voice" | "video" | "full";

export default function StudioPage() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Step | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [n, c] = await Promise.all([
      fetchNodes().catch(() => [] as NodeRow[]),
      fetchContent().catch(() => [] as ContentItem[]),
    ]);
    setNodes(Array.isArray(n) ? n : []);
    setContent(Array.isArray(c) ? c : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 12000);
    return () => clearInterval(id);
  }, [load]);

  const launchPoints = useMemo(
    () => nodes.filter((n) => LAUNCHABLE.has(n.state) || n.isLaunchPoint),
    [nodes]
  );
  const active = useMemo(() => content.find((c) => c.id === activeId) ?? null, [content, activeId]);
  const activeNode = useMemo(
    () => (active?.nodeId ? nodes.find((n) => n.id === active.nodeId) ?? null : null),
    [active, nodes]
  );

  const run = async (step: Step, fn: () => Promise<unknown>, ok: string) => {
    setBusy(step);
    setNote(null);
    try {
      await fn();
      await load();
      setNote(ok);
    } catch (e) {
      setNote(`error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onScript = (nodeId: string) =>
    run(
      "script",
      async () => {
        const r = await generateContentScript(nodeId);
        setActiveId(r.contentId);
        return r;
      },
      "Script + storyboard generated."
    );

  const onFull = (nodeId: string) =>
    run(
      "full",
      async () => {
        const r = await makeContent(nodeId);
        setActiveId(r.id);
        return r;
      },
      "Full pipeline complete."
    );

  const onImages = (id: string) =>
    run("images", async () => {
      const r = await generateContentImages(id);
      if (!r.images) throw new Error("no images produced — OpenAI image key missing or paused");
    }, "Scene images generated.");

  const onVoice = (id: string) =>
    run("voice", async () => {
      const r = await generateContentVoice(id);
      if (!r.audioUrl) throw new Error("no audio — ElevenLabs key missing or paused");
    }, "Narration generated.");

  const onVideo = (id: string) =>
    run("video", async () => {
      const r = await generateContentVideo(id);
      if (!r.videoUrl) throw new Error(r.note || "video not assembled");
    }, "Video assembled.");

  return (
    <div className="nx-scroll h-full">
      <div className="mx-auto max-w-7xl space-y-5 p-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-nx-text-primary">Content Studio</h1>
            <p className="mt-1 text-sm text-nx-text-secondary">
              Corroborated theses are solid ground. Walk the green through script → images → voice →
              video — the content that funds the system.
            </p>
          </div>
          {note && (
            <div className="shrink-0 rounded-md border border-nx-border bg-nx-bg-elevated px-3 py-1.5 text-xs text-nx-text-secondary">
              {note}
            </div>
          )}
        </header>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
          {/* ---- left rail: launch points + queue ---- */}
          <div className="space-y-5">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="nx-dot" style={{ background: "var(--nx-green)" }} />
                <h2 className="text-sm font-semibold text-nx-text-primary">
                  Launch points ({launchPoints.length})
                </h2>
              </div>
              {loading && nodes.length === 0 ? (
                <p className="text-sm text-nx-text-muted">Loading…</p>
              ) : launchPoints.length === 0 ? (
                <div className="nx-card p-4 text-center">
                  <p className="text-xs text-nx-text-secondary">No corroborated nodes yet.</p>
                  <p className="mt-1 text-[11px] text-nx-text-muted">
                    As reality greens the tree, branches appear here ready to publish.
                  </p>
                </div>
              ) : (
                <div className="nx-scroll max-h-[40vh] space-y-2 overflow-y-auto pr-1">
                  {launchPoints.map((n) => (
                    <div
                      key={n.id}
                      className="nx-card flex flex-col gap-2 border-l-2 border-l-nx-green p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="nx-mono text-[10px] text-nx-text-muted">{n.id.slice(0, 8)}</span>
                        <span className="nx-chip nx-chip-green">{n.state.replace("_", " ")}</span>
                      </div>
                      <p className="line-clamp-2 text-xs font-medium text-nx-text-primary">
                        {n.question}
                      </p>
                      <div className="mt-auto flex gap-2">
                        <button
                          className="nx-btn nx-btn-primary flex-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => onScript(n.id)}
                        >
                          {busy === "script" ? "…" : "Script"}
                        </button>
                        <button
                          className="nx-btn flex-1 text-xs"
                          disabled={busy !== null}
                          onClick={() => onFull(n.id)}
                          title="Run the whole pipeline (best-effort)"
                        >
                          {busy === "full" ? "…" : "Full run"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-nx-text-primary">
                Queue ({content.length})
              </h2>
              {content.length === 0 ? (
                <div className="nx-card p-4 text-center text-[11px] text-nx-text-muted">
                  Empty. Generate a script from a launch point.
                </div>
              ) : (
                <div className="nx-scroll max-h-[40vh] space-y-1.5 overflow-y-auto pr-1">
                  {content.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setActiveId(c.id)}
                      className={`nx-card w-full p-2.5 text-left transition ${
                        c.id === activeId ? "ring-1 ring-nx-accent" : "hover:bg-nx-bg-elevated"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="line-clamp-1 text-xs font-medium text-nx-text-primary">
                          {c.title ?? c.script?.slice(0, 40) ?? "untitled"}
                        </span>
                        <StatusChip status={c.status} />
                      </div>
                      <span className="nx-mono text-[10px] text-nx-text-muted">
                        {fmtDate(c.createdAt)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* ---- main: pipeline workspace ---- */}
          <div>
            {!active ? (
              <div className="nx-card flex h-full min-h-[50vh] items-center justify-center p-8 text-center">
                <div>
                  <p className="text-sm text-nx-text-secondary">Select a launch point or queue item.</p>
                  <p className="mt-1 text-xs text-nx-text-muted">
                    Generate a script, then add images, voice, and video.
                  </p>
                </div>
              </div>
            ) : (
              <Workspace
                item={active}
                node={activeNode}
                busy={busy}
                onImages={() => onImages(active.id)}
                onVoice={() => onVoice(active.id)}
                onVideo={() => onVideo(active.id)}
                onRescript={() => active.nodeId && onScript(active.nodeId)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Workspace({
  item,
  node,
  busy,
  onImages,
  onVoice,
  onVideo,
  onRescript,
}: {
  item: ContentItem;
  node: NodeRow | null;
  busy: Step | null;
  onImages: () => void;
  onVoice: () => void;
  onVideo: () => void;
  onRescript: () => void;
}) {
  const stage = stageIndex(item.status);
  const scenes = item.data?.scenes ?? [];
  const hasImages = scenes.some((s) => s.image);

  return (
    <div className="space-y-5">
      {/* header + pipeline rail */}
      <div className="nx-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-nx-text-primary">
              {item.title ?? "Untitled short"}
            </h2>
            {node && (
              <p className="mt-0.5 line-clamp-1 text-xs text-nx-text-muted">{node.question}</p>
            )}
          </div>
          <StatusChip status={item.status} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PipeStep label="Script" done={stage >= 1} active={busy === "script"} />
          <Arrow />
          <PipeStep label="Images" done={hasImages} active={busy === "images"} />
          <Arrow />
          <PipeStep label="Voice" done={Boolean(item.audioUrl)} active={busy === "voice"} />
          <Arrow />
          <PipeStep label="Video" done={Boolean(item.videoUrl)} active={busy === "video"} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button className="nx-btn text-xs" disabled={busy !== null || !item.nodeId} onClick={onRescript}>
            {busy === "script" ? "Rewriting…" : "Rewrite script"}
          </button>
          <button className="nx-btn nx-btn-primary text-xs" disabled={busy !== null} onClick={onImages}>
            {busy === "images" ? "Generating…" : hasImages ? "Regenerate images" : "Generate images"}
          </button>
          <button className="nx-btn text-xs" disabled={busy !== null} onClick={onVoice}>
            {busy === "voice" ? "Voicing…" : item.audioUrl ? "Re-voice" : "Generate voice"}
          </button>
          <button className="nx-btn text-xs" disabled={busy !== null || !hasImages} onClick={onVideo}>
            {busy === "video" ? "Assembling…" : item.videoUrl ? "Reassemble video" : "Assemble video"}
          </button>
        </div>
      </div>

      {/* hook + caption */}
      {(item.data?.hook || item.caption) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {item.data?.hook && (
            <div className="nx-card p-3">
              <h3 className="mb-1 text-xs font-semibold text-nx-text-muted">Hook</h3>
              <p className="text-sm text-nx-text-primary">{item.data.hook}</p>
            </div>
          )}
          {item.caption && (
            <div className="nx-card p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-nx-text-muted">Caption</h3>
                <CopyButton text={item.caption} />
              </div>
              <p className="whitespace-pre-wrap text-sm text-nx-text-primary">{item.caption}</p>
            </div>
          )}
        </div>
      )}

      {/* video player */}
      {item.videoUrl && (
        <div className="nx-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-nx-text-muted">Rendered short</h3>
            <a className="nx-btn text-xs" href={item.videoUrl} download>
              Download MP4
            </a>
          </div>
          <video
            src={item.videoUrl}
            controls
            className="mx-auto max-h-[60vh] rounded-md bg-black"
            style={{ aspectRatio: "9 / 16" }}
          />
        </div>
      )}

      {/* audio player (when no video yet) */}
      {item.audioUrl && !item.videoUrl && (
        <div className="nx-card p-3">
          <h3 className="mb-2 text-xs font-semibold text-nx-text-muted">Narration</h3>
          <audio src={item.audioUrl} controls className="w-full" />
        </div>
      )}

      {/* storyboard */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-nx-text-primary">
          Storyboard ({scenes.length} scene{scenes.length === 1 ? "" : "s"})
        </h3>
        {scenes.length === 0 ? (
          <div className="nx-card p-4 text-xs text-nx-text-muted">
            No storyboard yet — generate a script.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scenes.map((s, i) => (
              <div key={i} className="nx-card overflow-hidden">
                <div
                  className="flex items-center justify-center bg-nx-bg-elevated"
                  style={{ aspectRatio: "9 / 16" }}
                >
                  {s.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.image} alt={`scene ${i + 1}`} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[11px] text-nx-text-muted">scene {i + 1}</span>
                  )}
                </div>
                <div className="space-y-1.5 p-2.5">
                  <p className="text-xs leading-snug text-nx-text-primary">{s.narration}</p>
                  <p className="line-clamp-2 text-[10px] italic leading-snug text-nx-text-muted">
                    {s.imagePrompt}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* full script */}
      {item.script && (
        <details className="nx-card p-3">
          <summary className="cursor-pointer text-xs font-semibold text-nx-text-muted">
            Full script
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm text-nx-text-secondary">{item.script}</p>
        </details>
      )}
    </div>
  );
}

function PipeStep({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  return (
    <span
      className={`nx-chip ${active ? "nx-chip-indigo animate-pulse" : done ? "nx-chip-green" : ""}`}
      style={done || active ? undefined : { opacity: 0.55 }}
    >
      {done ? "✓ " : ""}
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="text-nx-text-muted">→</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="nx-btn text-[10px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function StatusChip({ status }: { status?: string | null }) {
  const s = status ?? "draft";
  const cls =
    s === "published" || s === "rendered"
      ? "nx-chip-green"
      : s === "failed"
        ? "nx-chip-red"
        : "nx-chip-indigo";
  return <span className={`nx-chip ${cls}`}>{s}</span>;
}

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
