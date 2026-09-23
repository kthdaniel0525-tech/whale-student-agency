import "dotenv/config";
process.env.EMBEDDING_ALLOW_DOWNLOAD = "true";
const { prepareEmbeddingModel } = await import("../server/documents/embeddings");
const { RAG_EMBEDDING } = await import("../server/ai/config");
try {
  await prepareEmbeddingModel();
  console.info(JSON.stringify({ event: "embedding-cache-ready", dimensions: RAG_EMBEDDING.dimensions }));
} catch {
  console.error(JSON.stringify({ event: "embedding-cache-preparation-failed" }));
  process.exitCode = 1;
}
