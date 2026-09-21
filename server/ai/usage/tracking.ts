import { getModelCatalog } from "../routing/catalog";
import { aiAllowances, type AIAllowanceService } from "../../entitlements/usage";
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { estimateTokens } from "../../conversations/tokens";
import { abortable, classifyFailure } from "../reliability/failures";
import { AIError } from "../errors";
import { AI_DEFAULTS } from "../config";
import type { AIEmbeddingProvider, AIEmbeddingRequest, AIEmbeddingResponse, AIProvider, AITextRequest, AITextResponse, AIUsage, AIStreamEvent } from "../types";
import { captureUsageContext } from "./context";
import { estimateCost, type AIPricing } from "./pricing";
import { writeUsageRecord, usageRecordSchema, type UsageRecordInput } from "./records";
import type { AIOperation } from "./types";
import { guardrails, type GuardrailService } from "../guardrails/service";
import { guardKey } from "../guardrails/store";

const token = z.number().int().nonnegative().max(2_147_483_647);
const usageSchema = z.object({ inputTokens: token, outputTokens: token, totalTokens: token, cachedInputTokens: token.optional(), reasoningTokens: token.optional() });
export type UsageTrackingOptions = {
  provider: string; chatModel?: string; embeddingModel: string;
  maxOutputTokens?: number;
  write?: (record: UsageRecordInput) => Promise<void>;
  clock?: () => number;
  pricing?: AIPricing;
  guards?: GuardrailService;
  allowances?: AIAllowanceService;
};
const tracked = new WeakSet<object>();
export const isTrackedProvider = (provider: object) => tracked.has(provider);
export function markTrackedProvider<T extends object>(provider: T): T { tracked.add(provider); return provider; }
let warnedUnowned = false;
const missingPrices = new Set<string>();
async function attempt(request: AITextRequest | AIEmbeddingRequest, operation: AIOperation, options: UsageTrackingOptions) {
  const context = captureUsageContext(request.usageContext);
  if (operation !== "embedding") context.selectedTier ??= getModelCatalog().find(model => model.provider === options.provider && model.model === (request.model ?? options.chatModel))?.tiers.at(-1) ?? "REASONING";
  if (request.signal?.aborted) throw new AIError("CANCELLED");
  const inputEstimate = "input" in request ? estimateTokens(request.input) : Math.max(context.guardInputTokens ?? 0, request.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 4));
  const id = randomUUID();
  const allowance = await (options.allowances ?? aiAllowances).reserve(context, inputEstimate + ("messages" in request ? request.maxOutputTokens ?? options.maxOutputTokens ?? AI_DEFAULTS.maxOutputTokens : 0), id);
  const guard = await (options.guards ?? guardrails).reserve({ context: { ...context, operationType: operation === "embedding" ? "embedding" : context.operationType ?? operation },
    provider: options.provider, model: request.model ?? (operation === "embedding" ? options.embeddingModel : options.chatModel) ?? "unknown",
    inputTokens: inputEstimate, outputTokens: "messages" in request ? request.maxOutputTokens ?? options.maxOutputTokens ?? AI_DEFAULTS.maxOutputTokens : 0, embedding: operation === "embedding",
    fingerprint: guardKey(context.agentId, context.workflowStepId, context.operationType ?? operation, "input" in request ? request.input : JSON.stringify(request.messages)) }).catch(async error => { await allowance.release(); throw error; });
  const clock = options.clock ?? (() => performance.now());
  const started = clock(), createdAt = new Date();
  let done = false;
  const finish = async (response?: AITextResponse | AIEmbeddingResponse, error?: unknown, outputEstimate = 0) => {
    if (done) return;
    done = true;
    const latencyMs = Math.max(0, Math.round(clock() - started));
    try {
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
      await guard.finish(usage, cost.estimatedCostUsd);
      if (!context.userId) {
        if (!warnedUnowned) { warnedUnowned = true; console.warn("AI usage not persisted", { code: "MISSING_USAGE_OWNER" }); }
        return;
      }
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
        ...(!error ? { finalProvider: options.provider } : { failureClass: classifyFailure(error)?.kind }),
        ...(operation === "streaming" ? { streamStarted: outputEstimate > 0, tokensEmitted: outputEstimate } : {}),
        ...(error ? { errorCode: error instanceof AIError ? error.code : "PROVIDER_FAILURE" } : {}),
      });
      await (options.write ?? writeUsageRecord)(record);
      // Release only after durable usage. Unknown provider charges retain a bounded
      // reservation until period end instead of granting unaccounted free usage.
      if (usage) await allowance.release();
    } catch {
      // Do not log the exception: DB/provider errors may echo private input.
      console.error("AI usage persistence failed", { code: "USAGE_WRITE_FAILED", attemptId: id });
    } finally {
      await guard.finish();
    }
  };
  return Object.assign(finish, { signal: request.signal ? AbortSignal.any([request.signal, guard.signal]) : guard.signal,
    failure: (error: unknown) => guard.signal.aborted ? new AIError("AI_REQUEST_BUDGET_EXCEEDED", error instanceof AIError ? error.usage : undefined, error instanceof AIError ? error.model : undefined) : request.signal?.aborted && request.signal.reason instanceof AIError ? request.signal.reason : error });
}

export function trackEmbeddingProvider(provider: AIEmbeddingProvider, options: UsageTrackingOptions): AIEmbeddingProvider {
  if (isTrackedProvider(provider)) return provider;
  return markTrackedProvider({
    async generateEmbedding(request) {
      const finish = await attempt(request, "embedding", options);
      try {
        const response = await abortable(provider.generateEmbedding({ ...request, signal: finish.signal }), finish.signal);
        if (!response.vector.length || request.dimensions !== undefined && response.vector.length !== request.dimensions
          || response.vector.some(v => !Number.isFinite(v)) || Math.hypot(...response.vector) < 1e-8) throw new AIError("INVALID_RESPONSE", response.usage, response.model);
        await finish(response);
        return response;
      } catch (error) { const failure = finish.failure(error); await finish(undefined, failure); throw failure; }
    },
  });
}

/** Wrap exactly once at construction. SDK automatic retries must be disabled;
 * application retries invoke this boundary again and receive distinct IDs. */
export function trackAIProvider(provider: AIProvider, options: UsageTrackingOptions): AIProvider {
  if (isTrackedProvider(provider)) return provider;
  return markTrackedProvider({
    ...trackEmbeddingProvider(provider, options),
    async generateText(request) {
      const finish = await attempt(request, "text-generation", options);
      try { const response = await abortable(provider.generateText({ ...request, signal: finish.signal }), finish.signal); await finish(response); return response; }
      catch (error) { const failure = finish.failure(error); await finish(undefined, failure); throw failure; }
    },
    async generateStructuredOutput(request) {
      const finish = await attempt(request, "structured-output", options);
      try { const response = await abortable(provider.generateStructuredOutput({ ...request, signal: finish.signal }), finish.signal);
        const parsed = await request.schema.safeParseAsync(response.data);
        if (!parsed.success) throw new AIError("INVALID_RESPONSE", response.usage, response.model);
        await finish(response); return { ...response, data: parsed.data }; }
      catch (error) { const failure = finish.failure(error); await finish(undefined, failure); throw failure; }
    },
    // Capture metadata at invocation, not at a later consumer's first next().
    streamText(request) {
      const captured = { ...request, usageContext: captureUsageContext(request.usageContext) };
      return (async function* () {
        const finish = await attempt(captured, "streaming", options);
        let completed = false, text = "";
        let iterator: AsyncIterator<AIStreamEvent> | undefined;
        try {
          iterator = provider.streamText({ ...captured, signal: finish.signal })[Symbol.asyncIterator]();
          while (true) {
            const item = await abortable(iterator.next(), finish.signal);
            if (item.done) break;
            const event = item.value;
            if (event.type === "text-delta") text += event.text;
            if (event.type === "complete") {
              completed = true;
              await finish(event.response, undefined, estimateTokens(text));
            }
            yield event;
          }
          if (!completed) throw new AIError("INVALID_RESPONSE");
        } catch (error) { const failure = finish.failure(error); await finish(undefined, failure, estimateTokens(text)); throw failure; }
        finally {
          if (!completed) await finish(undefined, new AIError("CANCELLED"), estimateTokens(text));
          if (!finish.signal.aborted) await iterator?.return?.().catch(() => {});
          else void iterator?.return?.().catch(() => {});
        }
      })();
    },
  });
}
