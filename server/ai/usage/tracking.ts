import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { estimateTokens } from "../../conversations/tokens";
import { AIError } from "../errors";
import type { AIEmbeddingProvider, AIEmbeddingRequest, AIEmbeddingResponse, AIProvider, AITextRequest, AITextResponse, AIUsage } from "../types";
import { captureUsageContext } from "./context";
import { estimateCost, type AIPricing } from "./pricing";
import { writeUsageRecord, usageRecordSchema, type UsageRecordInput } from "./records";
import type { AIOperation } from "./types";

const token = z.number().int().nonnegative().max(2_147_483_647);
const usageSchema = z.object({ inputTokens: token, outputTokens: token, totalTokens: token, cachedInputTokens: token.optional(), reasoningTokens: token.optional() });
export type UsageTrackingOptions = {
  provider: string; chatModel?: string; embeddingModel: string;
  write?: (record: UsageRecordInput) => Promise<void>;
  clock?: () => number;
  pricing?: AIPricing;
};
let warnedUnowned = false;
const missingPrices = new Set<string>();
function attempt(request: AITextRequest | AIEmbeddingRequest, operation: AIOperation, options: UsageTrackingOptions) {
  const context = captureUsageContext(request.usageContext);
  const clock = options.clock ?? (() => performance.now());
  const started = clock(), id = randomUUID(), createdAt = new Date();
  let done = false;
  return async (response?: AITextResponse | AIEmbeddingResponse, error?: unknown, outputEstimate = 0) => {
    if (done) return;
    done = true;
    const latencyMs = Math.max(0, Math.round(clock() - started));
    try {
      if (!context.userId) {
        if (!warnedUnowned) { warnedUnowned = true; console.warn("AI usage not persisted", { code: "MISSING_USAGE_OWNER" }); }
        return;
      }
      const reported = usageSchema.safeParse(response?.usage ?? (error instanceof AIError ? error.usage : undefined));
      let usage: AIUsage | undefined = reported.success ? reported.data : undefined;
      let usageSource: UsageRecordInput["usageSource"] = usage ? "provider" : "unavailable";
      // No invented charges on failed requests with unknown usage. A successful
      // request without metadata uses the existing multilingual estimator.
      if (!usage && !error) {
        const inputTokens = "input" in request ? estimateTokens(request.input) : request.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 3);
        const outputTokens = response && "text" in response ? estimateTokens(response.text) : outputEstimate;
        usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        usageSource = "estimated";
      }
      const model = response?.model ?? (error instanceof AIError ? error.model : undefined) ?? request.model ?? (operation === "embedding" ? options.embeddingModel : options.chatModel) ?? "unknown";
      const cost = estimateCost(options.provider, model, usage, options.pricing);
      const priceKey = `${options.provider}:${model}`;
      if (usage && cost.estimatedCostUsd === null && !missingPrices.has(priceKey)) {
        if (missingPrices.size >= 200) missingPrices.clear();
        missingPrices.add(priceKey);
        console.warn("AI usage pricing unavailable", { code: "MISSING_MODEL_PRICING" });
      }
      const record = usageRecordSchema.parse({
        ...context, id, createdAt, provider: options.provider, model,
        // Embedding analysis always stays separate, even inside routing/summary scopes.
        operationType: operation === "embedding" ? "embedding" : context.operationType ?? operation,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, totalTokens: usage?.totalTokens ?? null,
        ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(operation === "embedding" ? { batchSize: 1 } : {}),
        ...cost, usageSource, latencyMs, success: !error,
        ...(error ? { errorCode: error instanceof AIError ? error.code : "PROVIDER_FAILURE" } : {}),
      });
      await (options.write ?? writeUsageRecord)(record);
    } catch {
      // Do not log the exception: DB/provider errors may echo private input.
      console.error("AI usage persistence failed", { code: "USAGE_WRITE_FAILED", attemptId: id });
    }
  };
}

export function trackEmbeddingProvider(provider: AIEmbeddingProvider, options: UsageTrackingOptions): AIEmbeddingProvider {
  return {
    async generateEmbedding(request) {
      const finish = attempt(request, "embedding", options);
      try {
        const response = await provider.generateEmbedding(request);
        await finish(response);
        return response;
      } catch (error) { await finish(undefined, error); throw error; }
    },
  };
}

/** Wrap exactly once at construction. SDK automatic retries must be disabled;
 * application retries invoke this boundary again and receive distinct IDs. */
export function trackAIProvider(provider: AIProvider, options: UsageTrackingOptions): AIProvider {
  return {
    ...trackEmbeddingProvider(provider, options),
    async generateText(request) {
      const finish = attempt(request, "text-generation", options);
      try { const response = await provider.generateText(request); await finish(response); return response; }
      catch (error) { await finish(undefined, error); throw error; }
    },
    async generateStructuredOutput(request) {
      const finish = attempt(request, "structured-output", options);
      try { const response = await provider.generateStructuredOutput(request); await finish(response); return response; }
      catch (error) { await finish(undefined, error); throw error; }
    },
    // Capture metadata at invocation, not at a later consumer's first next().
    streamText(request) {
      const captured = { ...request, usageContext: captureUsageContext(request.usageContext) };
      return (async function* () {
        const finish = attempt(captured, "streaming", options);
        let completed = false;
        try {
          for await (const event of provider.streamText(captured)) {
            if (event.type === "complete") {
              completed = true;
              await finish(event.response);
            }
            yield event;
          }
          if (!completed) await finish(undefined, new AIError("INVALID_RESPONSE"));
        } catch (error) { await finish(undefined, error); throw error; }
        finally { if (!completed) await finish(undefined, new AIError("CANCELLED")); }
      })();
    },
  };
}
