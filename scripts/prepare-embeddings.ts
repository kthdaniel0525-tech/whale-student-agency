import "dotenv/config";
process.env.EMBEDDING_ALLOW_DOWNLOAD = "true";
const { embeddingProvider } = await import("../server/documents/embeddings");
const vector = await embeddingProvider.generateEmbedding(
  "Prepare the private academic document search model.",
);
console.log(
  `Embedding model ready: ${vector.length} dimensions. Future runs use the local cache.`,
);
