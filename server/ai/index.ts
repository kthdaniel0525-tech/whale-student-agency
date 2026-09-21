import "server-only";
import { OpenAIProvider } from "./providers/openai";
import type { AIProvider } from "./types";
import { AIProviderRegistry } from "./registry";
import { getAIConfig } from "./config";
import { createReliableEmbeddingProvider } from "./reliability/embeddings";
import { createRoutedAIProvider } from "./routing/provider";

export type * from "./types";
export { AIError, type AIErrorCode } from "./errors";

export const aiProviderRegistry = new AIProviderRegistry().register({ id: "openai", create: () => new OpenAIProvider() });
let provider: AIProvider | undefined;
export function getAIProvider(): AIProvider {
  if (!provider) {
    const config = getAIConfig();
    const embedding = createReliableEmbeddingProvider({ provider: "openai", model: config.embeddingModel, dimensions: config.embeddingDimensions,
      spaceId: `openai:${config.embeddingModel}:${config.embeddingDimensions}`, create: () => aiProviderRegistry.get("openai") });
    provider = createRoutedAIProvider({ registry: aiProviderRegistry, embeddingProvider: embedding });
  }
  return provider;
}
