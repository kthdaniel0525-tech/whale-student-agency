import "server-only";
import path from "node:path";
import { z } from "zod";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { AIEmbeddingProvider } from "@/server/ai/types";
import { RAG_EMBEDDING } from "@/server/ai/config";
import { AIError } from "@/server/ai/errors";
import { documentConfig, DocumentError } from "../config";
export const EMBEDDING_DIMENSIONS = RAG_EMBEDDING.dimensions;
export interface EmbeddingProvider {
  readonly id: string;
  generateEmbedding(text: string): Promise<number[]>;
}
export function validateEmbedding(value: unknown): number[] {
  const vector = z
    .array(z.number().finite())
    .length(EMBEDDING_DIMENSIONS)
    .parse(value);
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm < 1e-8)
    throw new DocumentError(
      "The embedding model returned an invalid vector.",
      503,
    );
  return vector.map((v) => v / norm);
}
const { revision } = RAG_EMBEDDING;
let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;
async function model() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { AutoTokenizer, AutoModel, FeatureExtractionPipeline, env } =
        await import("@huggingface/transformers");
      env.cacheDir = documentConfig().modelCache;
      env.allowRemoteModels = process.env.EMBEDDING_ALLOW_DOWNLOAD === "true";
      const modelPath = env.allowRemoteModels
        ? RAG_EMBEDDING.model
        : path.join(env.cacheDir, RAG_EMBEDDING.model, revision);
      // Explicit components avoid pipeline()'s unpinned remote file discovery in v4.
      const options = { revision, local_files_only: !env.allowRemoteModels };
      const [tokenizer, network] = await Promise.all([
        AutoTokenizer.from_pretrained(modelPath, options),
        AutoModel.from_pretrained(modelPath, {
          ...options,
          dtype: "q8",
          device: "cpu",
        }),
      ]);
      return new FeatureExtractionPipeline({
        task: "feature-extraction",
        tokenizer,
        model: network,
      });
    })().catch((e) => {
      pipelinePromise = undefined;
      throw e;
    });
  }
  return pipelinePromise;
}
export const localEmbeddingProvider: AIEmbeddingProvider = {
  async generateEmbedding(request) {
    if (request.signal?.aborted) throw new AIError("CANCELLED");
    if (
      (request.model && request.model !== RAG_EMBEDDING.model) ||
      (request.dimensions !== undefined &&
        request.dimensions !== EMBEDDING_DIMENSIONS)
    )
      throw new AIError("INVALID_REQUEST");
    const text = request.input;
    const extractor = await model();
    const tokens = extractor.tokenizer.encode(text, {
      add_special_tokens: false,
    });
    if (!tokens.length) throw new DocumentError("Enter text to search.");
    // MiniLM has a short context window. Embed every token instead of silently truncating long chunks.
    const sum = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (let offset = 0; offset < tokens.length; offset += 200) {
      if (request.signal?.aborted) throw new AIError("CANCELLED");
      const window = tokens.slice(offset, offset + 200);
      const input = extractor.tokenizer.decode(window, {
        skip_special_tokens: true,
      });
      const output = await extractor(input, {
        pooling: "mean",
        normalize: true,
      });
      const vector = validateEmbedding(Array.from(output.data));
      for (let i = 0; i < sum.length; i++) sum[i] += vector[i] * window.length;
    }
    return { model: RAG_EMBEDDING.id, vector: validateEmbedding(sum) };
  },
};

// Preserve the existing RAG API and persisted model ID; inference has one implementation.
export const embeddingProvider: EmbeddingProvider = {
  id: RAG_EMBEDDING.id,
  async generateEmbedding(text) {
    return (await localEmbeddingProvider.generateEmbedding({ input: text }))
      .vector;
  },
};
