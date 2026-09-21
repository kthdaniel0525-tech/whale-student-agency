import "server-only";
import { AIError } from "../errors";
import type { AIEmbeddingProvider } from "../types";
import { trackEmbeddingProvider, type UsageTrackingOptions } from "../usage/tracking";
import { executeReliable, oneResult, type ReliabilityOptions } from "./executor";
export type EmbeddingEndpoint = {
  provider: string; model: string; dimensions: number; outputModel?: string;
  /** Exact model revision + preprocessing/pooling/normalization identity.
   * Equal dimensions alone never establish vector-space compatibility. */
  spaceId: string; create: () => AIEmbeddingProvider; tracking?: Omit<UsageTrackingOptions, "provider" | "embeddingModel">;
};
export function createReliableEmbeddingProvider(primary: EmbeddingEndpoint, fallbacks: EmbeddingEndpoint[] = [], options: ReliabilityOptions = {}): AIEmbeddingProvider {
  const compatible = [primary, ...fallbacks.filter(c => c.dimensions === primary.dimensions && c.spaceId === primary.spaceId)];
  const instances = new Map<EmbeddingEndpoint, AIEmbeddingProvider>();
  return { async generateEmbedding(request) {
    if (request.model && request.model !== primary.model || request.dimensions !== undefined && request.dimensions !== primary.dimensions) throw new AIError("INVALID_REQUEST");
    return oneResult(executeReliable({ candidates: compatible, signal: request.signal, usageContext: request.usageContext, operation: "embedding",
      invoke: async function* (candidate, attempt) {
        if (!instances.has(candidate)) instances.set(candidate, trackEmbeddingProvider(candidate.create(), { ...candidate.tracking, provider: candidate.provider, embeddingModel: candidate.model }));
        const response = await instances.get(candidate)!.generateEmbedding({ ...request, ...attempt, model: candidate.model, dimensions: candidate.dimensions });
        if (response.vector.length !== primary.dimensions || response.vector.some(v => !Number.isFinite(v)) || Math.hypot(...response.vector) < 1e-8) throw new AIError("INVALID_RESPONSE", response.usage, response.model);
        yield { ...response, model: primary.outputModel ?? primary.model };
      },
    }, options));
  } };
}
