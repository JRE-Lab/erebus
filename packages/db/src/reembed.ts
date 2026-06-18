// Re-embeds all existing nodes + signals with the CURRENT embedding provider.
// Run after switching EMBEDDING_PROVIDER so old rows share the new vector space.
import { eq, sql } from "drizzle-orm";
import { db, pool } from "./client.js";
import { nodes, signals } from "./schema.js";
import { embed } from "./embeddings.js";
import { toVector } from "./vector.js";

async function main() {
  const ns = await db.select().from(nodes);
  for (const n of ns) {
    const e = await embed(`${n.question}\n${n.outcome}`);
    await db.update(nodes).set({ embedding: sql.raw(`'${toVector(e)}'::vector`) }).where(eq(nodes.id, n.id));
  }
  console.log(`[reembed] nodes: ${ns.length}`);

  const sg = await db.select().from(signals);
  for (const s of sg) {
    const e = await embed(`${s.title ?? ""}\n${s.summary ?? ""}`);
    await db.update(signals).set({ embedding: sql.raw(`'${toVector(e)}'::vector`) }).where(eq(signals.id, s.id));
  }
  console.log(`[reembed] signals: ${sg.length}`);
  await pool.end();
}

main().catch((e) => {
  console.error("[reembed] failed:", e);
  process.exit(1);
});
