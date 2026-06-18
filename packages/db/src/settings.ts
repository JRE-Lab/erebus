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
