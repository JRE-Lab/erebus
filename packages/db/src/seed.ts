// Seeds default ingestion sources. Safe to run repeatedly.
import { pool, query } from "./client.js";
import { DEFAULT_SOURCES } from "@erebus/core";

async function main() {
  console.log("[db:seed] seeding default sources ...");
  for (const s of DEFAULT_SOURCES) {
    await query(
      `INSERT INTO sources (name, url, tier, type, enabled)
       VALUES ($1, $2, $3, 'rss', true)
       ON CONFLICT (url) DO NOTHING`,
      [s.name, s.url, s.tier]
    );
  }
  const rows = await query<{ count: string }>("SELECT count(*)::text FROM sources");
  console.log(`[db:seed] sources in table: ${rows[0]?.count ?? "0"}`);
  await pool.end();
}

main().catch((err) => {
  console.error("[db:seed] failed:", err);
  process.exit(1);
});
