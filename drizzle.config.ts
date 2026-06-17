import type { Config } from "drizzle-kit";

// Run from the repo root (see root "db:generate" script). Forward-slash
// relative paths keep drizzle-kit's globber happy on Windows.
export default {
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://erebus:erebus@localhost:5432/erebus",
  },
  strict: true,
} satisfies Config;
