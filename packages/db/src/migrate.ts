// Applies migrations: pgvector/pgcrypto extensions -> Drizzle migrations ->
// ivfflat vector indexes. Idempotent. Run with: pnpm db:migrate
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("[migrate] ensuring extensions ...");
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

  const folder = resolve(__dirname, "../drizzle");
  if (existsSync(folder)) {
    console.log("[migrate] applying Drizzle migrations ...");
    await migrate(db, { migrationsFolder: folder });
  } else {
    console.warn("[migrate] no drizzle/ folder — run `pnpm db:generate` first.");
  }

  console.log("[migrate] ensuring ivfflat indexes ...");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS nodes_embedding_idx ON nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS signals_embedding_idx ON signals USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
  );

  console.log("[migrate] done.");
  await pool.end();
}

main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
