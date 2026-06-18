// Content Studio step 3: narration -> ElevenLabs TTS mp3 (a distinct EREBUS
// voice). Pause-guarded + offline-safe: no key / paused -> no audio, no throw.
import { eq } from "drizzle-orm";
import { db, contentItems, isPaused } from "@erebus/db";
import { saveFile } from "./storage.js";

const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // override with ELEVENLABS_VOICE_ID

// Low-level: text -> mp3 bytes, or null when unavailable.
export async function ttsBytes(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey || !text?.trim()) return null;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  try {
    const res = await fetch(`${TTS_BASE}/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok) {
      console.warn(`[content/voice] ElevenLabs HTTP ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn(`[content/voice] TTS failed: ${(e as Error).message}`);
    return null;
  }
}

// Synthesize a content item's narration, persist mp3, update audioUrl + status.
export async function synthesizeVoice(contentId: string): Promise<{ audioUrl: string | null }> {
  if (await isPaused()) return { audioUrl: null };
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, contentId)).limit(1);
  if (!item?.script) return { audioUrl: null };

  const buf = await ttsBytes(item.script);
  if (!buf) return { audioUrl: null };

  const audioUrl = await saveFile(`${contentId}.mp3`, buf);
  await db.update(contentItems).set({ audioUrl, status: "voiced" }).where(eq(contentItems.id, contentId));
  return { audioUrl };
}
