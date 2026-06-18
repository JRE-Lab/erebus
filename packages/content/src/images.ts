// Content Studio step 2: generate a cinematic image per scene (OpenAI images).
// Pause-guarded (no spend while paused) and offline-safe (no key -> no images).
import { eq } from "drizzle-orm";
import { db, contentItems, isPaused } from "@erebus/db";
import { saveFile } from "./storage.js";
import type { Scene } from "./script.js";

const STYLE =
  " — cinematic, dramatic lighting, dark intelligence/geopolitical aesthetic, photoreal, vertical composition, no text, no watermark";

// gpt-image-1 is OpenAI's current image model (dall-e-3 is unavailable to
// project-scoped keys). Portrait size is 1024x1536; it always returns b64_json.
// Override via OPENAI_IMAGE_MODEL / OPENAI_IMAGE_SIZE / OPENAI_IMAGE_QUALITY.
async function genImage(prompt: string): Promise<Buffer | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const body: Record<string, unknown> = {
    model,
    prompt: prompt.slice(0, 900) + STYLE,
    size: process.env.OPENAI_IMAGE_SIZE || "1024x1536",
    n: 1,
  };
  // dall-e-* uses quality standard|hd; gpt-image-1 uses low|medium|high.
  if (model.startsWith("gpt-image")) body.quality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.warn("[content] image gen failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return null;
  }
  const j = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const d = j.data?.[0];
  if (d?.b64_json) return Buffer.from(d.b64_json, "base64");
  if (d?.url) {
    const img = await fetch(d.url);
    return Buffer.from(await img.arrayBuffer());
  }
  return null;
}

export async function generateImages(contentId: string): Promise<{ images: number; cost: number }> {
  if (await isPaused()) return { images: 0, cost: 0 };
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentId)).limit(1);
  if (!item) return { images: 0, cost: 0 };

  const data = (item.data ?? {}) as { hook?: string; scenes?: Scene[] };
  const scenes = data.scenes ?? [];
  let made = 0;

  for (let i = 0; i < scenes.length; i++) {
    try {
      const buf = await genImage(scenes[i]!.imagePrompt || scenes[i]!.narration);
      if (buf) {
        scenes[i]!.image = await saveFile(`${contentId}-s${i}.png`, buf);
        made++;
      }
    } catch (e) {
      console.warn("[content] scene image error:", (e as Error).message);
    }
  }

  const status = made > 0 ? "visualized" : item.status;
  await db.update(contentItems).set({ data: { ...data, scenes } as object, status }).where(eq(contentItems.id, contentId));
  // gpt-image-1 medium 1024x1536 ≈ $0.06/image (rough — used for cost display only).
  return { images: made, cost: made * 0.06 };
}
