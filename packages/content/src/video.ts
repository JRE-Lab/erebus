// Content Studio step 4: assemble scene images + narration audio into a
// vertical (1080x1920) MP4 with ffmpeg. No LLM spend (no pause guard needed).
// Degrades gracefully: no ffmpeg / no images -> returns a note, never throws.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db, contentItems } from "@erebus/db";
import { CONTENT_DIR, filePath } from "./storage.js";
import type { Scene } from "./script.js";

const exec = promisify(execFile);

async function have(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function audioDuration(path: string): Promise<number> {
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

function nameOf(url: string | null | undefined): string {
  return (url || "").split("/").pop() || "";
}

export async function assembleVideo(contentId: string): Promise<{ videoUrl: string | null; note?: string }> {
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentId)).limit(1);
  if (!item) return { videoUrl: null, note: "content not found" };
  if (!(await have("ffmpeg"))) return { videoUrl: null, note: "ffmpeg not installed" };

  const data = (item.data ?? {}) as { scenes?: Scene[] };
  const imgs = (data.scenes ?? [])
    .map((s) => filePath(nameOf(s.image)))
    .filter((p) => p && existsSync(p));
  if (!imgs.length) return { videoUrl: null, note: "no scene images — generate images first" };

  await mkdir(CONTENT_DIR, { recursive: true });

  const audioPath = item.audioUrl ? filePath(nameOf(item.audioUrl)) : "";
  const hasAudio = Boolean(audioPath) && existsSync(audioPath);
  const dur = hasAudio ? await audioDuration(audioPath) : 0;
  const per = hasAudio && dur > 0 ? Math.max(2, dur / imgs.length) : 5;

  // concat demuxer list (last frame repeated — demuxer requirement)
  const listPath = resolve(CONTENT_DIR, `${contentId}.txt`);
  let list = "";
  for (const p of imgs) list += `file '${p}'\nduration ${per.toFixed(2)}\n`;
  list += `file '${imgs[imgs.length - 1]}'\n`;
  await writeFile(listPath, list);

  const vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p";
  const silent = resolve(CONTENT_DIR, `${contentId}-silent.mp4`);
  const out = resolve(CONTENT_DIR, `${contentId}.mp4`);

  try {
    await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-vf", vf, "-r", "30", silent], { maxBuffer: 1 << 26 });
    if (hasAudio) {
      await exec("ffmpeg", ["-y", "-i", silent, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", out], { maxBuffer: 1 << 26 });
    } else {
      await exec("ffmpeg", ["-y", "-i", silent, "-c", "copy", out], { maxBuffer: 1 << 26 });
    }
  } catch (e) {
    return { videoUrl: null, note: `ffmpeg failed: ${(e as Error).message.slice(0, 120)}` };
  }

  const videoUrl = `/api/content/file/${contentId}.mp4`;
  await db.update(contentItems).set({ videoUrl, status: "rendered" }).where(eq(contentItems.id, contentId));
  return { videoUrl };
}
