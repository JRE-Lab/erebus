// ============================================================================
// @erebus/content — Phase 11 profit engine. Public surface.
//
// nodeToContent(nodeId): the full pipeline a corroborated node walks to become
// a publishable short — script -> voice -> video -> persisted content_items.
// Every stage is independently guarded; the whole thing runs offline (no
// Anthropic key, no ElevenLabs key, no Remotion) without crashing.
// ============================================================================
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db, contentItems, recordEvent } from "@erebus/db";

import { generateScript } from "./script.js";
import { synthesize } from "./voice.js";
import { renderVideo } from "./render.js";

export { generateScript } from "./script.js";
export type { ScriptShape, GenerateScriptResult } from "./script.js";
export { synthesize } from "./voice.js";
export { renderVideo } from "./render.js";
export type { RenderResult } from "./render.js";

// Where generated artifacts land (overridable for the worker / CI).
const OUT_DIR = process.env.CONTENT_OUT_DIR || resolve(process.cwd(), "out", "content");

export type ContentItem = typeof contentItems.$inferSelect;

// Drive a node through the content pipeline and return the persisted item.
export async function nodeToContent(nodeId: string): Promise<ContentItem> {
  // 1) Script (Opus; falls back to a stub script when offline).
  const { contentId, script } = await generateScript(nodeId);

  // 2) Voice (ElevenLabs if key present; null otherwise — never blocks).
  let audioUrl: string | null = null;
  try {
    const audioPath = resolve(OUT_DIR, `${contentId}.mp3`);
    audioUrl = await synthesize(script.script, audioPath);
  } catch (e) {
    console.log(`[content] synthesize threw (${(e as Error).message}) — continuing without audio.`);
    audioUrl = null;
  }

  // 3) Video (guarded Remotion; rendered:false when unavailable — never blocks).
  let videoUrl: string | null = null;
  let renderNote: string | undefined;
  try {
    const r = await renderVideo(contentId);
    if (r.rendered && r.videoPath) videoUrl = r.videoPath;
    renderNote = r.note;
  } catch (e) {
    renderNote = `render threw: ${(e as Error).message}`;
  }

  // 4) Persist artifacts + advance status. "ready" once we have audio or video,
  // otherwise it stays a "draft" (script only).
  const status = audioUrl || videoUrl ? "ready" : "draft";
  const [updated] = await db
    .update(contentItems)
    .set({ audioUrl, videoUrl, status })
    .where(eq(contentItems.id, contentId))
    .returning();

  await recordEvent({
    nodeId,
    kind: "created",
    causeType: "job",
    after: {
      contentId,
      contentStatus: status,
      hasAudio: Boolean(audioUrl),
      hasVideo: Boolean(videoUrl),
      renderNote: renderNote ?? null,
    },
  });

  return updated!;
}
