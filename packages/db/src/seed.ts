// Loads root forecasts from seeds/*.yaml into the nodes table. Idempotent.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import { nodes } from "./schema.js";
import { embed } from "./embeddings.js";
import { toVector } from "./vector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedNode {
  id: string;
  question: string;
  outcome: string;
  indicators?: string[];
  falsifiers?: string[];
  horizon?: string;
  domains?: string[];
}

async function main() {
  const seedsDir = resolve(__dirname, "../../../seeds");
  if (!existsSync(seedsDir)) {
    console.warn("[seed] no seeds/ dir; nothing to load.");
    await pool.end();
    return;
  }
  const files = readdirSync(seedsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  let count = 0;
  for (const file of files) {
    const docs = parse(readFileSync(join(seedsDir, file), "utf-8")) as SeedNode[];
    for (const s of docs ?? []) {
      if (!s?.id || !s.question || !s.outcome) continue;
      const emb = await embed(`${s.question}\n${s.outcome}`);
      await db
        .insert(nodes)
        .values({
          id: s.id,
          question: s.question,
          outcome: s.outcome,
          indicators: s.indicators ?? [],
          falsifiers: s.falsifiers ?? [],
          horizon: s.horizon ? new Date(s.horizon) : null,
          domains: s.domains ?? [],
          embedding: sql.raw(`'${toVector(emb)}'::vector`),
        })
        .onConflictDoNothing();
      count++;
    }
  }
  console.log(`[seed] processed ${count} root forecast(s).`);
  await pool.end();
}

main().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
