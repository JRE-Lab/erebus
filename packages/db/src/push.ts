// Applies schema.sql to the database. Idempotent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = resolve(__dirname, "../schema.sql");
  const sql = readFileSync(schemaPath, "utf-8");
  console.log("[db:push] applying schema.sql ...");
  await pool.query(sql);
  console.log("[db:push] done.");
  await pool.end();
}

main().catch((err) => {
  console.error("[db:push] failed:", err);
  process.exit(1);
});
