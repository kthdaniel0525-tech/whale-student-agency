import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { AIError } from "../errors";
import type { AIUsageContext } from "../usage/types";
import type { ModelReference } from "../routing/types";
import { captureUsageContext } from "../usage/context";
import { estimateTokens } from "../../conversations/tokens";
import { getReliabilityConfig, type ReliabilityConfig } from "./config";
import { providerHealth, type ProviderHealthService } from "./health";
import { canFallback, canRetrySame, classifyFailure, normalizedFailure, type FailureInfo } from "./failures";

export type ReliabilityCandidate = ModelReference & { contextWindow?: number; reasoningEffort?: string };
export type AttemptContext = { signal: AbortSignal; timeoutMs: number; usageContext: AIUsageContext };
export type ReliabilityOptions = { health?: ProviderHealthService; config?: () => ReliabilityConfig };
/** One sequential execution loop for chat, streaming, structured data and vectors.
 * Each invocation calls the existing tracked boundary and consumes its budget. */
export async function* executeReliable<T, C extends ReliabilityCandidate>(input: {
  candidates: C[]; primary?: ModelReference; initialDepth?: number; signal?: AbortSignal; usageContext?: AIUsageContext;
  operation: "text" | "structured" | "streaming" | "embedding"; reasoning?: boolean;
  invoke: (candidate: C, context: AttemptContext) => AsyncIterable<T>;
  content?: (value: T) => string;
  isFinal?: (value: T) => boolean;
}, options: ReliabilityOptions = {}): AsyncGenerator<T> {
  const config = (options.config ?? getReliabilityConfig)(), health = options.health ?? providerHealth;
  const context = captureUsageContext(input.usageContext), background = !!context.backgroundJobId || context.source === "rag-document" || context.guardProfile === "BACKGROUND";
  const profile = background ? config.background : config.interactive;
  const timeoutFor = (candidate: C) => ["routing", "semantic-classification"].includes(context.operationType ?? "") ? config.timeouts.routing
    : input.operation === "embedding" ? config.timeouts.embedding : background ? config.timeouts.background
    : (candidate.reasoningEffort ? candidate.reasoningEffort !== "none" : input.reasoning) ? config.timeouts.reasoning : input.operation === "structured" ? config.timeouts.structured : config.timeouts.text;
  const primary = input.primary ?? input.candidates[0];
  let attempts = 0, previous: C | undefined, failure: FailureInfo | undefined;
  const retries = new Map<string, number>();
  let index = 0;
  while (index < input.candidates.length && attempts < profile.maxAttempts) {
    if (input.signal?.aborted) throw new AIError("CANCELLED");
    const candidate = input.candidates[index];
    if (failure && previous && (failure.kind === "authentication" && candidate.provider === previous.provider
      || failure.kind === "rate-limit" && failure.scope === "provider" && candidate.provider === previous.provider
      || failure.kind === "context-too-large" && (candidate.contextWindow ?? 0) <= (previous.contextWindow ?? 0))) { index++; continue; }
    const timeoutMs = timeoutFor(candidate);
    let lease: Awaited<ReturnType<ProviderHealthService["claim"]>>;
    try { lease = await health.claim(candidate, timeoutMs, context); }
    catch (error) { if (!(error instanceof AIError) || error.code !== "AI_SERVICE_TEMPORARILY_UNAVAILABLE") throw error; index++; continue; }
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new AIError("TIMEOUT")), timeoutMs);
    const started = performance.now();
    attempts++;
    const depth = index + (input.initialDepth ?? 0);
    const usageContext: AIUsageContext = { ...context, primaryProvider: primary.provider, primaryModel: primary.model,
      selectedModel: candidate.model, attemptNumber: attempts, fallbackDepth: depth, fallbackUsed: depth > 0,
      ...(previous || depth > 0 ? { fallbackFromProvider: previous?.provider ?? primary.provider, fallbackFromModel: previous?.model ?? primary.model } : {}) };
    let text = "", finished = false;
    try {
      for await (const value of input.invoke(candidate, { signal, timeoutMs, usageContext })) {
        text += input.content?.(value) ?? "";
        const final = !input.content || input.isFinal?.(value);
        if (final) { finished = true; await lease.finish("success", performance.now() - started); }
        yield value;
        if (final) return;
      }
      finished = true;
      await lease.finish("success", performance.now() - started);
      return;
    } catch (error) {
      const safe = normalizedFailure(signal.aborted && signal.reason instanceof AIError ? signal.reason : error);
      failure = classifyFailure(safe);
      finished = true;
      await lease.finish(failure ?? "neutral", performance.now() - started);
      if (safe.code === "CANCELLED") throw safe;
      if (text) throw new AIError("AI_STREAM_INTERRUPTED", safe.usage, safe.model, { kind: failure?.kind ?? "unknown", streamStarted: true, tokensEmitted: estimateTokens(text) });
      if (failure?.kind === "unknown") throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
      if (!failure || !canFallback(failure)) throw safe;
      previous = candidate;
      // Prefer a healthy equivalent immediately; retry once only when none exists.
      const remaining = input.candidates.slice(index + 1).filter(c => !(failure!.kind === "authentication" && c.provider === candidate.provider)
        && !(failure!.kind === "rate-limit" && failure!.scope === "provider" && c.provider === candidate.provider)
        && !(failure!.kind === "context-too-large" && (c.contextWindow ?? 0) <= (candidate.contextWindow ?? 0)));
      const states = remaining.length ? await health.list(remaining) : [];
      const available = remaining.some(c => states.filter(h => h.providerId === c.provider && (!h.model || h.model === c.model)).every(h => h.selectable));
      const key = JSON.stringify([candidate.provider, candidate.model]);
      if (!available && canRetrySame(failure) && (retries.get(key) ?? 0) < profile.maxSameModelRetries && attempts < profile.maxAttempts) {
        retries.set(key, (retries.get(key) ?? 0) + 1);
        clearTimeout(timer);
        if (profile.retryDelayMs) {
          try { await delay(profile.retryDelayMs, undefined, { signal: input.signal }); }
          catch { throw new AIError("CANCELLED"); }
        }
      } else index++;
    } finally {
      clearTimeout(timer);
      controller.abort(new AIError("CANCELLED"));
      if (!finished) await lease.finish("neutral", performance.now() - started);
    }
  }
  throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
}
export async function oneResult<T>(iterable: AsyncIterable<T>): Promise<T> {
  let result: T | undefined;
  for await (const value of iterable) result = value;
  if (result === undefined) throw new AIError("INVALID_RESPONSE");
  return result;
}
