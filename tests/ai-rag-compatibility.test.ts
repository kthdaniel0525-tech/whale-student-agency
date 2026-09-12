import { afterEach, expect, it, vi } from "vitest";
import type { AIEmbeddingProvider } from "@/server/ai/types";
import { RAG_EMBEDDING } from "@/server/ai/config";
import {
  embeddingProvider,
  localEmbeddingProvider,
  validateEmbedding,
  EMBEDDING_DIMENSIONS,
} from "@/server/documents/embeddings";
afterEach(() => vi.unstubAllEnvs());

it("preserves existing local RAG vectors and model ID through AIProvider.generateEmbedding", async () => {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  // Unrelated OpenAI settings must not affect existing documents or load their config.
  vi.stubEnv("AI_CHAT_MODEL", "");
  vi.stubEnv("AI_EMBEDDING_DIMENSIONS", "1536");
  vi.stubEnv("EMBEDDING_ALLOW_DOWNLOAD", "false");
  const provider: AIEmbeddingProvider = localEmbeddingProvider;
  const text =
    "The inductive hypothesis assumes the proposition for k, then proves it for k plus one.";
  const response = await provider.generateEmbedding({ input: text });
  const legacy = await embeddingProvider.generateEmbedding(text);
  expect(response.vector).toEqual(legacy);
  expect(response.model).toBe(
    "minilm-l6-v2:751bff37182d3f1213fa05d7196b954e230abad9:q8:token200-weighted-mean:v1",
  );
  expect(embeddingProvider.id).toBe(response.model);
  expect(EMBEDDING_DIMENSIONS).toBe(384);
  expect(legacy).toHaveLength(384);
  expect(validateEmbedding(legacy).every(Number.isFinite)).toBe(true);
}, 30000);

it("rejects incompatible local model or dimensions without changing RAG's model space", async () => {
  await expect(
    localEmbeddingProvider.generateEmbedding({
      input: "proof",
      dimensions: 1536,
    }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    localEmbeddingProvider.generateEmbedding({
      input: "proof",
      model: "another-model",
    }),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    localEmbeddingProvider.generateEmbedding({
      input: "proof",
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(embeddingProvider.id).toBe(RAG_EMBEDDING.id);
});
