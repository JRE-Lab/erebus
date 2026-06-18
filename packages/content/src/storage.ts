// Asset storage for the Content Studio. Files land in a persistent volume
// (CONTENT_DIR, mounted in prod) and are served via /api/content/file/<name>.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CONTENT_DIR = process.env.CONTENT_DIR || resolve(process.cwd(), "content-assets");

export function filePath(name: string): string {
  return resolve(CONTENT_DIR, name);
}

// Persist bytes and return the public URL the web app serves them from.
export async function saveFile(name: string, data: Buffer): Promise<string> {
  await mkdir(CONTENT_DIR, { recursive: true });
  await writeFile(filePath(name), data);
  return `/api/content/file/${name}`;
}
