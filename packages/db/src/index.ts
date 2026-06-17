export { pool, query, queryOne, healthcheck } from "./client.js";
export { toVectorLiteral, similaritySearch } from "./pgvector.js";
export type { SimilarRow } from "./pgvector.js";
export { embed, embeddingDim } from "./embeddings.js";
