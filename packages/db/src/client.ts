import pg from "pg";

// Single shared pool. DATABASE_URL must be set (see .env.example).
const connectionString =
  process.env.DATABASE_URL || "postgresql://erebus:erebus@localhost:5432/erebus";

export const pool = new pg.Pool({
  connectionString,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

pool.on("connect", (client) => {
  // pgvector + UTF-8 safety on every new connection.
  client.query("SET client_encoding = 'UTF8'").catch(() => {});
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query(text, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function healthcheck(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
