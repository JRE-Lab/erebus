// Key/value app settings (autonomous toggle, etc.).
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { settings } from "./schema.js";

export async function getSetting<T = unknown>(key: string, fallback: T): Promise<T> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as object, updatedAt: new Date() } });
}

// Global pause kill-switch. Cached ~4s so the hot path (every LLM call / embed)
// doesn't hit the DB each time; pause/resume propagates within a few seconds to
// both the web and worker processes.
let _pauseCache = { on: false, t: 0 };
export async function isPaused(): Promise<boolean> {
  const now = Date.now();
  if (now - _pauseCache.t < 4000) return _pauseCache.on;
  try {
    const s = await getSetting<{ on: boolean }>("paused", { on: false });
    _pauseCache = { on: Boolean(s.on), t: now };
  } catch {
    /* keep last known value on error */
  }
  return _pauseCache.on;
}

export async function setPaused(on: boolean): Promise<void> {
  await setSetting("paused", { on });
  _pauseCache = { on, t: Date.now() };
}
