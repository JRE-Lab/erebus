// ============================================================================
// Content Studio — Phase 11. Step 2: text -> ElevenLabs TTS mp3.
// EREBUS speaks in a distinct synthetic voice (the AI personality). No SDK —
// plain fetch. Offline (no ELEVENLABS_API_KEY) returns null and notes it.
// ============================================================================
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ELEVENLABS_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
// A widely-available default voice id; override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// Synthesize `text` to an mp3 at `outPath`. Returns the path on success,
// or null when offline / on any failure (never throws — resilience first).
export async function synthesize(text: string, outPath: string): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log("[content/voice] ELEVENLABS_API_KEY not set — skipping TTS (offline).");
    return null;
  }
  if (!text || !text.trim()) {
    console.log("[content/voice] empty text — skipping TTS.");
    return null;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

  try {
    const res = await fetch(`${ELEVENLABS_TTS_BASE}/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      console.log(`[content/voice] ElevenLabs HTTP ${res.status} — returning null.`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    console.log(`[content/voice] wrote ${buf.length} bytes -> ${outPath}`);
    return outPath;
  } catch (e) {
    console.log(`[content/voice] TTS failed (${(e as Error).message}) — returning null.`);
    return null;
  }
}
