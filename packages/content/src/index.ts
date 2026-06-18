// ============================================================================
// @erebus/content — Phase 11 profit engine. Pipeline a corroborated node walks
// to become a publishable short:
//   script (Opus) -> images (OpenAI) -> voice (ElevenLabs) -> video (ffmpeg)
// Every stage is independently callable (Studio UI drives them step by step),
// pause-guarded, and offline-safe (missing key/tool -> that stage is skipped).
// ============================================================================
import { eq } from "drizzle-orm";
import { db, contentItems, recordEvent } from "@erebus/db";
import { generateScript } from "./script.js";
import { generateImages } from "./images.js";
import { synthesizeVoice } from "./voice.js";
import { assembleVideo } from "./video.js";

export { generateScript } from "./script.js";
export type { Scene, ScriptShape, GenerateScriptResult } from "./script.js";
export { generateImages } from "./images.js";
export { synthesizeVoice, ttsBytes } from "./voice.js";
export { assembleVideo } from "./video.js";
export { CONTENT_DIR, filePath } from "./storage.js";

export type ContentItem = typeof contentItems.$inferSelect;

// Full pipeline (best-effort each stage). Used by POST /api/content/:nodeId.
export async function nodeToContent(nodeId: string): Promise<ContentItem> {
  const { contentId } = await generateScript(nodeId);
  try { await generateImages(contentId); } catch (e) { console.warn("[content] images:", (e as Error).message); }
  try { await synthesizeVoice(contentId); } catch (e) { console.warn("[content] voice:", (e as Error).message); }
  try { await assembleVideo(contentId); } catch (e) { console.warn("[content] video:", (e as Error).message); }

  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentId)).limit(1);
  await recordEvent({
    nodeId,
    kind: "created",
    causeType: "job",
    after: { contentId, status: item?.status, hasAudio: Boolean(item?.audioUrl), hasVideo: Boolean(item?.videoUrl) },
  });
  return item!;
}
