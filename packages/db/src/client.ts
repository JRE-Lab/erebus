import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";

const connectionString =
  process.env.DATABASE_URL || "postgresql://erebus:erebus@localhost:5432/erebus";

export const pool = new pg.Pool({
  connectionString,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on("error", (e) => console.error("[db] idle error:", e.message));

export const db = drizzle(pool, { schema });

export async function healthcheck(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
