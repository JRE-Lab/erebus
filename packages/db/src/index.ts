export { db, pool, healthcheck } from "./client.js";
export { schema } from "./schema.js";
export * from "./schema.js";
export { embed, EMBEDDING_DIM } from "./embeddings.js";
export { toVector, nearest } from "./vector.js";
export type { Neighbor } from "./vector.js";
export { recordEvent } from "./provenance.js";
export type { EventInput } from "./provenance.js";
export { getSetting, setSetting } from "./settings.js";
