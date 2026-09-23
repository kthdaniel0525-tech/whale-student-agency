import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AIProvider,
  AIStructuredRequest,
  AIStructuredResponse,
  AIUsage,
} from "../ai/types";

type MutableRequestMetrics = {
  aiCalls: number;
  ragCalls: number;
  contextCharacters: number;
  contextEstimatedTokens: number;
  usage: AIUsage;
};

export type RequestExecutionMetrics = {
  dispatchDurationMs: number;
  executionDurationMs: number;
  totalDurationMs: number;
  aiCalls: number;
  ragCalls: number;
  contextCharacters: number;
  contextEstimatedTokens: number;
  workflowSteps: number;
  success: boolean;
  usage?: AIUsage;
};

const requestMetrics = new AsyncLocalStorage<MutableRequestMetrics>();

export async function withRequestMetrics<T>(
  run: (metrics: MutableRequestMetrics) => Promise<T>,
) {
  const metrics: MutableRequestMetrics = {
    aiCalls: 0,
    ragCalls: 0,
    contextCharacters: 0,
    contextEstimatedTokens: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const value = await requestMetrics.run(metrics, () => run(metrics));
  return { value, metrics };
}

export function recordRagCall() {
  const metrics = requestMetrics.getStore();
  if (metrics) metrics.ragCalls += 1;
}

export function recordContextSize(characters: number, estimatedTokens: number) {
  const metrics = requestMetrics.getStore();
  if (!metrics) return;
  metrics.contextCharacters += characters;
  metrics.contextEstimatedTokens += estimatedTokens;
}

function recordAIUsage(usage: AIUsage | undefined) {
  if (!usage) return;
  const metrics = requestMetrics.getStore();
  if (!metrics) return;
  metrics.usage.inputTokens += usage.inputTokens;
  metrics.usage.outputTokens += usage.outputTokens;
  metrics.usage.totalTokens += usage.totalTokens;
}

function recordAICall() {
  const metrics = requestMetrics.getStore();
  if (metrics) metrics.aiCalls += 1;
}

/** One request-local provider wrapper counts calls and usage without retaining
 * prompts, responses, credentials, or state across concurrent requests. */
function instrumentProvider(provider: AIProvider): AIProvider {
  return {
    async generateText(request) {
      recordAICall();
      const response = await provider.generateText(request);
      recordAIUsage(response.usage);
      return response;
    },
    async generateStructuredOutput<T>(
      request: AIStructuredRequest<T>,
    ): Promise<AIStructuredResponse<T>> {
      recordAICall();
      const response = await provider.generateStructuredOutput(request);
      recordAIUsage(response.usage);
      return response;
    },
    async *streamText(request) {
      recordAICall();
      for await (const event of provider.streamText(request)) {
        if (event.type === "complete") recordAIUsage(event.response.usage);
        yield event;
      }
    },
    async generateEmbedding(request) {
      recordAICall();
      return provider.generateEmbedding(request);
    },
  };
}

/** Reuse one provider instance within a request while keeping metrics isolated. */
export function instrumentProviderFactory(
  factory: () => AIProvider | Promise<AIProvider>,
) {
  let provider: Promise<AIProvider> | undefined;
  return () =>
    (provider ??= Promise.resolve(factory()).then(instrumentProvider));
}

export function requestMetricsSnapshot(
  metrics: MutableRequestMetrics,
  values: Omit<
    RequestExecutionMetrics,
    | "aiCalls"
    | "ragCalls"
    | "contextCharacters"
    | "contextEstimatedTokens"
    | "usage"
  >,
): RequestExecutionMetrics {
  const hasUsage = metrics.usage.totalTokens > 0;
  return {
    ...values,
    aiCalls: metrics.aiCalls,
    ragCalls: metrics.ragCalls,
    contextCharacters: metrics.contextCharacters,
    contextEstimatedTokens: metrics.contextEstimatedTokens,
    ...(hasUsage ? { usage: { ...metrics.usage } } : {}),
  };
}
