// ============================================================================
// Content Studio — Phase 11. Step 3: render a short-form video via Remotion.
//
// Intended composition ("ErebusShort"): EREBUS narration (the synthesized mp3)
// plays over branded motion graphics — a dark void with the forecast tree
// "greening" as confirming indicators animate in, the question + outcome as
// kinetic typography, and a branded intro/outro card. Portrait 1080x1920 for
// Shorts / TikTok / Reels.
//
// Remotion is heavy and optional: we NEVER hard-depend on it. We dynamically
// import @remotion/bundler + @remotion/renderer inside try/catch. If either is
// missing (the common case), we degrade gracefully and report it. Fully
// offline-resilient — this function never throws.
// ============================================================================
import { eq } from "drizzle-orm";
import { db, contentItems } from "@erebus/db";

export interface RenderResult {
  rendered: boolean;
  videoPath?: string;
  note?: string;
}

// Attempt a guarded Remotion render for a content item. Returns
// { rendered:false, note } when Remotion is unavailable or anything fails.
export async function renderVideo(contentId: string): Promise<RenderResult> {
  // Pull the content row so a real render would have the script/audio to mount.
  const [item] = await db
    .select()
    .from(contentItems)
    .where(eq(contentItems.id, contentId))
    .limit(1);
  if (!item) return { rendered: false, note: "content item not found" };

  let bundler: unknown;
  let renderer: unknown;
  try {
    // Indirected specifiers so bundlers/TS don't try to resolve the optional
    // deps at build time; failure here is expected when Remotion isn't installed.
    bundler = await import(/* @vite-ignore */ "@remotion/bundler" as string).catch(() => null);
    renderer = await import(/* @vite-ignore */ "@remotion/renderer" as string).catch(() => null);
  } catch {
    bundler = null;
    renderer = null;
  }

  if (!bundler || !renderer) {
    return { rendered: false, note: "Remotion not installed" };
  }

  // Remotion is present. A full pipeline would:
  //   1. bundle the Remotion entry that defines the "ErebusShort" composition,
  //   2. selectComposition() with inputProps { script, audioUrl, question, outcome },
  //   3. renderMedia() to an mp4 (H.264) under ./out/<contentId>.mp4.
  // We guard the whole thing; any failure degrades to rendered:false.
  try {
    // The concrete bundle/render wiring is intentionally deferred until the
    // Remotion entry composition lands; we report availability without
    // assuming a specific Remotion API surface/version here.
    return {
      rendered: false,
      note: "Remotion available; ErebusShort composition entry not yet wired",
    };
  } catch (e) {
    return { rendered: false, note: `Remotion render failed: ${(e as Error).message}` };
  }
}
